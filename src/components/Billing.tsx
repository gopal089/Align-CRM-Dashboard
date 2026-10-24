import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  AlertTriangle,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import {
  billingRequest,
  openCheckout,
  useBilling,
  usageLabels,
} from "../lib/billing";
import type { BillingPlan } from "../lib/billing";
import { money, date } from "../lib/utils";
import { PageTitle, Section, ErrorMessage, Loading, Modal } from "./ui";

function PlatformBillingReport() {
  const access = useQuery({
    queryKey: ["platform-billing-access"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("platform_billing_access");
      if (error) throw error;
      return data as boolean;
    },
  });
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const report = useQuery({
    queryKey: ["platform-billing-report", month],
    enabled: access.data === true,
    queryFn: async () => {
      const start = new Date(`${month}-01T00:00:00Z`);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const { data, error } = await supabase.rpc("platform_billing_report", {
        start_at: start.toISOString(),
        end_at: end.toISOString(),
      });
      if (error) throw error;
      return data;
    },
  });
  if (!access.data) return null;
  return (
    <Section
      title="Platform subscription revenue"
      description="Platform owner only. Subscription receipts are separate from CRM sales and customer payments."
    >
      <label>
        Reporting month (UTC){" "}
        <input
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </label>
      {report.error ? (
        <ErrorMessage error={(report.error as Error).message} />
      ) : (
        report.data && (
          <div className="billing-usage-grid">
            {[
              ["Active paid subscriptions", report.data.active_subscriptions],
              ["Monthly recurring value", money(report.data.mrr / 100, "INR")],
              [
                "Collected in selected month",
                money(report.data.collected / 100, "INR"),
              ],
              ["Scheduled cancellations", report.data.scheduled_cancellations],
              ["Failed renewals", report.data.failed_renewals],
            ].map(([label, value]) => (
              <div className="billing-usage" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        )
      )}
      <p className="fine-print">
        Active subscriptions and recurring value are a current snapshot.
        Collected totals use verified Razorpay payment timestamps in the
        selected UTC month. Free is not a trial; no time-limited trials are
        enabled.
      </p>
    </Section>
  );
}

export function BillingNotice() {
  const { role, org } = useAuth();
  const q = useBilling();
  const s = q.data;
  if (q.error)
    return (
      <div className="notice billing-notice">
        <AlertTriangle size={17} />
        <span>
          Subscription information is unavailable.{" "}
          <Link to="/settings?tab=billing">Check billing setup</Link>
        </span>
      </div>
    );
  if (!s) return null;
  const preserved = ["contacts", "leads", "companies"].reduce(
    (n, k) => n + (s.usage[k]?.excess || 0),
    0,
  );
  const nearlyFull = Object.entries(s.usage).filter(
    ([, u]) => u.limit !== null && u.used >= u.limit * 0.8,
  );
  if (
    !s.renewal_warning &&
    !(s.retention_deadline && preserved) &&
    !nearlyFull.length
  )
    return null;
  return (
    <div
      className={`notice billing-notice ${s.retention_deadline && preserved ? "billing-warning" : ""}`}
      role="status"
    >
      <AlertTriangle size={18} />
      <div>
        {s.retention_deadline && preserved ? (
          <>
            <strong>
              {preserved} excess customer records are preserved as view-only.
            </strong>
            <p>
              The newest excess records are scheduled for permanent deletion
              after{" "}
              {new Date(s.retention_deadline).toLocaleString(undefined, {
                timeZone: org!.timezone,
              })}
              . Upgrade before this deadline to keep them.
            </p>
          </>
        ) : s.renewal_warning ? (
          <>
            <strong>
              Your subscription period ends {date(s.paid_until!, org!.timezone)}
              .
            </strong>
            <p>
              {s.cancel_at_period_end ? "Cancellation is scheduled. " : ""}Paid
              access ends at expiry unless renewal payment is verified. There is
              no paid-access grace period.
            </p>
          </>
        ) : (
          <>
            <strong>You’re approaching a plan limit.</strong>
            <p>
              {nearlyFull
                .map(([k, u]) => `${usageLabels[k]}: ${u.used}/${u.limit}`)
                .join(" · ")}
            </p>
          </>
        )}
      </div>
      <Link className="button small" to="/settings?tab=billing">
        {role === "Administrator" ? "Manage plan" : "View limits"}
      </Link>
    </div>
  );
}

export default function Billing() {
  const { org, role, session } = useAuth();
  const admin = role === "Administrator";
  const q = useBilling();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [kind, setKind] = useState("contacts");
  const [page, setPage] = useState(1);
  const plans = useQuery({
    queryKey: ["subscription-plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("*")
        .order("monthly_price");
      if (error) throw error;
      return data as BillingPlan[];
    },
  });
  const config = useQuery({
    queryKey: ["billing-config", org!.id],
    enabled: admin,
    retry: false,
    queryFn: () => billingRequest("configuration", org!.id),
  });
  const retained = useQuery({
    queryKey: ["retention", org!.id, kind, page, q.data?.retention_deadline],
    enabled: !!q.data?.retention_deadline,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("billing_retained_records", {
        o: org!.id,
        kind,
        page,
      });
      if (error) throw error;
      return data as { id: string; name: string; created_at: string }[];
    },
  });
  const receipts = useQuery({
    queryKey: ["billing-receipts", org!.id],
    enabled: admin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("billing_receipts")
        .select(
          "payment_id,plan_code,amount,currency,period_start,period_end,received_at,invoice_url",
        )
        .eq("org_id", org!.id)
        .order("period_end", { ascending: false })
        .limit(24);
      if (error) throw error;
      return data;
    },
  });
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await cache.invalidateQueries();
      toast.success(success);
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (q.isLoading) return <Loading rows={5} />;
  if (q.error)
    return (
      <ErrorMessage
        error={(q.error as Error).message}
        retry={() => q.refetch()}
      />
    );
  const s = q.data!;
  const excess = s.usage[kind]?.excess || 0;
  const configured = config.data?.configured === true;
  return (
    <>
      {admin && <PlatformBillingReport />}
      <PageTitle
        title="Plans & billing"
        description="Clear limits. A plan that grows with your team."
      >
        {admin && (
          <button
            className="button"
            disabled={busy || !configured}
            onClick={() =>
              run(
                () => billingRequest("sync", org!.id),
                "Subscription checked with Razorpay",
              )
            }
          >
            <RefreshCw size={15} />
            Check payment status
          </button>
        )}
      </PageTitle>
      {error && <ErrorMessage error={error} />}
      {admin && !configured && (
        <div className="notice">
          <CreditCard size={18} />
          <div>
            <strong>Razorpay payments are not configured.</strong>
            <p>
              {config.isLoading
                ? "Checking payment setup…"
                : config.error
                  ? (config.error as Error).message
                  : "An administrator must configure the Razorpay test credentials, monthly plan IDs, and webhook. Payment controls unlock after setup."}
            </p>
          </div>
        </div>
      )}
      {config.data?.mode === "test" && (
        <div className="notice">
          Razorpay test mode — checkout uses test payments. No live subscription
          charges are enabled.
        </div>
      )}
      <Section
        title={`${s.plan.name} plan`}
        description={`Billing status: ${s.status}. Prices are in INR; CRM record currency stays ${org!.currency}.`}
      >
        {s.paid_until && (
          <p>
            Paid access until{" "}
            <strong>
              {new Date(s.paid_until).toLocaleString(undefined, {
                timeZone: org!.timezone,
              })}
            </strong>{" "}
            ({org!.timezone}).{" "}
            {s.cancel_at_period_end
              ? "Cancellation at period end is scheduled."
              : "Renewal must be verified by this time."}
          </p>
        )}
        {s.scheduled_plan && (
          <p>
            Scheduled change: {s.scheduled_plan} at{" "}
            {s.scheduled_change_at
              ? new Date(s.scheduled_change_at).toLocaleString()
              : "the next billing period"}
            .
          </p>
        )}
        <div className="billing-usage-grid">
          {Object.entries(s.usage).map(([k, u]) => (
            <div className="billing-usage" key={k}>
              <span>{usageLabels[k]}</span>
              <strong>
                {u.used.toLocaleString()}{" "}
                <small>
                  / {u.limit === null ? "Unlimited" : u.limit.toLocaleString()}
                </small>
              </strong>
              {u.limit !== null && (
                <progress
                  aria-label={`${usageLabels[k]} usage`}
                  max={Math.max(u.limit, 1)}
                  value={Math.min(u.used, u.limit)}
                />
              )}
              {u.excess > 0 && (
                <small>
                  {u.excess.toLocaleString()} above your current limit
                </small>
              )}
            </div>
          ))}
        </div>
        <p className="fine-print">
          Archived contacts, leads, companies and templates count. Active
          members include administrators. Only open, unarchived deals count
          toward the active-deal limit.
        </p>
      </Section>
      <div className="billing-plan-grid">
        {plans.data?.map((p) => (
          <Section
            key={p.code}
            title={p.name}
            description={
              p.monthly_price
                ? `${money(p.monthly_price / 100, "INR")} / month`
                : "Free, with no time limit"
            }
          >
            <ul className="billing-feature-list">
              {Object.entries(p.limits).map(([k, limit]) => (
                <li key={k}>
                  <span>{usageLabels[k]}</span>
                  <strong>
                    {limit === null ? "Unlimited" : limit.toLocaleString()}
                  </strong>
                </li>
              ))}
            </ul>
            {p.code === s.plan.code ? (
              <span className="badge">Current plan</span>
            ) : (
              admin && (
                <button
                  className="button primary"
                  disabled={busy || !configured}
                  onClick={() => {
                    if (p.code === "free" || s.plan.monthly_price > 0)
                      setConfirm(p.code);
                    else
                      run(
                        () =>
                          openCheckout(
                            org!.id,
                            p.code,
                            session!.user.email || "",
                          ),
                        "Payment verified; subscription refreshed",
                      );
                  }}
                >
                  {p.code === "free"
                    ? "Switch to Free"
                    : s.plan.monthly_price > 0
                      ? `Schedule ${p.name}`
                      : `Choose ${p.name}`}
                </button>
              )
            )}
          </Section>
        ))}
      </div>
      {admin && s.paid_plan !== "free" && !s.cancel_at_period_end && (
        <Section
          title="Subscription controls"
          description="Cancellation takes effect at the end of the paid billing period. Refunds are reviewed manually."
        >
          <button
            className="button danger"
            disabled={busy || !configured}
            onClick={() => setConfirm("cancel")}
          >
            Cancel subscription
          </button>
        </Section>
      )}
      {s.retention_deadline && (
        <Section
          title="Preserved customer records"
          description={`Newest excess records are view-only for seven days, then permanently deleted. Deadline: ${new Date(s.retention_deadline).toLocaleString(undefined, { timeZone: org!.timezone })}.`}
        >
          <div className="table-toolbar">
            <label>
              Record type{" "}
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPage(1);
                }}
              >
                {["contacts", "leads", "companies"].map((k) => (
                  <option key={k} value={k}>
                    {usageLabels[k]}
                  </option>
                ))}
              </select>
            </label>
            <span>{excess.toLocaleString()} excess records</span>
          </div>
          {retained.error ? (
            <ErrorMessage error={(retained.error as Error).message} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Original creation date</th>
                    <th>Access</th>
                  </tr>
                </thead>
                <tbody>
                  {retained.data?.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/${kind}/${r.id}`}>
                          {r.name}
                          <ArrowUpRight size={13} />
                        </Link>
                      </td>
                      <td>{date(r.created_at, org!.timezone)}</td>
                      <td>View only · scheduled for deletion</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!retained.data?.length && (
                <p>
                  {excess > 0 &&
                  s.retention_deadline &&
                  new Date(s.retention_deadline).getTime() <= Date.now()
                    ? "The retention window ended. Records are no longer viewable while verified cleanup is pending."
                    : "No excess records in this category."}
                </p>
              )}
            </div>
          )}
          <div className="form-actions">
            <button
              className="button small"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span>Page {page}</span>
            <button
              className="button small"
              disabled={page * 25 >= excess}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
          <p className="fine-print">
            Creation order is permanent. Editing or archiving a record never
            moves it out of the newest-excess group. Linked deals, pitches,
            activities, tasks and payment records are kept when customer links
            are removed.
          </p>
        </Section>
      )}
      {admin && (
        <Section
          title="Verified payments"
          description="Payments for the Align subscription. These are separate from your CRM’s customer payment records."
        >
          {receipts.error ? (
            <ErrorMessage error={(receipts.error as Error).message} />
          ) : receipts.data?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Paid</th>
                    <th>Period</th>
                    <th>Payment ID / invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.data.map((r) => (
                    <tr key={r.payment_id}>
                      <td>{r.plan_code}</td>
                      <td>{money(r.amount / 100, r.currency)}</td>
                      <td>
                        {date(r.period_start)} – {date(r.period_end)}
                      </td>
                      <td>
                        {r.payment_id}
                        {r.invoice_url && (
                          <a
                            className="text-link"
                            href={r.invoice_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open Razorpay invoice
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No verified subscription payments yet.</p>
          )}
        </Section>
      )}
      <Modal
        open={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        title={
          confirm === "cancel"
            ? "Cancel your subscription?"
            : "Schedule a plan change?"
        }
        description="Your existing paid access lasts until the paid period ends."
      >
        <p>
          {confirm === "cancel" || confirm === "free"
            ? "Renewal will stop and Free-plan limits will apply at expiry."
            : "The selected plan will apply at the next billing period after its payment is verified. Paid-plan changes are scheduled at period end, without an extra mid-cycle charge. Razorpay may restrict changes for some payment methods; any restriction will be shown before the CRM changes your plan."}
        </p>
        <p>
          Any customer records over the new limits become view-only for seven
          days. The newest excess records are then permanently deleted. Other
          records and login accounts are retained. Cancellation does not
          automatically issue a refund.
        </p>
        {error && <ErrorMessage error={error} />}
        <div className="form-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            Keep current plan
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  billingRequest(
                    confirm === "cancel" || confirm === "free"
                      ? "cancel"
                      : "change-plan",
                    org!.id,
                    { plan: confirm },
                  ),
                "Subscription change scheduled",
              )
            }
          >
            {busy ? "Saving…" : "Confirm change"}
          </button>
        </div>
      </Modal>
    </>
  );
}
