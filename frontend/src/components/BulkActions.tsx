import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Download, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import type { Entity, Row } from "../lib/model";
import { csv, today } from "../lib/utils";
import { assertExportAllowed, retentionMessage } from "../lib/billing";
import { customLabel, customValue, type CustomField } from "../lib/customization";
import {
  bulkFields,
  bulkLimit,
  bulkOutcome,
  bulkValues,
  canBulkDelete,
  chunk,
  planBulk,
} from "../lib/bulk";
import { Confirm } from "./ui";

// Shown above the table once rows are ticked. Every action here is also
// guarded by row-level security in the database, so the buttons only mirror
// what the current member is actually allowed to do.
export default function BulkActions({
  entity,
  rows,
  selected,
  onClear,
  columns,
  customFields = [],
}: {
  entity: Entity;
  rows: Row[];
  selected: Set<string>;
  onClear: () => void;
  // The columns currently on screen, so an export of the selection matches
  // what the saved view shows rather than the default column set.
  columns: string[];
  customFields?: CustomField[];
}) {
  const { org, role, members } = useAuth();
  const cache = useQueryClient();
  const [fieldKey, setFieldKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Stages and lead sources live in workspace settings, not in the model.
  const runtime = useMemo(
    () => ({
      stage: (org?.pipeline_stages || []).map((stage) => stage.name),
      source: org?.lead_sources || [],
    }),
    [org],
  );
  const fields = useMemo(() => bulkFields(entity, runtime), [entity, runtime]);
  const field = fields.find((f) => f.key === fieldKey);
  const options = field ? bulkValues(entity, field, runtime, members) : [];
  const plan = planBulk(rows, selected);
  const deletable = canBulkDelete(role);

  async function run(
    label: string,
    apply: (batch: string[]) => PromiseLike<{ data: any; error: any }>,
  ) {
    if (!plan.ids.length) {
      toast.error("Nothing in this selection can be changed.");
      return;
    }
    if (plan.overLimit) {
      toast.error(`Select at most ${bulkLimit} records at a time.`);
      return;
    }
    setBusy(true);
    let done = 0;
    try {
      for (const batch of chunk(plan.ids)) {
        const { data, error } = await apply(batch);
        if (error) throw error;
        done += data?.length || 0;
      }
      await cache.invalidateQueries();
      const outcome = bulkOutcome(label, done, plan.ids.length);
      if (outcome.tone === "success") toast.success(outcome.message);
      else toast.warning(outcome.message);
      if (plan.preserved)
        toast.message(
          `${plan.preserved} preserved ${plan.preserved === 1 ? "record was" : "records were"} left out. ${retentionMessage}`,
        );
      setFieldKey("");
      setValue("");
      onClear();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const update = (patch: Record<string, unknown>, label: string) =>
    run(label, (batch) =>
      supabase
        .from(entity.table)
        .update(patch)
        .eq("org_id", org!.id)
        .in("id", batch)
        .select("id"),
    );

  async function exportSelected() {
    if (!plan.ids.length) {
      toast.error("Nothing in this selection can be exported.");
      return;
    }
    setBusy(true);
    try {
      await assertExportAllowed(org!.id);
      const chosen = rows.filter(
        (row) => selected.has(row.id) && !row.__preserved,
      );
      const named = chosen.map((row) => ({
        ...row,
        ...Object.fromEntries(
          columns
            .filter((c) => c.startsWith("cf:"))
            .map((c) => [c, customValue(row, c)]),
        ),
        owner_id:
          members.find((m) => m.user_id === row.owner_id)?.profiles.name ||
          row.owner_id,
      }));
      csv(
        named,
        ["id", ...columns],
        `${entity.table}-selected-${today(org!.timezone)}.csv`,
        Object.fromEntries(
          columns
            .filter((c) => c.startsWith("cf:"))
            .map((c) => [c, customLabel(c, customFields)]),
        ),
      );
      toast.success(`Exported ${named.length} selected records`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bulk-toolbar">
        <span>
          {plan.ids.length + plan.preserved} selected
          {plan.preserved > 0 && (
            <small className="muted"> · {plan.preserved} preserved</small>
          )}
        </span>
        {fields.length > 0 && (
          <>
            <select
              aria-label="Field to change"
              value={fieldKey}
              onChange={(e) => {
                setFieldKey(e.target.value);
                setValue("");
              }}
            >
              <option value="">Change field…</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            {field && (
              <select
                aria-label={`New ${field.label}`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                <option value="">Choose {field.label.toLowerCase()}…</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            <button
              className="button primary small"
              disabled={!field || !value || busy}
              onClick={() =>
                update(
                  { [field!.key]: value },
                  `Updated ${field!.label.toLowerCase()} on`,
                )
              }
            >
              Apply
            </button>
          </>
        )}
        {plan.active > 0 && (
          <button
            className="button small"
            disabled={busy}
            onClick={() =>
              update({ archived_at: new Date().toISOString() }, "Archived")
            }
          >
            <Archive size={14} />
            Archive
          </button>
        )}
        {plan.archived > 0 && (
          <button
            className="button small"
            disabled={busy}
            onClick={() => update({ archived_at: null }, "Restored")}
          >
            <ArchiveRestore size={14} />
            Restore
          </button>
        )}
        <button className="button small" disabled={busy} onClick={exportSelected}>
          <Download size={14} />
          Export
        </button>
        {deletable && (
          <button
            className="button small danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={14} />
            Delete
          </button>
        )}
        <button
          className="icon-button"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X size={16} />
        </button>
      </div>
      <Confirm
        open={confirming}
        onClose={() => setConfirming(false)}
        destructive
        title={`Delete ${plan.ids.length} ${plan.ids.length === 1 ? entity.singular : entity.title.toLowerCase()}?`}
        description="This permanently removes the selected records and cannot be undone. Records linked to others may refuse to delete; archive those instead."
        confirmWord={String(plan.ids.length)}
        confirmHint={`Type ${plan.ids.length} to confirm`}
        onConfirm={async () => {
          await run("Deleted", (batch) =>
            supabase
              .from(entity.table)
              .delete()
              .eq("org_id", org!.id)
              .in("id", batch)
              .select("id"),
          );
        }}
      />
    </>
  );
}
