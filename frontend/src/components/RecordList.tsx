import { useEffect, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  SlidersHorizontal,
  Download,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  List,
  Columns3,
  ArrowUpRight,
  X,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import type { Entity, Row } from "../lib/model";
import { entities, titleCase } from "../lib/model";
import {
  useRecords,
  exportRecords,
  pageSize,
  listQuery,
  useSummary,
} from "../lib/data";
import {
  csv,
  money,
  date,
  today,
  zonedBoundary,
  addDays,
  calendarDate,
} from "../lib/utils";
import { supabase } from "../lib/client";
import { Badge, Empty, ErrorMessage, Loading, Modal, PageTitle } from "./ui";
import RecordForm from "./RecordForm";
import { useRecordPermissions } from "../lib/billing";
import {
  customLabel,
  customValue,
  supportsCustomization,
  useCustomFields,
  visibleColumns,
} from "../lib/customization";
import SavedViews from "./SavedViews";
export function RelationLink({ table, id }: { table: string; id: string }) {
  const { org } = useAuth();
  const result = useQuery({
    queryKey: ["option", table, org!.id, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(table)
        .select("id,name")
        .eq("id", id)
        .eq("org_id", org!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const entity = Object.values(entities).find((e) => e.table === table);
  return result.error ? (
    <span className="muted">Unavailable</span>
  ) : (
    <Link
      className="table-relation"
      to={`/${entity?.key || table}/${id}`}
      onClick={(e) => e.stopPropagation()}
    >
      {result.data?.name || "…"}
    </Link>
  );
}
export function Cell({ column, row }: { column: string; row: Row }) {
  const { org, members } = useAuth();
  const value = customValue(row, column);
  if (value === null || value === undefined || value === "")
    return <span className="muted">—</span>;
  if (["status", "stage", "priority", "type"].includes(column))
    return <Badge value={value} />;
  if (column === "amount")
    return <span className="money">{money(value, org!.currency)}</span>;
  if (column === "probability") return `${value}%`;
  if (column === "owner_id") {
    const name =
      members.find((m) => m.user_id === value)?.profiles.name || "Team member";
    return (
      <span className="owner-cell">
        <span className="avatar micro">
          {name
            .split(" ")
            .map((x) => x[0])
            .slice(0, 2)
            .join("")}
        </span>
        {name}
      </span>
    );
  }
  if (
    column.endsWith("_at") ||
    column.includes("_date") ||
    column.startsWith("period_")
  )
    return date(value, org!.timezone);
  if (column.endsWith("_id")) {
    const field = Object.values(entities)
      .flatMap((e) => e.fields)
      .find((f) => f.key === column && f.relation);
    return field ? (
      <RelationLink table={field.relation!} id={value} />
    ) : (
      String(value)
    );
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return (
    <span className={column === "name" ? "record-name" : "cell-text"}>
      {String(value)}
      {column === "name" && row.__preserved && (
        <small className="billing-preserved">Preserved · view only</small>
      )}
    </span>
  );
}
export function RecordTable({
  entity,
  rows,
  onSelect,
  selected,
  onToggle,
  onToggleAll,
  sort,
  onSort,
  back,
}: {
  entity: Entity;
  rows: Row[];
  onSelect?: (row: Row) => void;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  sort?: string;
  onSort?: (column: string) => void;
  back?: string;
}) {
  const navigate = useNavigate();
  const { role, session } = useAuth();
  const customFields = useCustomFields(entity.table);
  const eligible = rows.filter(
    (r) => role !== "Sales Representative" || r.owner_id === session!.user.id,
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {onToggleAll && (
              <th className="check-column">
                <input
                  aria-label="Select all on this page"
                  type="checkbox"
                  checked={
                    eligible.length > 0 &&
                    eligible.every((r) => selected?.has(r.id))
                  }
                  onChange={onToggleAll}
                />
              </th>
            )}
            {entity.columns.map((c) => (
              <th key={c}>
                {onSort ? (
                  <button className="sort-button" onClick={() => onSort(c)}>
                    {c.startsWith("cf:")
                      ? customLabel(c, customFields.data || [])
                      : titleCase(c)}
                    <ArrowUpDown
                      size={12}
                      className={sort === c ? "sorted" : ""}
                    />
                  </button>
                ) : c.startsWith("cf:") ? (
                  customLabel(c, customFields.data || [])
                ) : (
                  titleCase(c)
                )}
              </th>
            ))}
            <th className="last-cell" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={selected?.has(row.id) ? "selected-row" : ""}
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("a,button,input,select"))
                  navigate(`/${entity.key}/${row.id}`, { state: { back } });
              }}
            >
              {onToggle && (
                <td className="check-column">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    disabled={
                      role === "Sales Representative" &&
                      row.owner_id !== session!.user.id
                    }
                    checked={selected?.has(row.id) || false}
                    onChange={() => onToggle(row.id)}
                  />
                </td>
              )}
              {entity.columns.map((c, i) => (
                <td key={c}>
                  {i === 0 ? (
                    <Link
                      className="record-title-link"
                      to={`/${entity.key}/${row.id}`}
                      state={{ back }}
                    >
                      {["leads", "contacts", "companies"].includes(
                        entity.key,
                      ) && (
                        <span
                          className={`record-avatar ${entity.key === "companies" ? "square" : ""}`}
                        >
                          {row.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <span>
                        <strong>{row.name}</strong>
                        {["leads", "contacts"].includes(entity.key) &&
                          row.email && <small>{row.email}</small>}
                      </span>
                    </Link>
                  ) : (
                    <Cell column={c} row={row} />
                  )}
                </td>
              ))}
              <td className="last-cell">
                <button
                  className="icon-button row-open"
                  aria-label={`Open ${row.name}`}
                  onClick={() =>
                    onSelect
                      ? onSelect(row)
                      : navigate(`/${entity.key}/${row.id}`, {
                          state: { back },
                        })
                  }
                >
                  <ArrowUpRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function StageColumn({
  stage,
  params,
  onMove,
}: {
  stage: { name: string; outcome: string };
  params: URLSearchParams;
  onMove: (id: string, stage: string) => void;
}) {
  const { org, role, session } = useAuth();
  const [over, setOver] = useState(false);
  const p = new URLSearchParams(params);
  p.set("stage", stage.name);
  p.delete("page");
  const query = useQuery({
    queryKey: ["board", org!.id, p.toString()],
    queryFn: async () => {
      const { data, error, count } = await listQuery(
        entities.deals,
        org!.id,
        p,
        "*",
        true,
        org!.timezone,
      ).range(0, 29);
      if (error) throw error;
      return { rows: data as Row[], count: count || 0 };
    },
  });
  return (
    <section
      className={`kanban-column ${over ? "drop-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/plain");
        if (/^[\da-f-]{36}$/.test(id)) onMove(id, stage.name);
      }}
    >
      <header>
        <span className={`stage-dot ${stage.outcome}`} />
        <h3>{stage.name}</h3>
        <span>{query.data?.count || 0}</span>
        <Link
          className="icon-button"
          aria-label={`Create deal in ${stage.name}`}
          to={`/deals?new=1&stage=${encodeURIComponent(stage.name)}`}
        >
          <Plus size={15} />
        </Link>
      </header>
      {query.isLoading ? (
        <Loading rows={3} />
      ) : query.error ? (
        <ErrorMessage error={(query.error as Error).message} />
      ) : !query.data?.rows.length ? (
        <div className="kanban-empty">No deals in this stage</div>
      ) : (
        query.data.rows.map((r) => (
          <Link
            className="deal-card"
            to={`/deals/${r.id}`}
            key={r.id}
            draggable={
              role !== "Sales Representative" || r.owner_id === session!.user.id
            }
            onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)}
          >
            <div>
              <strong>{r.name}</strong>
              <ArrowUpRight size={14} />
            </div>
            <span className="deal-card-amount">
              {money(r.amount, org!.currency)}
            </span>
            <footer>
              <span>{r.probability}% probability</span>
              <span>{date(r.expected_close_date, org!.timezone)}</span>
            </footer>
          </Link>
        ))
      )}
      {(query.data?.count || 0) > 30 && (
        <Link className="text-link" to={`/deals?${p.toString()}&view=table`}>
          View all {query.data!.count} deals
        </Link>
      )}
    </section>
  );
}
export default function RecordList({ entity }: { entity: Entity }) {
  const { org, members, role, session } = useAuth();
  const [params, setParams] = useSearchParams();
  const customFields = useCustomFields(entity.table);
  const customizable = supportsCustomization(entity.table);
  const columns = customizable
    ? visibleColumns(entity, params, customFields.data || [])
    : entity.columns;
  const navigate = useNavigate();
  const location = useLocation();
  const cache = useQueryClient();
  const records = useRecords(entity, params);
  const pitchSummary = useSummary("all");
  const [filters, setFilters] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [exporting, setExporting] = useState(false);
  const [bulk, setBulk] = useState("");
  const [saving, setSaving] = useState(false);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const count = records.data?.count || 0;
  const permissions = useRecordPermissions(
    entity.table,
    (records.data?.rows || []).map((r) => r.id),
  );
  const rows = (records.data?.rows || []).map((r) => ({
    ...r,
    __preserved: permissions.data?.[r.id]?.preserved,
  }));
  const board = entity.key === "deals" && params.get("view") !== "table";
  const showForm = params.get("new") === "1";
  useEffect(() => setSelected(new Set()), [params.toString(), entity.key]);
  function set(key: string, value: string) {
    setParams((p) => {
      if (value) p.set(key, value);
      else p.delete(key);
      if (key !== "page") p.delete("page");
      return p;
    });
  }
  async function exportAll() {
    setExporting(true);
    try {
      if (customizable && (!customFields.data || customFields.error))
        throw new Error("Load custom fields before exporting.");
      const data = await exportRecords(
        entity,
        org!.id,
        params,
        org!.timezone,
        customFields.data || [],
      );
      const formatted = data.map((r) => ({
        ...r,
        ...Object.fromEntries(
          columns
            .filter((c) => c.startsWith("cf:"))
            .map((c) => [c, customValue(r, c)]),
        ),
        owner_id:
          members.find((m) => m.user_id === r.owner_id)?.profiles.name ||
          r.owner_id,
      }));
      csv(
        formatted,
        ["id", ...columns],
        `${entity.table}-${today(org!.timezone)}.csv`,
        Object.fromEntries(
          columns
            .filter((c) => c.startsWith("cf:"))
            .map((c) => [c, customLabel(c, customFields.data || [])]),
        ),
      );
      toast.success(`Exported ${data.length} filtered records`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  async function move(id: string, stage: string) {
    const { error } = await supabase
      .from("deals")
      .update({ stage })
      .eq("id", id)
      .eq("org_id", org!.id)
      .select("id")
      .single();
    if (error) toast.error(error.message);
    else {
      await cache.invalidateQueries();
      toast.success(`Moved to ${stage}`);
    }
  }
  async function bulkUpdate() {
    if (!bulk || !selected.size) return;
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from(entity.table)
        .update({ status: bulk })
        .eq("org_id", org!.id)
        .in("id", [...selected])
        .select("id");
      if (error) throw error;
      await cache.invalidateQueries();
      toast.success(`Updated ${data?.length || 0} records`);
      setSelected(new Set());
      setBulk("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const activeFilters = [...params.entries()].filter(
    ([k]) =>
      ![
        "q",
        "page",
        "sort",
        "direction",
        "view",
        "new",
        "columns",
        "saved_view",
        "cf",
      ].includes(k),
  );
  return (
    <>
      <PageTitle
        title={entity.title}
        description={entity.description}
        eyebrow={
          entity.key === "pitch-desk"
            ? "PREPARE. PRESENT. PROGRESS."
            : undefined
        }
      >
        <button className="button" onClick={exportAll} disabled={exporting}>
          <Download size={16} />
          {exporting ? "Exporting…" : "Export"}
        </button>
        <button
          className="button primary"
          onClick={() => set("new", "1")}
          disabled={
            ["sales_targets"].includes(entity.table) &&
            role === "Sales Representative"
          }
        >
          <Plus size={16} />
          New {entity.singular}
        </button>
      </PageTitle>
      {customizable && customFields.data && (
        <SavedViews
          entity={entity}
          fields={customFields.data}
          columns={columns}
          params={params}
          setParams={setParams}
        />
      )}
      {customizable && customFields.error && (
        <ErrorMessage
          error={(customFields.error as Error).message}
          retry={() => customFields.refetch()}
        />
      )}
      {entity.key === "pitch-desk" && pitchSummary.data && (
        <div className="pitch-metrics">
          {[
            ["All pitches", "pitches", ""],
            ["Draft", "pitchDraft", "Draft"],
            ["Ready to Send", "pitchReady", "Ready to Send"],
            ["Sent · manual", "pitchSent", "Sent"],
            ["Accepted", "pitchAccepted", "Accepted"],
            ["Rejected", "pitchRejected", "Rejected"],
          ].map(([label, key, status]) => (
            <Link
              key={key}
              to={
                status
                  ? `/pitch-desk?status=${encodeURIComponent(status)}`
                  : "/pitch-desk"
              }
            >
              <span>{label}</span>
              <strong>{pitchSummary.data[key]}</strong>
            </Link>
          ))}
          <div>
            <span>Viewed</span>
            <strong className="metric-unconfigured">Unconfigured</strong>
          </div>
          <div>
            <span>Linked to a deal</span>
            <strong>
              {pitchSummary.data.pitches
                ? (
                    (pitchSummary.data.pitchConverted /
                      pitchSummary.data.pitches) *
                    100
                  ).toFixed(1)
                : "0"}
              %
            </strong>
          </div>
        </div>
      )}
      {entity.key === "pitch-desk" && (
        <div className="page-subnav">
          <Link className="selected" to="/pitch-desk">
            All pitches
          </Link>
          <Link to="/templates">
            Templates <ArrowUpRight size={13} />
          </Link>
        </div>
      )}
      {entity.key === "tasks" && (
        <div className="page-subnav">
          {[
            ["All tasks", "/tasks"],
            [
              "Overdue",
              `/tasks?due_before=${addDays(today(org!.timezone), -1)}`,
            ],
            ["Today", `/tasks?due_on=${today(org!.timezone)}`],
            ["Upcoming", `/tasks?due_after=${today(org!.timezone)}`],
            ["Completed", "/tasks?status=Completed"],
          ].map(([label, url]) => (
            <Link
              key={label}
              className={
                location.pathname + location.search === url ? "selected" : ""
              }
              to={url}
            >
              {label}
            </Link>
          ))}
        </div>
      )}
      <div className="records-panel">
        <div className="table-toolbar">
          <div className="table-toolbar-left">
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label={`Search ${entity.title}`}
                value={params.get("q") || ""}
                onChange={(e) => set("q", e.target.value)}
                placeholder={`Search ${entity.title.toLowerCase()}…`}
              />
              {params.get("q") && (
                <button
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => set("q", "")}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <button className="button" onClick={() => setFilters(true)}>
              <SlidersHorizontal size={15} />
              Filters
              {activeFilters.length > 0 && (
                <span className="count-badge">{activeFilters.length}</span>
              )}
            </button>
          </div>
          <div className="table-toolbar-right">
            <span className="muted record-count">
              {count}{" "}
              {entity.title === "Deals & Pipeline"
                ? "deals"
                : entity.title.toLowerCase()}
            </span>
            {entity.key === "deals" && (
              <div className="segmented">
                <button
                  className={board ? "active" : ""}
                  aria-label="Pipeline board"
                  onClick={() => set("view", "board")}
                >
                  <Columns3 size={16} />
                </button>
                <button
                  className={!board ? "active" : ""}
                  aria-label="Table view"
                  onClick={() => set("view", "table")}
                >
                  <List size={16} />
                </button>
              </div>
            )}
          </div>
        </div>
        {activeFilters.length > 0 && (
          <div className="filter-chips">
            {activeFilters.map(([k, v]) => (
              <button key={k} onClick={() => set(k, "")}>
                {titleCase(k)}:{" "}
                {k === "owner_id"
                  ? members.find((m) => m.user_id === v)?.profiles.name
                  : v}
                <X size={12} />
              </button>
            ))}
            <button
              onClick={() =>
                setParams((p) => {
                  activeFilters.forEach(([k]) => p.delete(k));
                  p.delete("page");
                  return p;
                })
              }
            >
              Clear all
            </button>
          </div>
        )}
        {selected.size > 0 && (
          <div className="bulk-toolbar">
            <span>{selected.size} selected</span>
            <select
              aria-label="Bulk status"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            >
              <option value="">Update status…</option>
              {entity.status
                ?.filter((s) => s !== "Converted")
                .map((s) => (
                  <option key={s}>{s}</option>
                ))}
            </select>
            <button
              className="button primary small"
              disabled={!bulk || saving}
              onClick={bulkUpdate}
            >
              Apply
            </button>
            <button
              className="icon-button"
              onClick={() => setSelected(new Set())}
              aria-label="Clear selection"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {board ? (
          <div className="kanban">
            {org!.pipeline_stages
              .filter(
                (s) => !params.get("stage") || params.get("stage") === s.name,
              )
              .map((s) => (
                <StageColumn
                  key={s.name}
                  stage={s}
                  params={params}
                  onMove={move}
                />
              ))}
          </div>
        ) : records.isLoading || (customizable && customFields.isPending) ? (
          <Loading />
        ) : records.error ? (
          <ErrorMessage
            error={(records.error as Error).message}
            retry={() => records.refetch()}
          />
        ) : rows.length ? (
          <RecordTable
            entity={{ ...entity, columns }}
            rows={rows}
            selected={selected}
            back={location.pathname + location.search}
            onToggle={
              ["leads", "tasks"].includes(entity.key)
                ? (id) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      n.has(id) ? n.delete(id) : n.add(id);
                      return n;
                    })
                : undefined
            }
            onToggleAll={
              ["leads", "tasks"].includes(entity.key)
                ? () =>
                    setSelected((s) =>
                      rows.every((r) => s.has(r.id))
                        ? new Set()
                        : new Set(
                            rows
                              .filter(
                                (r) =>
                                  role !== "Sales Representative" ||
                                  r.owner_id === session!.user.id,
                              )
                              .map((r) => r.id),
                          ),
                    )
                : undefined
            }
            sort={params.get("sort") || "created_at"}
            onSort={(column) =>
              setParams((p) => {
                p.set(
                  "direction",
                  p.get("sort") === column && p.get("direction") === "asc"
                    ? "desc"
                    : "asc",
                );
                p.set("sort", column);
                p.delete("page");
                return p;
              })
            }
          />
        ) : (
          <Empty
            title={
              activeFilters.length || params.get("q")
                ? "No matching records"
                : `Your ${entity.title.toLowerCase()} start here`
            }
            description={
              activeFilters.length || params.get("q")
                ? "Try adjusting your search or filters."
                : `Create your first ${entity.singular} to give your team a shared starting point.`
            }
            action={() => set("new", "1")}
          />
        )}
        <div className="table-footer">
          <span>
            {board
              ? "Drag a deal to change its stage."
              : count
                ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} of ${count} records`
                : "No records to display"}
          </span>
          {!board && (
            <div>
              <button
                className="button small"
                disabled={page <= 1}
                onClick={() => set("page", String(page - 1))}
              >
                <ChevronLeft size={14} />
                Previous
              </button>
              <span>
                Page {page} of {Math.max(1, Math.ceil(count / pageSize))}
              </span>
              <button
                className="button small"
                disabled={page * pageSize >= count}
                onClick={() => set("page", String(page + 1))}
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
      <Modal
        open={filters}
        onClose={() => setFilters(false)}
        title={`Filter ${entity.title.toLowerCase()}`}
        description="Choose the records you want to focus on."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setParams((p) => {
              for (const [k, v] of f.entries()) {
                const value = String(v);
                if (k === "filter_date_since") {
                  if (value)
                    p.set("since", zonedBoundary(value, org!.timezone));
                  else p.delete("since");
                  continue;
                }
                if (k === "filter_date_until") {
                  if (value)
                    p.set(
                      "until",
                      zonedBoundary(addDays(value, 1), org!.timezone),
                    );
                  else p.delete("until");
                  continue;
                }
                if (value) p.set(k, value);
                else p.delete(k);
              }
              p.delete("page");
              return p;
            });
            setFilters(false);
          }}
        >
          <div className="form-grid">
            {entity.status && (
              <label>
                Status
                <select name="status" defaultValue={params.get("status") || ""}>
                  <option value="">All statuses</option>
                  {entity.status.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Owner
              <select
                name="owner_id"
                defaultValue={params.get("owner_id") || ""}
              >
                <option value="">All owners</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.profiles.name}
                  </option>
                ))}
              </select>
            </label>
            {entity.key === "leads" && (
              <>
                <label>
                  Source
                  <select
                    name="source"
                    defaultValue={params.get("source") || ""}
                  >
                    <option value="">All sources</option>
                    {org!.lead_sources.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select
                    name="priority"
                    defaultValue={params.get("priority") || ""}
                  >
                    <option value="">All priorities</option>
                    {["Low", "Medium", "High"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {entity.key === "contacts" && (
              <label>
                Tag
                <input name="tag" defaultValue={params.get("tag") || ""} />
              </label>
            )}
            {entity.key === "deals" && (
              <>
                <label>
                  Stage
                  <select name="stage" defaultValue={params.get("stage") || ""}>
                    <option value="">All stages</option>
                    {org!.pipeline_stages
                      .filter(
                        (s) =>
                          !params.get("stage") ||
                          params.get("stage") === s.name,
                      )
                      .map((s) => (
                        <option key={s.name}>{s.name}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Outcome
                  <select
                    name="outcome"
                    defaultValue={params.get("outcome") || ""}
                  >
                    <option value="">All outcomes</option>
                    <option value="open">Open</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                  </select>
                </label>
                <label>
                  Minimum amount
                  <input
                    name="min"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={params.get("min") || ""}
                  />
                </label>
                <label>
                  Maximum amount
                  <input
                    name="max"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={params.get("max") || ""}
                  />
                </label>
                <label>
                  Close from
                  <input
                    type="date"
                    name="close_from"
                    defaultValue={params.get("close_from") || ""}
                  />
                </label>
                <label>
                  Close until
                  <input
                    type="date"
                    name="close_until"
                    defaultValue={params.get("close_until") || ""}
                  />
                </label>
              </>
            )}
            <label>
              Record visibility
              <select
                name="archived"
                defaultValue={params.get("archived") || ""}
              >
                <option value="">Active records</option>
                <option value="1">Archived records</option>
              </select>
            </label>
            <label>
              Created since
              <input
                type="date"
                name="filter_date_since"
                defaultValue={
                  params.get("since")
                    ? calendarDate(params.get("since")!, org!.timezone)
                    : ""
                }
              />
            </label>
            <label>
              Created through
              <input
                type="date"
                name="filter_date_until"
                defaultValue={
                  params.get("until")
                    ? addDays(
                        calendarDate(params.get("until")!, org!.timezone),
                        -1,
                      )
                    : ""
                }
              />
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => setFilters(false)}
            >
              Cancel
            </button>
            <button className="button primary">
              Apply filters
              <Check size={15} />
            </button>
          </div>
        </form>
      </Modal>
      {showForm && (
        <RecordForm
          key={entity.key}
          entity={entity}
          initial={
            entity.key === "deals" && params.get("stage")
              ? {
                  stage: params.get("stage"),
                  probability: org!.pipeline_stages.find(
                    (s) => s.name === params.get("stage"),
                  )?.probability,
                }
              : Object.fromEntries(
                  ["company_id", "contact_id", "deal_id", "lead_id"]
                    .filter((k) => params.has(k))
                    .map((k) => [k, params.get(k)]),
                )
          }
          onClose={() => set("new", "")}
          onSaved={(id) =>
            navigate(`/${entity.key}/${id}`, {
              state: {
                back:
                  location.pathname +
                  location.search
                    .replace(/([?&])new=1&?/, "$1")
                    .replace(/[?&]$/, ""),
              },
            })
          }
        />
      )}
    </>
  );
}
