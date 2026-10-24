import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Plus,
  TrendingUp,
  ChevronRight,
  Target,
  CalendarDays,
  ArrowRight,
  UsersRound,
  PanelsTopLeft,
  Wallet,
  Presentation,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { useSummary } from "../lib/data";
import { money, percent, date, period, today } from "../lib/utils";
import { Badge, Empty, ErrorMessage, Loading, PageTitle, Section } from "./ui";
export function DateRange() {
  const [p, set] = useSearchParams();
  const value = p.get("range") || "month";
  const update = (key: string, value: string) =>
    set((old) => {
      old.set(key, value);
      return old;
    });
  return (
    <div className="date-range">
      <CalendarDays size={15} />
      <select
        aria-label="Reporting period"
        value={value}
        onChange={(e) => update("range", e.target.value)}
      >
        {[
          ["today", "Today"],
          ["7", "Last 7 days"],
          ["30", "Last 30 days"],
          ["month", "This month"],
          ["lastMonth", "Last month"],
          ["quarter", "This quarter"],
          ["year", "This year"],
          ["all", "All time"],
          ["custom", "Custom range"],
        ].map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {value === "custom" && (
        <>
          <input
            type="date"
            aria-label="Start date"
            value={p.get("from") || ""}
            onChange={(e) => update("from", e.target.value)}
            max={p.get("to") || undefined}
          />
          <span>to</span>
          <input
            type="date"
            aria-label="End date"
            value={p.get("to") || ""}
            onChange={(e) => update("to", e.target.value)}
            min={p.get("from") || undefined}
          />
        </>
      )}
    </div>
  );
}
export function Chart({
  rows,
  currency,
  lead = false,
  linkBase = "/deals?outcome=won",
}: {
  rows: any[];
  currency: string;
  lead?: boolean;
  linkBase?: string;
}) {
  if (!rows?.length)
    return (
      <Empty
        compact
        title={
          lead
            ? "Your lead history starts here"
            : "Your next win will show up here"
        }
        description={
          lead
            ? "A chart will appear as leads are created."
            : "Closed-won deals will build your sales performance chart."
        }
      />
    );
  const max = Math.max(...rows.map((x) => Number(x.value)), 1);
  return (
    <div className="real-chart">
      <div className="chart-y">
        <span>{lead ? max : money(max, currency)}</span>
        <span>{lead ? Math.round(max / 2) : money(max / 2, currency)}</span>
        <span>{lead ? "0" : money(0, currency)}</span>
      </div>
      <div className="chart-bars">
        {rows.map((x) => (
          <Link
            title={`${x.month}: ${lead ? x.value : money(x.value, currency)}`}
            className="chart-column"
            key={x.month}
            to={`${linkBase}&month=${x.month}`}
          >
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ height: `${(Number(x.value) / max) * 100}%` }}
              />
              <span className="chart-tooltip">
                {lead ? x.value : money(x.value, currency)}
              </span>
            </span>
            <span className="chart-x">
              {new Date(`${x.month}-15T12:00:00Z`).toLocaleDateString("en-US", {
                month: "short",
                year: "2-digit",
                timeZone: "UTC",
              })}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
export function Pipeline({ summary }: { summary: any }) {
  const { org } = useAuth();
  const stages = org!.pipeline_stages.filter((s) => s.outcome === "open");
  const max = Math.max(
    ...(summary.stages || []).map((s: any) => Number(s.value)),
    1,
  );
  return (
    <div className="pipeline-breakdown">
      {stages.map((s, i) => {
        const stat = summary.stages?.find((x: any) => x.stage === s.name);
        return (
          <Link
            to={`/deals?stage=${encodeURIComponent(s.name)}&view=table`}
            className="pipeline-stage"
            key={s.name}
          >
            <div>
              <span>
                <i style={{ opacity: 1 - i * 0.15 }} />
                {s.name}
                <small>{stat?.count || 0}</small>
              </span>
              <strong>{money(stat?.value || 0, org!.currency)}</strong>
            </div>
            <div className="progress-track">
              <span
                style={{
                  width: `${(Number(stat?.value || 0) / max) * 100}%`,
                  opacity: 1 - i * 0.15,
                }}
              />
            </div>
          </Link>
        );
      })}
      <div className="pipeline-footer">
        <span>Weighted pipeline</span>
        <strong>{money(summary.weighted, org!.currency)}</strong>
      </div>
    </div>
  );
}
export default function Dashboard() {
  const { org, profile } = useAuth();
  const [params] = useSearchParams();
  const range = params.get("range") || "month";
  const summary = useSummary(
    range,
    params.get("from") || undefined,
    params.get("to") || undefined,
  );
  const s = summary.data;
  const p = period(
    range,
    org!.timezone,
    params.get("from") || undefined,
    params.get("to") || undefined,
  );
  const qs = `since=${encodeURIComponent(p.start)}&until=${encodeURIComponent(p.end)}`;
  const periodLabel =
    range === "all" ? "All time" : `${date(p.from)} – ${date(p.to)}`;
  return (
    <>
      <PageTitle
        eyebrow="YOUR WORKSPACE, AT A GLANCE"
        title={`Let’s make progress${profile?.name ? ", " + profile.name.split(" ")[0] : ""}.`}
        description="A little focus. A clear next step. Everything you need to move forward."
      >
        <DateRange />
        <Link className="button primary" to="/leads?new=1">
          <Plus size={16} />
          Add a lead
        </Link>
      </PageTitle>
      {summary.isLoading ? (
        <Loading rows={8} />
      ) : summary.error ? (
        <ErrorMessage
          error={(summary.error as Error).message}
          retry={() => summary.refetch()}
        />
      ) : (
        s && (
          <>
            <div className="overview-banner">
              <span className="overview-banner-icon">
                <TrendingUp size={21} />
              </span>
              <div>
                <strong>Your sales, in sync.</strong>
                <p>
                  {s.leads + s.openDeals + s.contacts === 0
                    ? "Start with a connection. Your insights will grow from there."
                    : `${s.openDeals} open opportunities and ${s.qualified} qualified leads to move forward.`}
                </p>
              </div>
              <Link to="/deals">
                Explore your pipeline
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <div className="primary-metrics">
              {[
                {
                  label: "Open pipeline",
                  value: money(s.pipeline, org!.currency),
                  description: `${s.openDeals} active deals · current snapshot`,
                  to: "/deals?outcome=open",
                  icon: PanelsTopLeft,
                },
                {
                  label: "Closed-won value",
                  value: money(s.won, org!.currency),
                  description: s.previousWon
                    ? `${(((s.won - s.previousWon) / s.previousWon) * 100).toFixed(1)}% vs. previous period`
                    : "No closed-won value in the previous period",
                  to: `/deals?outcome=won&${qs}`,
                  icon: Wallet,
                },
                {
                  label: "Leads created",
                  value: s.leads,
                  description: `${s.qualified} qualified or converted`,
                  to: `/leads?${qs}`,
                  icon: UsersRound,
                },
                {
                  label: "Lead conversion",
                  value: percent(s.converted, s.leads),
                  description: `${s.converted} converted of ${s.leads} leads`,
                  to: `/leads?status=Converted&${qs}`,
                  icon: TrendingUp,
                },
              ].map((m) => (
                <Link className="metric" to={m.to} key={m.label}>
                  <div className="metric-label">
                    <span>{m.label}</span>
                    <m.icon size={17} />
                  </div>
                  <strong>{m.value}</strong>
                  <div className="metric-description">
                    {m.description}
                    <ArrowUpRight size={14} />
                  </div>
                </Link>
              ))}
            </div>
            <div className="secondary-metrics">
              {[
                ["Qualified leads", s.qualified, `/leads?qualified=1&${qs}`],
                ["Contacts created", s.contacts, `/contacts?${qs}`],
                ["Active deals", s.openDeals, "/deals?outcome=open"],
                ["Target achievement", percent(s.won, s.target), "/targets"],
              ].map(([label, value, to]) => (
                <Link to={String(to)} key={String(label)}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <ArrowUpRight size={13} />
                </Link>
              ))}
            </div>
            <div className="dashboard-chart-grid">
              <Section
                title="Sales performance"
                description={`Closed-won deal value · ${periodLabel}`}
                action={
                  <Link
                    to={`/reports/sales?${params.toString()}`}
                    className="text-link"
                  >
                    View report
                    <ArrowUpRight size={14} />
                  </Link>
                }
              >
                <div className="chart-headline">
                  <strong>{money(s.won, org!.currency)}</strong>
                  <span>closed-won value</span>
                </div>
                <Chart
                  rows={s.monthly}
                  currency={org!.currency}
                  linkBase={`/deals?outcome=won&${qs}`}
                />
              </Section>
              <Section
                title="Pipeline by stage"
                description="Open opportunities · current snapshot"
                action={
                  <Link
                    to="/deals"
                    className="icon-button"
                    aria-label="Open pipeline"
                  >
                    <ArrowUpRight size={17} />
                  </Link>
                }
              >
                <Pipeline summary={s} />
              </Section>
            </div>
            <div className="dashboard-bottom-grid">
              <Section
                title="Upcoming tasks"
                description="A clear view of what comes next."
                action={
                  <Link className="text-link" to="/tasks">
                    View all
                    <ArrowUpRight size={14} />
                  </Link>
                }
              >
                {s.nextTasks?.length ? (
                  <div className="task-list">
                    {s.nextTasks.map((t: any) => (
                      <Link to={`/tasks/${t.id}`} key={t.id}>
                        <span className="task-check" />
                        <div>
                          <strong>{t.name}</strong>
                          <small
                            className={
                              t.due_date < today(org!.timezone)
                                ? "text-danger"
                                : ""
                            }
                          >
                            {date(t.due_date, org!.timezone)}
                          </small>
                        </div>
                        <Badge value={t.priority} />
                        <ChevronRight size={14} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Empty
                    compact
                    title="A little room to focus"
                    description="Add a task to plan your next conversation."
                    link="/tasks?new=1"
                  />
                )}
              </Section>
              <Section
                title="Recent activity"
                description="The latest work across your team."
                action={
                  <Link className="text-link" to="/activities">
                    View all
                    <ArrowUpRight size={14} />
                  </Link>
                }
              >
                {s.activities?.length ? (
                  <div className="activity-list">
                    {s.activities.map((a: any) => (
                      <Link key={a.id} to={`/activities/${a.id}`}>
                        <span className="activity-dot" />
                        <div>
                          <strong>{a.name}</strong>
                          <p>{a.description}</p>
                          <small>
                            {date(a.occurred_at, org!.timezone, true)}
                          </small>
                        </div>
                        <ArrowUpRight size={13} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Empty
                    compact
                    title="Every conversation counts"
                    description="Saved calls, notes, and updates will appear here."
                    link="/activities?new=1"
                  />
                )}
              </Section>
            </div>
            <div className="dashboard-bottom-grid">
              <Section
                title="Recent deals"
                action={
                  <Link className="text-link" to="/deals?view=table">
                    View all
                    <ArrowUpRight size={14} />
                  </Link>
                }
              >
                {s.recentDeals?.length ? (
                  <div className="compact-records">
                    {s.recentDeals.map((d: any) => (
                      <Link key={d.id} to={`/deals/${d.id}`}>
                        <span>
                          <strong>{d.name}</strong>
                          <small>{d.stage}</small>
                        </span>
                        <strong>{money(d.amount, org!.currency)}</strong>
                        <ArrowUpRight size={14} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Empty
                    compact
                    title="Your next opportunity awaits"
                    description="Add a deal to start building your pipeline."
                    link="/deals?new=1"
                  />
                )}
              </Section>
              <Section
                title="Leads to follow up"
                action={
                  <Link className="text-link" to="/leads?status=New">
                    View all
                    <ArrowUpRight size={14} />
                  </Link>
                }
              >
                {s.attentionLeads?.length ? (
                  <div className="compact-records">
                    {s.attentionLeads.map((l: any) => (
                      <Link key={l.id} to={`/leads/${l.id}`}>
                        <span>
                          <strong>{l.name}</strong>
                          <small>{l.status}</small>
                        </span>
                        <Badge value={l.priority} />
                        <ArrowUpRight size={14} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Empty
                    compact
                    title="No new leads need attention"
                    description="New leads in your selected period will appear here."
                  />
                )}
              </Section>
            </div>
            <div className="dashboard-footnote">
              <Target size={15} />
              <span>
                Target: {money(s.target, org!.currency)} · Targets overlapping
                the selected period; no prorating. Closed-won value is separate
                from collected payments.
              </span>
              <Link to="/targets">
                Manage targets
                <ArrowRight size={14} />
              </Link>
            </div>
            <Link to="/pitch-desk" className="pitch-teaser">
              <Presentation size={23} />
              <span>
                <strong>Make your next pitch count.</strong>
                <small>
                  Prepare proposals, build from templates, and keep every next
                  step in view.
                </small>
              </span>
              <span>
                Open Pitch Desk
                <ArrowUpRight size={15} />
              </span>
            </Link>
          </>
        )
      )}
    </>
  );
}
