import { createClient } from "@supabase/supabase-js";
import { appUrl, digestEmail, planEndingEmail } from "./core.ts";

type Item = {
  id: string;
  kind: "follow_up_digest" | "plan_ending";
  payload: Record<string, any>;
  email: string | null;
  name: string | null;
};

// Called only by the scheduler (pg_cron through pg_net) with the private
// credential from Vault. Sends whatever is queued, a batch at a time.
export function createNotificationsHandler(
  env: (key: string) => string,
  pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  const admin = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
    try {
      const token = req.headers.get("x-align-notifications-job") || "";
      const { data: valid, error: tokenError } = await admin.rpc(
        "notifications_validate_job_token",
        { token },
      );
      if (tokenError || valid !== true)
        return reply({ error: "Invalid scheduler credential" }, 401);
      const key = env("RESEND_API_KEY");
      // Leave the queue untouched so nothing is lost while email is not set up.
      if (!key) return reply({ error: "RESEND_API_KEY is not set" }, 503);
      const url = appUrl(env("APP_URL"), env("SECURITY_ALLOWED_ORIGINS"));
      const from = `"Align" <${env("NOTIFICATIONS_FROM_EMAIL") || env("PROPOSAL_FROM_EMAIL") || "onboarding@resend.dev"}>`;
      const { data, error } = await admin.rpc("notifications_claim", { batch: 25 });
      if (error) return reply({ error: "Could not read the queue" }, 500);
      const items = (data || []) as Item[];
      let sent = 0,
        failed = 0,
        retry = 0;
      for (const [i, item] of items.entries()) {
        // Resend allows about two requests a second on the free plan.
        if (i > 0) await pause(600);
        const finish = (args: Record<string, unknown>) =>
          admin.rpc("notifications_finish", { item: item.id, ...args });
        if (!item.email) {
          await finish({
            delivered: false,
            failure: "Recipient has no email address",
            permanent: true,
          });
          failed++;
          continue;
        }
        const p = item.payload || {};
        const mail =
          item.kind === "plan_ending"
            ? planEndingEmail({
                name: item.name || "",
                org: p.org_name || "your workspace",
                plan: p.plan || "paid",
                paidUntil: p.paid_until,
                timezone: p.timezone || "Asia/Kolkata",
                cancelling: !!p.cancelling,
                url,
              })
            : digestEmail({
                name: item.name || "",
                org: p.org_name || "your workspace",
                items: Array.isArray(p.items) ? p.items : [],
                url,
              });
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              // The same queued email can never be delivered twice.
              "Idempotency-Key": item.id,
            },
            body: JSON.stringify({
              from,
              to: [item.email],
              subject: mail.subject,
              html: mail.html,
              text: mail.text,
            }),
            signal: AbortSignal.timeout(10000),
          });
          const out = await res.json().catch(() => ({}));
          if (res.ok && typeof out.id === "string") {
            await finish({ delivered: true, provider: out.id });
            sent++;
          } else {
            // 4xx means Resend refused this email for good (bad address,
            // test-mode recipient...); 429 and 5xx are worth retrying.
            const permanent =
              res.status >= 400 && res.status < 500 && res.status !== 429;
            await finish({
              delivered: false,
              failure:
                typeof out.message === "string"
                  ? out.message.slice(0, 300)
                  : `Email provider answered ${res.status}`,
              permanent,
            });
            if (permanent) failed++;
            else retry++;
          }
        } catch {
          await finish({ delivered: false, failure: "Email provider did not respond" });
          retry++;
        }
      }
      return reply({ processed: items.length, sent, failed, retry });
    } catch {
      return reply({ error: "Notification sender failed" }, 500);
    }
  };
}
