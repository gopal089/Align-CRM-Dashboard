import { useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRecordPermissions,
  retentionMessage,
  assertExportAllowed,
} from "../lib/billing";
import {
  ArrowLeft,
  ArrowUpRight,
  Plus,
  Pencil,
  Printer,
  Copy,
  Check,
  Archive,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import type { Entity, Row } from "../lib/model";
import { entities, titleCase } from "../lib/model";
import { useAuth } from "../lib/auth";
import { useRecord } from "../lib/data";
import { supabase } from "../lib/client";
import { money, date } from "../lib/utils";
import {
  Badge,
  Confirm,
  Empty,
  ErrorMessage,
  Loading,
  Menu,
  PageTitle,
  Section,
  Logo,
} from "./ui";
import { Cell, RecordTable } from "./RecordList";
import RecordForm from "./RecordForm";
function Related({
  table,
  foreignKey,
  id,
}: {
  table: string;
  foreignKey: string;
  id: string;
}) {
  const { org } = useAuth();
  const entity = Object.values(entities).find((e) => e.table === table)!;
  const q = useQuery({
    queryKey: ["related", table, org!.id, foreignKey, id],
    queryFn: async () => {
      const { data, error, count } = await supabase
        .from(table)
        .select("*", { count: "exact" })
        .eq("org_id", org!.id)
        .eq(foreignKey, id)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return { rows: data as Row[], count: count || 0 };
    },
  });
  const filter = `${foreignKey}=${id}`;
  return (
    <Section
      title={entity.title}
      description={
        q.data?.count ? `${q.data.count} related records` : undefined
      }
      action={
        <Link className="text-link" to={`/${entity.key}?${filter}&new=1`}>
          <Plus size={14} />
          Add {entity.singular}
        </Link>
      }
    >
      {q.isLoading ? (
        <Loading rows={2} />
      ) : q.error ? (
        <ErrorMessage error={(q.error as Error).message} />
      ) : q.data?.rows.length ? (
        <>
          <RecordTable entity={entity} rows={q.data.rows} />
          {q.data.count > 10 && (
            <Link className="view-all" to={`/${entity.key}?${filter}`}>
              View all {q.data.count} records
              <ArrowUpRight size={14} />
            </Link>
          )}
        </>
      ) : (
        <Empty
          compact
          title={`No related ${entity.title.toLowerCase()}`}
          description="Related records appear here when you add them."
        />
      )}
    </Section>
  );
}
export default function RecordDetail({ entity }: { entity: Entity }) {
  const { id } = useParams();
  const { org, role, session, members } = useAuth();
  const { data: record, isLoading, error } = useRecord(entity, id);
  const permissions = useRecordPermissions(entity.table, id ? [id] : []);
  const preserved = !!(id && permissions.data?.[id]?.preserved);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "convert" | null>(null);
  const [preview, setPreview] = useState(false);
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const isPitch = entity.table === "pitches";
  const isTemplate = entity.table === "pitch_templates";
  const sections = useQuery({
    queryKey: ["sections", id],
    enabled: isPitch,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pitch_sections")
        .select("*")
        .eq("pitch_id", id!)
        .eq("org_id", org!.id)
        .order("position");
      if (error) throw error;
      return data;
    },
  });
  const partyTable = record?.company_id
    ? "companies"
    : record?.contact_id
      ? "contacts"
      : "leads";
  const partyId = record?.company_id || record?.contact_id || record?.lead_id;
  const customer = useQuery({
    queryKey: ["option", partyTable, org!.id, partyId],
    enabled: isPitch && !!partyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from(partyTable)
        .select("id,name")
        .eq("org_id", org!.id)
        .eq("id", partyId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const history = useQuery({
    queryKey: ["history", entity.table, id],
    enabled: isPitch || entity.table === "deals",
    queryFn: async () => {
      const { data, error } = await supabase
        .from(isPitch ? "pitch_status_history" : "deal_stage_history")
        .select("*")
        .eq(isPitch ? "pitch_id" : "deal_id", id!)
        .eq("org_id", org!.id)
        .order("changed_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });
  const canEdit =
    role !== "Sales Representative" || record?.owner_id === session!.user.id;
  const fk =
    entity.table === "companies"
      ? "company_id"
      : entity.table === "contacts"
        ? "contact_id"
        : entity.table === "leads"
          ? "lead_id"
          : entity.table === "deals"
            ? "deal_id"
            : isPitch
              ? "pitch_id"
              : "";
  async function update(payload: Record<string, any>) {
    if (preserved) throw new Error(retentionMessage);
    const { error } = await supabase
      .from(entity.table)
      .update(payload)
      .eq("org_id", org!.id)
      .eq("id", id!)
      .select("id")
      .single();
    if (error) throw error;
    await cache.invalidateQueries();
  }
  async function archive() {
    try {
      await update({
        archived_at: record!.archived_at ? null : new Date().toISOString(),
      });
      toast.success(
        record!.archived_at ? "Record restored" : "Record archived",
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function duplicate() {
    try {
      if (isPitch) {
        if (sections.isLoading || sections.error)
          throw new Error(
            "Wait for proposal sections to load before duplicating.",
          );
        const { data, error } = await supabase.rpc("save_pitch", {
          payload: {
            ...record,
            name: `${record!.name} (copy)`,
            owner_id: session!.user.id,
            status: "Draft",
            deal_id: null,
          },
          sections: sections.data || [],
          record_id: null,
        });
        if (error) throw error;
        await cache.invalidateQueries();
        navigate(`/pitch-desk/${data}`);
      } else if (isTemplate) {
        const {
          id: _id,
          created_at: _created,
          updated_at: _updated,
          archived_at: _archived,
          ...body
        } = record!;
        const { data, error } = await supabase
          .from("pitch_templates")
          .insert({
            ...body,
            name: `${record!.name} (copy)`,
            owner_id: session!.user.id,
          })
          .select("id")
          .single();
        if (error) throw error;
        await cache.invalidateQueries();
        navigate(`/templates/${data.id}`);
      }
      toast.success("Copy created");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function toDeal() {
    try {
      const { data, error } = await supabase.rpc("pitch_to_deal", {
        pitch: id,
      });
      if (error) throw error;
      await cache.invalidateQueries();
      navigate(`/deals/${data}`);
      toast.success(
        record!.deal_id ? "Opened existing deal" : "Created related deal",
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  if (isLoading) return <Loading />;
  if (error) return <ErrorMessage error={(error as Error).message} />;
  if (!record)
    return (
      <Empty
        title="Record unavailable"
        description="It may have been deleted, or you may not have access to this workspace."
        link={`/${entity.key}`}
      />
    );
  const tabs = [
    "Overview",
    ...(fk ? ["Activities", "Tasks"] : []),
    ...(["leads", "contacts", "companies"].includes(entity.table)
      ? ["Deals"]
      : []),
    ...(entity.table === "companies" ? ["Contacts"] : []),
    ...(isPitch || entity.table === "deals" ? ["History"] : []),
    ...(entity.table === "deals" && org!.payment_tracking ? ["Payments"] : []),
  ];
  const tab = params.get("tab") || "Overview";
  const details = entity.fields.filter(
    (f) => f.type !== "textarea" && f.key !== "name",
  );
  const substitutions: Record<string, string> = {
    customer: customer.data?.name || "[Customer name]",
    solution: record.solution || "",
    pricing: record.pricing || money(record.amount || 0, org!.currency),
    terms: record.terms || "",
  };
  const renderText = (text: string) =>
    String(text || "").replace(
      /\{\{(customer|solution|pricing|terms)\}\}/g,
      (_, k) => substitutions[k],
    );
  return (
    <>
      <Link className="back-link" to={location.state?.back || `/${entity.key}`}>
        <ArrowLeft size={15} />
        Back to {entity.title.toLowerCase()}
      </Link>
      <PageTitle
        title={record.name}
        description={`${entity.singular[0].toUpperCase() + entity.singular.slice(1)} · Created ${date(record.created_at, org!.timezone)}`}
      >
        <div className="record-header-badges">
          {record.archived_at && <Badge value="Archived" />}
          {(record.status || record.stage) && (
            <Badge value={record.status || record.stage} />
          )}
        </div>
        {canEdit && (
          <button
            className="button"
            onClick={() =>
              preserved ? toast.error(retentionMessage) : setEditing(true)
            }
          >
            <Pencil size={15} />
            Edit {entity.singular}
          </button>
        )}
        <Menu
          items={[
            {
              label: record.archived_at ? "Restore record" : "Archive record",
              action: archive,
              disabled: !canEdit,
            },
            ...(isPitch || isTemplate
              ? [
                  {
                    label: "Duplicate",
                    action: duplicate,
                    disabled: sections.isLoading,
                  },
                ]
              : []),
            {
              label: "Delete permanently",
              action: () => setConfirm("delete"),
              danger: true,
              disabled: role === "Sales Representative",
            },
          ]}
        />
      </PageTitle>
      {preserved && (
        <div className="notice billing-warning">
          <div>
            <strong>Preserved record · view only</strong>
            <p>
              {retentionMessage} Scheduled deletion:{" "}
              {permissions.data?.[id!]?.delete_at
                ? new Date(permissions.data[id!].delete_at!).toLocaleString(
                    undefined,
                    { timeZone: org!.timezone },
                  )
                : "after the retention period"}
              . <Link to="/settings?tab=billing">View your plan</Link>
            </p>
          </div>
        </div>
      )}
      {record.archived_at && (
        <div className="notice">
          <Archive size={17} />
          This record is archived and excluded from dashboard metrics.
          <button className="text-link" onClick={archive} disabled={!canEdit}>
            <RotateCcw size={14} />
            Restore
          </button>
        </div>
      )}
      {entity.table === "leads" &&
        record.status === "Qualified" &&
        !record.archived_at && (
          <div className="action-banner">
            <div>
              <strong>Ready for the next step?</strong>
              <p>
                Convert this lead into a contact and deal. Matching records are
                reused.
              </p>
            </div>
            <button
              className="button primary"
              disabled={!canEdit}
              onClick={() => setConfirm("convert")}
            >
              Convert lead
              <ArrowUpRight size={15} />
            </button>
          </div>
        )}
      {entity.table === "leads" && record.converted_deal_id && (
        <div className="notice">
          <Check size={17} />
          This lead has been converted.
          <Link className="text-link" to={`/deals/${record.converted_deal_id}`}>
            Open deal
            <ArrowUpRight size={14} />
          </Link>
          {record.converted_contact_id && (
            <Link
              className="text-link"
              to={`/contacts/${record.converted_contact_id}`}
            >
              Open contact
            </Link>
          )}
        </div>
      )}
      {isPitch && (
        <div className="pitch-actions">
          <button className="button" onClick={() => setPreview(!preview)}>
            {preview ? "Close preview" : "Preview proposal"}
          </button>
          <button
            className="button"
            onClick={async () => {
              try {
                await assertExportAllowed(org!.id);
                setPreview(true);
                setTimeout(() => window.print(), 200);
              } catch (error) {
                toast.error((error as Error).message);
              }
            }}
          >
            <Printer size={15} />
            Print / Save as PDF
          </button>
          <button
            className="button"
            onClick={duplicate}
            disabled={sections.isLoading || !!sections.error}
          >
            <Copy size={15} />
            Duplicate
          </button>
          {record.status === "Accepted" && (
            <button
              className="button primary"
              disabled={!canEdit}
              onClick={toDeal}
            >
              {record.deal_id ? "Open related deal" : "Create related deal"}
              <ArrowUpRight size={15} />
            </button>
          )}
          <span className="muted">
            Email delivery and view tracking are not configured.
          </span>
        </div>
      )}
      {isPitch && preview ? (
        <article className="proposal print-content">
          <div className="proposal-header">
            <Logo />
            <div>
              <strong>{org!.name}</strong>
              <p>{org!.website}</p>
            </div>
          </div>
          <span className="eyebrow">A PROPOSAL FOR WHAT’S NEXT</span>
          <h1>{record.name}</h1>
          <p className="proposal-date">
            Prepared {date(record.created_at, org!.timezone)} ·{" "}
            {members.find((m) => m.user_id === record.owner_id)?.profiles.name}
          </p>
          {["objective", "problem", "solution", "scope", "pricing"]
            .filter((k) => record[k])
            .map((k) => (
              <section key={k}>
                <h2>{titleCase(k)}</h2>
                <p>{record[k]}</p>
              </section>
            ))}
          {sections.error ? (
            <ErrorMessage error={(sections.error as Error).message} />
          ) : (
            sections.data?.map((s: any) => (
              <section key={s.id}>
                <h2>{renderText(s.title)}</h2>
                <p>{renderText(s.content)}</p>
              </section>
            ))
          )}
          <div className="proposal-total">
            <span>Proposed investment</span>
            <strong>{money(record.amount, org!.currency)}</strong>
          </div>
          {record.terms && (
            <section>
              <h2>Terms & next steps</h2>
              <p>{record.terms}</p>
            </section>
          )}
          <footer>
            Prepared by {org!.name} · {org!.currency} · Proposal status:{" "}
            {record.status}
          </footer>
        </article>
      ) : (
        <>
          <div className="page-subnav">
            {tabs.map((t) => (
              <button
                key={t}
                className={tab === t ? "selected" : ""}
                onClick={() => setParams({ tab: t })}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "Overview" ? (
            <div className="detail-grid">
              <div className="detail-main">
                <Section title={`${titleCase(entity.singular)} details`}>
                  <dl className="record-details">
                    {details.map((f) => (
                      <div key={f.key}>
                        <dt>{f.label}</dt>
                        <dd>
                          {f.key === "website" &&
                          /^https?:\/\//.test(record[f.key]) ? (
                            <a
                              href={record[f.key]}
                              target="_blank"
                              rel="noreferrer"
                              className="text-link"
                            >
                              {record[f.key]}
                              <ArrowUpRight size={13} />
                            </a>
                          ) : (
                            <Cell column={f.key} row={record} />
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Section>
                {entity.fields
                  .filter((f) => f.type === "textarea")
                  .map((f) => (
                    <Section key={f.key} title={f.label}>
                      <p className="detail-text">
                        {record[f.key] || "No details added yet."}
                      </p>
                    </Section>
                  ))}
                {isTemplate && (
                  <Section title="Template sections">
                    {(record.sections || []).length ? (
                      record.sections.map((s: any, i: number) => (
                        <div className="detail-text" key={i}>
                          <h3>{s.title}</h3>
                          <p>{s.content}</p>
                        </div>
                      ))
                    ) : (
                      <Empty
                        compact
                        title="No sections yet"
                        description="Edit this template to add reusable proposal sections."
                      />
                    )}
                  </Section>
                )}
              </div>
              <aside className="detail-side">
                <Section title="Record information">
                  <dl className="record-details single">
                    <div>
                      <dt>Created</dt>
                      <dd>{date(record.created_at, org!.timezone, true)}</dd>
                    </div>
                    <div>
                      <dt>Last updated</dt>
                      <dd>{date(record.updated_at, org!.timezone, true)}</dd>
                    </div>
                    <div>
                      <dt>Time zone</dt>
                      <dd>{org!.timezone}</dd>
                    </div>
                    {record.amount !== undefined && (
                      <div>
                        <dt>Currency</dt>
                        <dd>{org!.currency}</dd>
                      </div>
                    )}
                  </dl>
                </Section>
                {fk && (
                  <Section
                    title="Add a note"
                    description="Save context for your team."
                  >
                    <form
                      className="note-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setNoteBusy(true);
                        const { error } = await supabase
                          .from("activities")
                          .insert({
                            org_id: org!.id,
                            owner_id: session!.user.id,
                            name: `Note on ${record.name}`.slice(0, 200),
                            type: "Note",
                            description: note,
                            [fk]: id,
                          });
                        setNoteBusy(false);
                        if (error) toast.error(error.message);
                        else {
                          setNote("");
                          await cache.invalidateQueries();
                          toast.success("Note added");
                        }
                      }}
                    >
                      <textarea
                        aria-label="New note"
                        required
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={4}
                        placeholder="A conversation, a next step, a useful detail…"
                      />
                      <button className="button" disabled={noteBusy}>
                        <Plus size={14} />
                        Save note
                      </button>
                    </form>
                  </Section>
                )}
              </aside>
            </div>
          ) : tab === "History" ? (
            <Section
              title="Status history"
              description="Timestamps are recorded automatically by the database."
            >
              {history.error ? (
                <ErrorMessage error={(history.error as Error).message} />
              ) : history.isLoading ? (
                <Loading rows={3} />
              ) : (
                <div className="history-list">
                  {history.data?.map((h) => (
                    <div key={h.id}>
                      <span className="timeline-dot" />
                      <div>
                        <strong>
                          {h.from_stage || h.from_status || "Created"} →{" "}
                          {h.to_stage || h.to_status}
                        </strong>
                        <small>
                          {date(h.changed_at, org!.timezone, true)} ·{" "}
                          {members.find((m) => m.user_id === h.changed_by)
                            ?.profiles.name || "Team member"}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          ) : (
            <Related
              table={
                tab === "Activities"
                  ? "activities"
                  : tab === "Tasks"
                    ? "tasks"
                    : tab === "Deals"
                      ? "deals"
                      : tab === "Contacts"
                        ? "contacts"
                        : "payments"
              }
              foreignKey={fk}
              id={id!}
            />
          )}
        </>
      )}
      {editing && (
        <RecordForm
          entity={entity}
          record={record}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
      <Confirm
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title={`Delete ${entity.singular}?`}
        description="This permanently removes the record. Related records may prevent deletion; archive it to preserve relationships instead."
        destructive
        onConfirm={async () => {
          const { data, error } = await supabase
            .from(entity.table)
            .delete()
            .eq("id", id!)
            .eq("org_id", org!.id)
            .select("id");
          if (error) throw error;
          if (!data?.length)
            throw new Error("No record was deleted. Check your permissions.");
          await cache.invalidateQueries();
          toast.success("Record deleted");
          navigate(`/${entity.key}`);
        }}
      />
      <Confirm
        open={confirm === "convert"}
        onClose={() => setConfirm(null)}
        title="Convert qualified lead?"
        description="This creates or reuses the company and contact, then creates a deal with an initial value of zero. You can edit the deal amount next. Conversion is atomic and cannot be repeated."
        onConfirm={async () => {
          const { data, error } = await supabase.rpc("convert_lead", {
            lead: id,
            deal_amount: 0,
          });
          if (error) throw error;
          await cache.invalidateQueries();
          toast.success("Lead converted");
          navigate(`/deals/${data}`);
        }}
      />
    </>
  );
}
