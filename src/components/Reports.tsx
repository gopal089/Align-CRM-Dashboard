import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Printer, ArrowUpRight, Search } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useSummary } from "../lib/data";
import { csv, date, money, percent, period } from "../lib/utils";
import { PageTitle, Section, ErrorMessage, Loading, Empty } from "./ui";
import { DateRange, Chart, Pipeline } from "./Dashboard";
import { assertExportAllowed } from "../lib/billing";
import { toast } from "sonner";
function AnalyticsTable({
  rows,
  columns,
  filename,
}: {
  rows: any[];
  columns: {
    key: string;
    label: string;
    format?: (value: any, row: any) => React.ReactNode;
  }[];
  filename: string;
}) {
  const { org } = useAuth();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(columns[0].key);
  const [asc, setAsc] = useState(true);
  const filtered = rows
    .filter((r) =>
      Object.values(r).some((v) =>
        String(v).toLowerCase().includes(q.toLowerCase()),
      ),
    )
    .sort((a, b) => {
      const x = a[sort],
        y = b[sort];
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x || "").localeCompare(String(y || ""));
      return asc ? cmp : -cmp;
    });
  return (
    <>
      <div className="report-table-toolbar">
        <div className="search-field">
          <Search size={15} />
          <input
            aria-label="Filter report rows"
            placeholder="Filter this report…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          className="button small"
          onClick={async () => {
            try {
              await assertExportAllowed(org!.id);
              csv(
                filtered,
                columns.map((c) => c.key),
                `${filename}.csv`,
              );
            } catch (error) {
              toast.error((error as Error).message);
            }
          }}
        >
          <Download size={14} />
          CSV
        </button>
      </div>
      {!filtered.length ? (
        <Empty
          compact
          title="No report data yet"
          description="This report will populate as your team creates records."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>
                    <button
                      className="sort-button"
                      onClick={() => {
                        if (sort === c.key) setAsc(!asc);
                        else {
                          setSort(c.key);
                          setAsc(true);
                        }
                      }}
                    >
                      {c.label}
                      {sort === c.key ? (asc ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      {c.format
                        ? c.format(r[c.key], r)
                        : String(r[c.key] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
export default function Reports() {
  const { org } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "Revenue";
  const range = params.get("range") || "month";
  const q = useSummary(
    range,
    params.get("from") || undefined,
    params.get("to") || undefined,
  );
  const s = q.data;
  const p = period(
    range,
    org!.timezone,
    params.get("from") || undefined,
    params.get("to") || undefined,
  );
  const fmt = (v: any) => money(v, org!.currency);
  const qs = `since=${encodeURIComponent(p.start)}&until=${encodeURIComponent(p.end)}`;
  const tiles = s
    ? tab === "Revenue"
      ? [
          ["Closed-won value", fmt(s.won)],
          [
            "Collected payments",
            org!.payment_tracking ? fmt(s.collected) : "Not enabled",
          ],
          ["Target achievement", percent(s.won, s.target)],
          ["Average won deal", fmt(s.avgDeal)],
        ]
      : tab === "Pipeline"
        ? [
            ["Open pipeline", fmt(s.pipeline)],
            ["Weighted pipeline", fmt(s.weighted)],
            ["Overdue close dates", s.overdueDeals],
            ["Stalled >30 days", s.stalledDeals],
          ]
        : tab === "Leads"
          ? [
              ["Leads created", s.leads],
              ["Qualified conversion", percent(s.qualified, s.leads)],
              ["Lead-to-won conversion", percent(s.leadWon, s.leads)],
              [
                "Avg. conversion time",
                s.conversionDays === null
                  ? "No history"
                  : `${Number(s.conversionDays).toFixed(1)} days`,
              ],
            ]
          : tab === "Pitches"
            ? [
                ["Pitches created", s.pitches],
                ["Acceptance rate", percent(s.pitchAccepted, s.pitches)],
                ["Linked to a deal", percent(s.pitchConverted, s.pitches)],
                [
                  "Avg. time to acceptance",
                  s.acceptanceDays === null
                    ? "No history"
                    : `${Number(s.acceptanceDays).toFixed(1)} days`,
                ],
              ]
            : [
                ["Deals created", s.periodDeals],
                ["Deals won", s.wonCount],
                ["Win rate", percent(s.wonCount, s.wonCount + s.lostCount)],
                [
                  "Average sales cycle",
                  s.cycleDays === null
                    ? "No history"
                    : `${Number(s.cycleDays).toFixed(1)} days`,
                ],
              ]
    : [];
  return (
    <>
      <PageTitle
        eyebrow="CLEAR NUMBERS. BETTER DECISIONS."
        title="Sales Reports"
        description="Understand what’s working, and where to focus next."
      >
        <DateRange />
        <button
          className="button"
          onClick={async () => {
            try {
              await assertExportAllowed(org!.id);
              window.print();
            } catch (error) {
              toast.error((error as Error).message);
            }
          }}
        >
          <Printer size={15} />
          Print report
        </button>
      </PageTitle>
      <div className="page-subnav">
        {[
          "Revenue",
          "Pipeline",
          "Leads",
          "Sales representatives",
          "Pitches",
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() =>
              setParams((p) => {
                p.set("tab", t);
                return p;
              })
            }
          >
            {t}
          </button>
        ))}
      </div>
      <div className="report-period">
        Reporting period:{" "}
        <strong>
          {range === "all" ? "All time" : `${date(p.from)} – ${date(p.to)}`}
        </strong>
        <span>
          {org!.timezone} · {org!.currency}
        </span>
      </div>
      {q.isLoading ? (
        <Loading rows={8} />
      ) : q.error ? (
        <ErrorMessage
          error={(q.error as Error).message}
          retry={() => q.refetch()}
        />
      ) : (
        s && (
          <>
            <div className="report-metrics">
              {tiles.map(([label, value]) => (
                <div key={String(label)}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {tab === "Revenue" ? (
              <>
                <Section
                  title="Closed-won value over time"
                  description="Based on deal close timestamps. This is booked deal value, not collected payments."
                >
                  <Chart
                    rows={s.monthly}
                    currency={org!.currency}
                    linkBase={`/deals?outcome=won&${qs}`}
                  />
                </Section>
                <div className="report-dual">
                  <Section title="Value by representative">
                    <AnalyticsTable
                      rows={s.reps}
                      filename="revenue-by-representative"
                      columns={[
                        {
                          key: "name",
                          label: "Representative",
                          format: (v, r) => (
                            <Link
                              to={`/deals?outcome=won&owner_id=${r.user_id}&${qs}`}
                            >
                              {v}
                            </Link>
                          ),
                        },
                        { key: "won", label: "Won deals" },
                        {
                          key: "value",
                          label: "Closed-won value",
                          format: fmt,
                        },
                      ]}
                    />
                  </Section>
                  <Section title="Value by company">
                    <AnalyticsTable
                      rows={s.companies}
                      filename="revenue-by-company"
                      columns={[
                        { key: "name", label: "Company" },
                        { key: "count", label: "Won deals" },
                        { key: "value", label: "Value", format: fmt },
                      ]}
                    />
                  </Section>
                </div>
                <Section title="Performance compared with target">
                  <div className="definition-grid">
                    <div>
                      <span>Target for overlapping target periods</span>
                      <strong>{fmt(s.target)}</strong>
                    </div>
                    <div>
                      <span>Previous equal-length period</span>
                      <strong>{fmt(s.previousWon)}</strong>
                    </div>
                    <div>
                      <span>Period-over-period change</span>
                      <strong>
                        {s.previousWon
                          ? `${(((s.won - s.previousWon) / s.previousWon) * 100).toFixed(1)}%`
                          : "No previous period value"}
                      </strong>
                    </div>
                  </div>
                </Section>
              </>
            ) : tab === "Pipeline" ? (
              <>
                <div className="report-dual">
                  <Section
                    title="Open pipeline by stage"
                    description="Current snapshot, independent of the reporting date range."
                  >
                    <Pipeline summary={s} />
                  </Section>
                  <Section title="Pipeline detail">
                    <AnalyticsTable
                      rows={s.stages}
                      filename="pipeline"
                      columns={[
                        {
                          key: "stage",
                          label: "Stage",
                          format: (v) => (
                            <Link
                              to={`/deals?stage=${encodeURIComponent(v)}&view=table`}
                            >
                              {v}
                              <ArrowUpRight size={12} />
                            </Link>
                          ),
                        },
                        { key: "count", label: "Deals" },
                        { key: "value", label: "Open value", format: fmt },
                        {
                          key: "weighted",
                          label: "Weighted value",
                          format: fmt,
                        },
                      ]}
                    />
                  </Section>
                </div>
                <Section title="Outcomes in the selected period">
                  <div className="definition-grid">
                    <div>
                      <span>Closed-lost value</span>
                      <strong>{fmt(s.lost)}</strong>
                    </div>
                    <div>
                      <span>Win rate (won ÷ won + lost)</span>
                      <strong>
                        {percent(s.wonCount, s.wonCount + s.lostCount)}
                      </strong>
                    </div>
                    <div>
                      <span>Average won deal size</span>
                      <strong>{fmt(s.avgDeal)}</strong>
                    </div>
                  </div>
                </Section>
              </>
            ) : tab === "Leads" ? (
              <>
                <Section title="Leads created over time">
                  <Chart
                    rows={s.leadMonthly}
                    currency={org!.currency}
                    lead
                    linkBase={`/leads?${qs}`}
                  />
                </Section>
                <Section title="Leads by source">
                  <AnalyticsTable
                    rows={s.sources}
                    filename="lead-sources"
                    columns={[
                      {
                        key: "source",
                        label: "Source",
                        format: (v) => (
                          <Link
                            to={`/leads?source=${encodeURIComponent(v)}&${qs}`}
                          >
                            {v}
                            <ArrowUpRight size={12} />
                          </Link>
                        ),
                      },
                      { key: "count", label: "Leads" },
                    ]}
                  />
                </Section>
              </>
            ) : tab === "Pitches" ? (
              <>
                <Section title="Pitch outcomes">
                  <AnalyticsTable
                    rows={[
                      "Draft",
                      "Sent",
                      "Accepted",
                      "Rejected",
                      "Expired",
                    ].map((status, i) => ({
                      status,
                      count: [
                        s.pitchDraft,
                        s.pitchSent,
                        s.pitchAccepted,
                        s.pitchRejected,
                        s.pitchExpired,
                      ][i],
                    }))}
                    filename="pitch-outcomes"
                    columns={[
                      {
                        key: "status",
                        label: "Status",
                        format: (v) => (
                          <Link to={`/pitch-desk?status=${v}&${qs}`}>{v}</Link>
                        ),
                      },
                      { key: "count", label: "Pitches" },
                    ]}
                  />
                </Section>
                <Section title="Performance by owner and template">
                  <AnalyticsTable
                    rows={s.pitchByTemplate.map((r: any) => ({
                      ...r,
                      owner:
                        s.reps.find((x: any) => x.user_id === r.owner_id)
                          ?.name || "Team member",
                    }))}
                    filename="pitch-performance"
                    columns={[
                      { key: "name", label: "Template" },
                      { key: "owner", label: "Owner" },
                      { key: "total", label: "Pitches" },
                      { key: "accepted", label: "Accepted" },
                    ]}
                  />
                </Section>
                <p className="report-definition">
                  Related deal value: {fmt(s.pitchDealValue)}. Sent counts
                  pitches currently in the manually recorded Sent status.
                  Acceptance rate is current accepted pitches ÷ pitches created
                  in the period. Viewed metrics are unavailable because customer
                  view tracking is not configured.
                </p>
              </>
            ) : (
              <Section title="Sales representative performance">
                <AnalyticsTable
                  rows={s.reps}
                  filename="sales-representatives"
                  columns={[
                    {
                      key: "name",
                      label: "Representative",
                      format: (v, r) => (
                        <Link to={`/deals?owner_id=${r.user_id}&${qs}`}>
                          {v}
                        </Link>
                      ),
                    },
                    { key: "leads", label: "Leads assigned" },
                    { key: "deals", label: "Deals created" },
                    { key: "won", label: "Won" },
                    { key: "lost", label: "Lost" },
                    { key: "value", label: "Won value", format: fmt },
                    { key: "target", label: "Target", format: fmt },
                    {
                      key: "achievement",
                      label: "Achievement",
                      format: (_, r) => percent(r.value, r.target),
                    },
                  ]}
                />
              </Section>
            )}
            <div className="report-definition">
              <strong>Metric definitions</strong>
              <p>
                Closed-won and lost values use their close date. Leads and
                pitches use their creation date. Lead-to-won attribution follows
                the deal’s explicit lead relationship for leads created in this
                period, with wins before the period end. Qualified includes
                Qualified and Converted leads. Targets include periods
                overlapping the selected range and are not prorated. Archived
                records are excluded. Pipeline is the current snapshot; weighted
                value = amount × probability. Payments are manually recorded and
                never inferred from deals. All dates use {org!.timezone}.
              </p>
            </div>
          </>
        )
      )}
    </>
  );
}
