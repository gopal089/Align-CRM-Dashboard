import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import { useCustomFields } from "../lib/customization";
import {
  importTargets,
  importLimits,
  inputBatches,
  mappedRows,
  suggestedMapping,
  errorCsvData,
} from "../lib/contactImport";
import type { ImportBook, ImportEntity } from "../lib/contactImport";
import { csv } from "../lib/utils";
import { ErrorMessage, Modal } from "./ui";

type Job = {
  id: string;
  file_name: string;
  state: string;
  headers: string[];
  expected_rows: number;
  duplicate_policy: string;
  expires_at: string;
  confirmation: string;
  file_meta: { sha256: string; mapping: string[]; sheet: string };
};
type ImportRow = {
  row_no: number;
  retry_id: string;
  payload: Record<string, unknown>;
  source: string[];
  action: string | null;
  target_id: string | null;
  error: string;
  result: string | null;
};
type Status = { job: Job; counts: Record<string, number>; rows: ImportRow[] };
// One import screen for contacts and leads; the server runs the same engine
// for both, with record-type specific checks.
export default function ContactImport({
  onClose,
  entity = "contacts",
}: {
  onClose: () => void;
  entity?: ImportEntity;
}) {
  const { org } = useAuth();
  const fields = useCustomFields(entity);
  const targets = importTargets(entity);
  const noun = entity === "leads" ? "lead" : "contact";
  const cache = useQueryClient();
  const [jobs, setJobs] = useState<Job[]>([]),
    [status, setStatus] = useState<Status | null>(null);
  const [book, setBook] = useState<ImportBook | null>(null),
    [sheet, setSheet] = useState(0),
    [mapping, setMapping] = useState<string[]>([]);
  const [fileName, setFileName] = useState(""),
    [hash, setHash] = useState(""),
    [policy, setPolicy] = useState("skip");
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState<unknown>(null),
    [offset, setOffset] = useState(0);
  const stopped = useRef(false),
    worker = useRef<Worker | null>(null);
  const rpc = async (
    operation: string,
    j: string | null = null,
    p: Record<string, unknown> = {},
  ) => {
    const { data, error } = await supabase.rpc(
      entity === "leads" ? "lead_import" : "contact_import",
      {
      o: org!.id,
      operation,
        j,
        p,
      },
    );
    if (error) throw error;
    return data;
  };
  const refreshJobs = async () => setJobs(await rpc("list"));
  useEffect(() => {
    void refreshJobs().catch(setError);
    return () => {
      stopped.current = true;
      worker.current?.terminate();
    };
  }, [org!.id]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    stopped.current = false;
    try {
      await work();
      if (!stopped.current) await refreshJobs();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      void cache.invalidateQueries({ queryKey: ["records", entity] });
      void cache.invalidateQueries({ queryKey: ["summary"] });
    }
  }
  async function load(id: string, page = 0) {
    const result = await rpc("status", id, { offset: page });
    if (!stopped.current) {
      setStatus(result);
      setOffset(page);
    }
    return result as Status;
  }
  async function parse(file: File) {
    await run(async () => {
      if (
        !/\.(csv|xlsx)$/i.test(file.name) ||
        file.size > importLimits.fileBytes
      )
        throw new Error("Choose a .csv or .xlsx file of at most 5 MB.");
      setProgress("Reading file safely…");
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const fingerprint = [...new Uint8Array(digest)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      const parsed = await new Promise<ImportBook>((resolve, reject) => {
        const w = new Worker(
          new URL("../lib/import.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.current = w;
        const timeout = setTimeout(() => {
          w.terminate();
          reject(
            new Error(
              "File parsing exceeded 15 seconds. Split or simplify the workbook.",
            ),
          );
        }, 15000);
        w.onmessage = (e) => {
          clearTimeout(timeout);
          w.terminate();
          e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.book);
        };
        w.onerror = () => {
          clearTimeout(timeout);
          w.terminate();
          reject(new Error("The file could not be parsed safely."));
        };
        w.postMessage({ name: file.name, bytes }, [bytes]);
      });
      if (stopped.current) return;
      if (status?.job.state === "uploading") {
        if (fingerprint !== status.job.file_meta.sha256)
          throw new Error(
            "Resume with the same original file. Cancel this import before using another file.",
          );
        const index = parsed.sheets.findIndex(
          (s) => s.name === status.job.file_meta.sheet,
        );
        if (index < 0) throw new Error("The saved worksheet is missing.");
        setSheet(index);
        setMapping(status.job.file_meta.mapping);
      } else {
        const index = parsed.sheets.findIndex((s) => s.rows.length > 1);
        setSheet(index);
        setMapping(
          suggestedMapping(
            parsed.sheets[index].rows[0],
            fields.data || [],
            targets,
          ),
        );
      }
      setBook(parsed);
      setHash(fingerprint);
      setFileName(file.name);
      setProgress("");
    });
  }
  async function review(id: string) {
    let current = await load(id);
    while (current.job.state === "reviewing" && !stopped.current) {
      setProgress(
        `Checking errors and duplicates: ${current.counts.reviewed} / ${current.job.expected_rows}`,
      );
      current = await rpc("review", id);
      if (!stopped.current) setStatus(current);
    }
    setProgress("");
  }
  async function upload() {
    await run(async () => {
      if (!book || fields.isPending || fields.error)
        throw new Error("Wait for custom fields to load before mapping.");
      const selected = book.sheets[sheet],
        inputs = mappedRows(selected, mapping, fields.data || [], targets),
        batches = inputBatches(inputs);
      let job = status?.job;
      if (!job) {
        job = await rpc("create", null, {
          file_name: fileName,
          headers: selected.rows[0],
          rows: inputs.length,
          policy,
          file_meta: { sha256: hash, mapping, sheet: selected.name },
        });
      }
      if (!job) throw new Error("Import could not be created.");
      const id = job.id;
      for (let i = 0; i < batches.length && !stopped.current; i++) {
        setProgress(`Preparing preview: batch ${i + 1} / ${batches.length}`);
        const result = await rpc("append", id, { rows: batches[i] });
        if (!stopped.current) setStatus(result);
      }
      if (stopped.current) return;
      await rpc("seal", id);
      await review(id);
      setBook(null);
    });
  }
  async function commit(id: string) {
    while (!stopped.current) {
      const next: Status = await rpc("status", id, { filter: "pending" });
      if (!next.rows.length) {
        if (!stopped.current) setStatus(await rpc("status", id));
        break;
      }
      setProgress(
        `Importing: ${next.counts.processed} / ${next.job.expected_rows}`,
      );
      // These stable per-row IDs and explicit targets can safely be retried after a lost response.
      const result = await rpc("batch", id, {
        rows: next.rows.map((r) => ({
          retry_id: r.retry_id,
          target_id: r.target_id,
        })),
      });
      if (!stopped.current) setStatus(result);
    }
    setProgress("");
  }
  async function resume(job: Job) {
    await run(async () => {
      setBook(null);
      const value = await load(job.id);
      if (value.job.state === "reviewing") await review(job.id);
      if (value.job.state === "running") await commit(job.id);
    });
  }
  async function confirm() {
    if (!status) return;
    await run(async () => {
      const id = status.job.id;
      await rpc("confirm", id, { confirmation: status.job.confirmation });
      await commit(id);
    });
  }
  async function errorsCsv() {
    if (!status) return;
    await run(async () => {
      const entries: ImportRow[] = [];
      let page = 0;
      while (!stopped.current) {
        const value: Status = await rpc("status", status.job.id, {
          filter: "failed",
          offset: page,
        });
        entries.push(...value.rows);
        if (value.rows.length < 25) break;
        page += 25;
      }
      const data = errorCsvData(status.job.headers, entries);
      csv(data.rows, data.columns, `${noun}-import-errors.csv`, data.labels);
      toast.success(`Downloaded ${entries.length} failed rows`);
    });
  }
  const selected = book?.sheets[sheet];
  return (
    <Modal
      open
      onClose={() => {
        stopped.current = true;
        onClose();
      }}
      title={entity === "leads" ? "Import leads" : "Import contacts"}
      description="Preview your CSV or Excel file before saving. Imports can be paused and resumed for 24 hours."
      wide
    >
      {!!error && (
        <ErrorMessage
          error={
            error instanceof Error
              ? error.message
              : String((error as { message?: string })?.message || error)
          }
        />
      )}
      {progress && (
        <p className="notice" role="status">
          {progress}
        </p>
      )}
      <p className="muted">
        CSV UTF-8 or XLSX · 5 MB · 10,000 rows · 100 columns · 2,000 characters
        per cell. Formulas and macros are rejected.
      </p>
      <p className="muted">
        Source rows, including unmapped columns, are kept privately for
        resumable progress and error reports. Access expires after 24 hours;
        hourly cleanup removes them. Your raw file stays in your browser.
      </p>
      {!status && !!jobs.length && (
        <section className="import-recent">
          <h3>Recent imports</h3>
          {jobs.map((j) => (
            <button
              key={j.id}
              className="button"
              disabled={busy}
              onClick={() => void resume(j)}
            >
              {j.file_name} · {j.state}
            </button>
          ))}
        </section>
      )}
      {(!status || status.job.state === "uploading") && (
        <>
          <label className="field">
            <span>
              {status ? "Resume: choose the original file" : "Choose a file"}
            </span>
            <input
              type="file"
              accept=".csv,.xlsx"
              disabled={busy || fields.isPending}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void parse(f);
                e.target.value = "";
              }}
            />
          </label>
          {selected && (
            <>
              <label className="field">
                <span>Worksheet</span>
                <select
                  value={sheet}
                  disabled={busy || !!status}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    setSheet(i);
                    setMapping(
                      suggestedMapping(
                        book!.sheets[i].rows[0],
                        fields.data || [],
                        targets,
                      ),
                    );
                  }}
                >
                  {book!.sheets.map((s, i) => (
                    <option key={i} value={i} disabled={s.rows.length < 2}>
                      {s.name} ({Math.max(0, s.rows.length - 1)} rows)
                    </option>
                  ))}
                </select>
              </label>
              <h3>Map columns</h3>
              <div className="import-mapping">
                {selected.rows[0].map((header, i) => (
                  <label className="field" key={i}>
                    <span>{header || `Column ${i + 1}`}</span>
                    <select
                      value={mapping[i] || ""}
                      disabled={busy || !!status}
                      onChange={(e) =>
                        setMapping((m) =>
                          m.map((v, n) => (n === i ? e.target.value : v)),
                        )
                      }
                    >
                      <option value="">Do not import</option>
                      {targets.map((t) => (
                        <option key={t} value={t}>
                          {t.replace(/_/g, " ")}
                        </option>
                      ))}
                      {(fields.data || [])
                        .filter((f) => !f.archived_at)
                        .map((f) => (
                          <option key={f.id} value={"cf:" + f.id}>
                            {f.name} (custom)
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
              <label className="field">
                <span>
                  When email or phone matches an existing {noun} or earlier
                  file row
                </span>
                <select
                  value={status?.job.duplicate_policy || policy}
                  disabled={busy || !!status}
                  onChange={(e) => setPolicy(e.target.value)}
                >
                  <option value="skip">Skip</option>
                  <option value="update">Update existing</option>
                </select>
              </label>
              <p className="muted">
                {entity === "leads"
                  ? "New leads belong to you; without a Source column they get Manual (or your first source). Status accepts New, Contacted, Qualified or Lost; converting stays a separate step. Updates keep ownership and empty/unmapped fields. Conflicting matches become errors."
                  : "New contacts belong to you. Updates retain ownership, company links and empty/unmapped fields. Phone country codes are not guessed. Conflicting matches become errors."}
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void upload()}
              >
                Build preview
              </button>
            </>
          )}
        </>
      )}
      {status && (
        <section className="import-results">
          <h3>
            {status.job.file_name} · {status.job.state}
          </h3>
          <p>
            {status.counts.imported || 0} imported ({status.counts.updated || 0}{" "}
            updated) · {status.counts.skipped || 0} skipped ·{" "}
            {status.counts.failed || 0} failed · {status.counts.processed || 0}/
            {status.job.expected_rows} processed
          </p>
          {status.job.state === "ready" && (
            <p className="notice">
              Preview: {status.counts.errors} errors and{" "}
              {status.counts.duplicates} duplicate rows. Errors will be reported
              as failed; valid rows will be committed only after confirmation.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File row</th>
                  <th>Name</th>
                  <th>Action / result</th>
                  <th>Explicit target</th>
                  <th>Issue</th>
                </tr>
              </thead>
              <tbody>
                {status.rows.map((r) => (
                  <tr key={r.retry_id}>
                    <td>{r.row_no}</td>
                    <td>{String(r.payload.name || "—")}</td>
                    <td>{r.result || r.action || "Not reviewed"}</td>
                    <td>
                      <small>{r.target_id || "—"}</small>
                    </td>
                    <td>{r.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="import-actions">
            <button
              className="button"
              disabled={busy || offset === 0}
              onClick={() =>
                void run(async () => {
                  await load(status.job.id, Math.max(0, offset - 25));
                })
              }
            >
              Previous
            </button>
            <button
              className="button"
              disabled={busy || offset + 25 >= status.counts.staged}
              onClick={() =>
                void run(async () => {
                  await load(status.job.id, offset + 25);
                })
              }
            >
              Next
            </button>
            {status.job.state === "ready" && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void confirm()}
              >
                Confirm and import valid rows
              </button>
            )}
            {["reviewing", "running"].includes(status.job.state) && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void resume(status.job)}
              >
                Resume {status.job.state === "reviewing" ? "preview" : "import"}
              </button>
            )}
            {status.counts.failed > 0 && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void errorsCsv()}
              >
                Download error rows
              </button>
            )}
            <button
              className="button danger"
              disabled={busy || status.job.state === "cancelled"}
              onClick={() =>
                void run(async () => {
                  const value = await rpc("cancel", status.job.id);
                  setStatus(value);
                  setBook(null);
                })
              }
            >
              Discard temporary import
            </button>
          </div>
          <p className="muted">
            Temporary data expires{" "}
            {new Date(status.job.expires_at).toLocaleString()}. Discarding
            removes temporary rows; {entity} already saved remain.
          </p>
        </section>
      )}
      <div className="import-actions">
        {busy && (
          <button
            className="button"
            onClick={() => {
              stopped.current = true;
              worker.current?.terminate();
              setProgress("Pausing after the current request…");
            }}
          >
            Pause
          </button>
        )}
        {status && !busy && (
          <button
            className="button"
            onClick={() => {
              setStatus(null);
              setBook(null);
              setOffset(0);
              setError(null);
            }}
          >
            Choose another import
          </button>
        )}
        <button
          className="button"
          onClick={() => {
            stopped.current = true;
            onClose();
          }}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
