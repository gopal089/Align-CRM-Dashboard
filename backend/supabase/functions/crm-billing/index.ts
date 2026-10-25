import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  validSignature,
  validateProviderPlan,
  verifiedReceipt,
  subscriptionFromEvent,
} from "./core.ts";
import type { Entity, Plan } from "./core.ts";

const env = (name: string) => Deno.env.get(name) || "";
const allowedOrigins = new Set(
  (
    env("BILLING_ALLOWED_ORIGINS") ||
    "https://align-crm-dashboard.onrender.com,http://127.0.0.1:5173"
  )
    .split(",")
    .map((s) => s.trim()),
);
const keyId = env("RAZORPAY_KEY_ID"),
  secret = env("RAZORPAY_KEY_SECRET");
const mode = env("RAZORPAY_MODE") || "test";
const testOrganizations = new Set(
  env("RAZORPAY_TEST_ORG_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const planIds: Record<string, string> = {
  starter: env("RAZORPAY_STARTER_PLAN_ID"),
  business: env("RAZORPAY_BUSINESS_PLAN_ID"),
};
const configured = Boolean(
  keyId &&
  secret &&
  env("RAZORPAY_WEBHOOK_SECRET") &&
  planIds.starter &&
  planIds.business &&
  keyId.startsWith(`rzp_${mode}_`) &&
  ["test", "live"].includes(mode),
);
const backend = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const headers = (origin: string | null) => ({
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  Vary: "Origin",
  ...(origin && allowedOrigins.has(origin)
    ? { "Access-Control-Allow-Origin": origin }
    : {}),
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
});
class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function razorpay(path: string, method = "GET", body?: Entity) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${keyId}:${secret}`)}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ProviderError(
      result.error?.description ||
        "Razorpay request failed. Try again from Billing.",
      response.status,
    );
  return result as Entity;
}
async function checked<T>(promise: PromiseLike<{ data: T; error: any }>) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}
async function state(org: string) {
  return await checked(
    backend
      .from("organization_subscriptions")
      .select("*")
      .eq("org_id", org)
      .single(),
  );
}
async function plans(): Promise<Plan[]> {
  return (
    (await checked(
      backend
        .from("subscription_plans")
        .select("code,name,monthly_price,currency")
        .gt("monthly_price", 0),
    )) || []
  );
}
async function canonicalSync(
  org: string,
  eventId?: string,
  eventType = "sync",
  suppliedPayment?: string,
) {
  const current = await state(org);
  if (!current.provider_subscription_id) return { paid: false };
  const id = current.provider_subscription_id;
  const sub = await razorpay(`/subscriptions/${encodeURIComponent(id)}`);
  const localPlans = await plans();
  const local = localPlans.find((p) => planIds[p.code] === sub.plan_id);
  if (!local)
    throw new Error(
      "The subscription has an unrecognized Align plan. Reconciliation is paused.",
    );
  validateProviderPlan(
    await razorpay(`/plans/${encodeURIComponent(sub.plan_id)}`),
    local,
  );
  let receipt: Entity | null = null;
  if (suppliedPayment) {
    const payment = await razorpay(
      `/payments/${encodeURIComponent(suppliedPayment)}`,
    );
    if (!payment.invoice_id)
      throw new Error(
        "Payment has no paid subscription invoice yet. Use Check payment status after capture completes.",
      );
    const invoice = await razorpay(
      `/invoices/${encodeURIComponent(payment.invoice_id)}`,
    );
    receipt = verifiedReceipt(sub, invoice, payment, local);
  } else {
    // Pagination prevents an older invoice from hiding the latest verified paid period.
    let latest: Entity | null = null;
    for (let page = 0; page < 20; page++) {
      const list = await razorpay(
        `/invoices?subscription_id=${encodeURIComponent(id)}&count=100&skip=${page * 100}`,
      );
      for (const inv of list.items || [])
        if (
          inv.status === "paid" &&
          inv.payment_id &&
          Number.isSafeInteger(inv.billing_end) &&
          (!latest || inv.billing_end > latest.billing_end)
        )
          latest = inv;
      if ((list.items || []).length < 100) break;
      if (page === 19)
        throw new Error(
          "Invoice history is too large to reconcile safely. Contact the platform administrator.",
        );
    }
    if (latest) {
      const payment = await razorpay(
        `/payments/${encodeURIComponent(latest.payment_id)}`,
      );
      // Following a scheduled plan change, an old paid invoice can belong to the previous price.
      // It cannot grant the new plan; preserve the already-verified paid period instead.
      if (latest.amount_paid === local.monthly_price)
        receipt = verifiedReceipt(sub, latest, payment, local);
    }
  }
  await checked(
    backend.rpc("billing_apply_receipt", {
      o: org,
      sub_id: id,
      state: { status: sub.status },
      receipt,
      event_id: eventId || null,
      event_type: eventType,
    }),
  );
  return { paid: !!receipt, subscription: sub };
}
async function webhook(req: Request, raw: string) {
  if (!configured) throw new Error("Razorpay billing is not configured.");
  if (
    !(await validSignature(
      env("RAZORPAY_WEBHOOK_SECRET"),
      raw,
      req.headers.get("x-razorpay-signature"),
    ))
  )
    return { status: 401, body: { error: "Invalid webhook signature" } };
  const event = JSON.parse(raw);
  const id = subscriptionFromEvent(event);
  if (!id) return { status: 200, body: { ignored: true } };
  const row = await checked(
    backend
      .from("organization_subscriptions")
      .select("org_id")
      .eq("provider_subscription_id", id)
      .maybeSingle(),
  );
  if (!row) return { status: 200, body: { ignored: true } };
  const eventId = req.headers.get("x-razorpay-event-id");
  if (!eventId)
    return { status: 400, body: { error: "Webhook event ID is required" } };
  // Fetch canonical provider state even on retries. Older events cannot revoke a newer paid receipt.
  await canonicalSync(row.org_id, eventId, String(event.event || "webhook"));
  return { status: 200, body: { received: true } };
}
async function maintenance(req: Request) {
  const token = req.headers.get("x-align-billing-job") || "";
  const authorized = await checked(
    backend.rpc("billing_validate_job_token", { token }),
  );
  if (!authorized)
    return { status: 401, body: { error: "Invalid maintenance credential" } };
  if (!configured)
    return {
      status: 503,
      body: {
        error:
          "Razorpay must be configured before reconciliation and deletion run.",
      },
    };
  const candidates = await checked(
    backend
      .from("organization_subscriptions")
      .select("org_id")
      .not("provider_subscription_id", "is", null)
      .order("last_verified_at", { ascending: true, nullsFirst: true })
      .limit(25),
  );
  let checkedCount = 0,
    failed = 0;
  for (const row of candidates || []) {
    try {
      await canonicalSync(row.org_id);
      await checked(
        backend.rpc("billing_process_retention", { o: row.org_id }),
      );
      checkedCount++;
    } catch {
      failed++; /* Do not delete if provider reconciliation fails. */
    }
  }
  return {
    status: failed ? 503 : 200,
    body: { checked: checkedCount, failed },
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: headers(origin) });
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
  if (origin && !allowedOrigins.has(origin))
    return reply({ error: "Origin not allowed" }, 403);
  try {
    const raw = await req.text();
    if (raw.length > 100_000)
      return reply({ error: "Request is too large" }, 413);
    const payload = JSON.parse(raw || "{}");
    if (new URL(req.url).pathname.endsWith("/webhook")) {
      const result = await webhook(req, raw);
      return reply(result.body, result.status);
    }
    if (payload.action === "maintenance") {
      const result = await maintenance(req);
      return reply(result.body, result.status);
    }
    const jwt =
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!jwt) return reply({ error: "Sign in first" }, 401);
    const {
      data: { user },
      error,
    } = await backend.auth.getUser(jwt);
    if (error || !user) return reply({ error: "Sign in first" }, 401);
    const org = String(payload.org_id || "");
    const member = await checked(
      backend
        .from("memberships")
        .select("role,active")
        .eq("org_id", org)
        .eq("user_id", user.id)
        .maybeSingle(),
    );
    if (!member?.active || member.role !== "Administrator")
      return reply({ error: "Administrator access required" }, 403);
    if (payload.action === "configuration")
      return reply({
        configured:
          configured && (mode === "live" || testOrganizations.has(org)),
        mode: configured ? mode : null,
      });
    if (!configured)
      return reply(
        {
          error:
            "Razorpay is not configured. Add the CRM’s test keys, monthly plan IDs and webhook secret in Supabase Edge Function Secrets.",
        },
        503,
      );
    if (mode === "test" && !testOrganizations.has(org))
      return reply(
        {
          error:
            "Test payments are limited to explicitly allowed test workspaces. Ask the platform owner to configure RAZORPAY_TEST_ORG_IDS.",
        },
        403,
      );
    if (payload.action === "sync") return reply(await canonicalSync(org));
    if (payload.action === "verify") {
      const current = await state(org);
      if (payload.razorpay_subscription_id !== current.provider_subscription_id)
        return reply(
          { error: "Subscription does not belong to this workspace" },
          403,
        );
      const message = `${payload.razorpay_payment_id}|${current.provider_subscription_id}`;
      if (!(await validSignature(secret, message, payload.razorpay_signature)))
        return reply({ error: "Invalid checkout signature" }, 401);
      return reply(
        await canonicalSync(
          org,
          undefined,
          "checkout.verified",
          String(payload.razorpay_payment_id),
        ),
      );
    }
    if (payload.action === "cancel") {
      await canonicalSync(org);
      const current = await state(org);
      if (!current.provider_subscription_id)
        throw new Error("No subscription to cancel.");
      const future =
        current.paid_until &&
        new Date(current.paid_until).getTime() > Date.now();
      const cancelled = await razorpay(
        `/subscriptions/${encodeURIComponent(current.provider_subscription_id)}/cancel`,
        "POST",
        { cancel_at_cycle_end: !!future },
      );
      await checked(
        backend
          .from("organization_subscriptions")
          .update({
            cancel_at_period_end: !!future,
            scheduled_plan_code: "free",
            scheduled_change_at: current.paid_until,
            provider_status: cancelled.status,
          })
          .eq("org_id", org),
      );
      return reply({ scheduled: true });
    }
    if (payload.action === "change-plan") {
      const local = (await plans()).find((p) => p.code === payload.plan);
      if (!local) throw new Error("Choose a valid paid plan.");
      validateProviderPlan(
        await razorpay(`/plans/${encodeURIComponent(planIds[local.code])}`),
        local,
      );
      await canonicalSync(org);
      const current = await state(org);
      if (
        !current.provider_subscription_id ||
        !current.paid_until ||
        new Date(current.paid_until).getTime() <= Date.now()
      )
        throw new Error(
          "Choose a new paid plan through Checkout after cancelling any old unpaid subscription.",
        );
      // End-of-cycle changes avoid an extra overlapping charge or unspecified proration.
      await razorpay(
        `/subscriptions/${encodeURIComponent(current.provider_subscription_id)}`,
        "PATCH",
        {
          plan_id: planIds[local.code],
          schedule_change_at: "cycle_end",
          customer_notify: true,
        },
      );
      await checked(
        backend
          .from("organization_subscriptions")
          .update({
            scheduled_plan_code: local.code,
            scheduled_change_at: current.paid_until,
          })
          .eq("org_id", org),
      );
      return reply({ scheduled: true });
    }
    if (payload.action === "checkout") {
      const local = (await plans()).find((p) => p.code === payload.plan);
      if (!local) throw new Error("Choose a valid paid plan.");
      validateProviderPlan(
        await razorpay(`/plans/${encodeURIComponent(planIds[local.code])}`),
        local,
      );
      let current = await state(org);
      if (current.provider_subscription_id) {
        const synced = await canonicalSync(org);
        current = await state(org);
        const provider = synced.subscription;
        if (
          current.paid_until &&
          new Date(current.paid_until).getTime() > Date.now()
        )
          throw new Error(
            "You already have paid access. Schedule a plan change for your next billing cycle.",
          );
        if (
          provider &&
          !["cancelled", "completed", "expired"].includes(provider.status)
        ) {
          if (provider.plan_id === planIds[local.code])
            return reply({
              subscription_id: provider.id,
              key_id: keyId,
              plan_name: local.name,
            });
          throw new Error(
            "Cancel the old unpaid subscription before choosing a different paid plan. This prevents duplicate recurring charges.",
          );
        }
      }
      // Reserve the checkout slot atomically; simultaneous clicks cannot create duplicate subscriptions.
      const reservation = crypto.randomUUID();
      const slot = await checked(
        backend.rpc("billing_reserve_checkout", { o: org, reservation }),
      );
      if (!slot)
        throw new Error(
          "A checkout request is already in progress. Please wait and try again.",
        );
      try {
        const subscription = await razorpay("/subscriptions", "POST", {
          plan_id: planIds[local.code],
          total_count: 120,
          quantity: 1,
          customer_notify: true,
          notes: { align_org_id: org, align_plan: local.code },
        });
        await checked(
          backend.rpc("billing_finish_checkout", {
            o: org,
            reservation,
            sub_id: subscription.id,
          }),
        );
        return reply({
          subscription_id: subscription.id,
          key_id: keyId,
          plan_name: local.name,
        });
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.status >= 400 &&
          error.status < 500
        )
          await checked(
            backend.rpc("billing_release_checkout", { o: org, reservation }),
          );
        // Leave the reservation for manual reconciliation on ambiguous provider/network failures.
        // Retrying a creation after a timeout could otherwise create a second recurring charge.
        throw error;
      }
    }
    return reply({ error: "Unknown billing action" }, 400);
  } catch (error) {
    return reply(
      {
        error:
          error instanceof Error ? error.message : "Billing request failed",
      },
      400,
    );
  }
});
