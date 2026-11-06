import { createClient } from "@supabase/supabase-js";
import {
  deviceLabel,
  digest,
  displayName,
  newToken,
  optional,
  proposalEmail,
  text,
  tokenPattern,
} from "./core.ts";

// Messages the database raises on purpose. Anything else is hidden behind a
// generic message so internal details never reach the browser.
const safeMessages = [
  "Verify your account",
  "Proposal not found",
  "Only the proposal owner",
  "Restore this proposal",
  "This proposal is closed",
  "Invalid proposal link",
  "Enter a valid recipient email",
  "Enter a subject",
  "Name or message is too long",
  "This workspace has sent 50",
  "Unknown proposal send",
  "This proposal link",
];

export function createProposalHandler(env: (key: string) => string) {
  const url = env("SUPABASE_URL"),
    anon = env("SUPABASE_ANON_KEY");
  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const origins = new Set(
    env("SECURITY_ALLOWED_ORIGINS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  class Failure extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  }
  function fromDatabase(
    error: { message?: string } | null,
    status = 400,
  ): never {
    const message = error?.message || "";
    if (safeMessages.some((m) => message.includes(m)))
      throw new Failure(message, status);
    throw new Failure("Proposal service failed. Try again.", 500);
  }
  async function limited(bucket: string, max: number) {
    const { data, error } = await admin.rpc("security_rate_limit", {
      b: bucket,
      max_attempts: max,
    });
    if (error) throw new Failure("Proposal service failed. Try again.", 500);
    if (!data)
      throw new Failure("Too many requests. Try again in 15 minutes.", 429);
  }
  const bearer = (req: Request) =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin") || "";
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "Access-Control-Allow-Origin": origins.has(origin) ? origin : "",
      "Access-Control-Allow-Headers":
        "authorization,apikey,content-type,x-client-info",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    };
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (origin && !origins.has(origin))
      return reply({ error: "Origin is not allowed" }, 403);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
    try {
      const raw = await req.text();
      if (!raw || raw.length > 16384)
        throw new Failure("Request missing or too large", 413);
      const p = JSON.parse(raw);
      const action = text(p.action, 20);

      // The client's page. No sign-in: holding the link is the permission.
      if (action === "open") {
        const token = typeof p.token === "string" ? p.token : "";
        if (!tokenPattern.test(token))
          throw new Failure("This proposal link is not valid", 404);
        const ip =
          (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
          "unknown";
        await limited("proposal-open:" + (await digest(ip)), 60);
        // A colleague signed in to the same workspace is not counted as the client.
        let viewer: string | null = null;
        const jwt = bearer(req);
        if (jwt && jwt !== anon) {
          const { data } = await admin.auth
            .getUser(jwt)
            .catch(() => ({ data: { user: null } }));
          viewer = data?.user?.id || null;
        }
        const { data, error } = await admin.rpc("proposal_open", {
          link_hash: await digest(token),
          device: deviceLabel(req.headers.get("user-agent") || ""),
          viewer,
        });
        if (error)
          fromDatabase(
            error,
            /withdrawn|expired/.test(error.message || "") ? 410 : 404,
          );
        return reply(data);
      }

      // Everything else is done by a signed-in member, as that member.
      const jwt = bearer(req);
      const {
        data: { user },
        error: authError,
      } = await admin.auth.getUser(jwt);
      if (authError || !user) throw new Failure("Sign in again", 401);
      const db = createClient(url, anon, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      if (action === "send") {
        if (!origin)
          throw new Failure("Send proposals from the Align app", 400);
        const key = env("RESEND_API_KEY");
        if (!key)
          throw new Failure(
            "Email sending is not set up yet. Add RESEND_API_KEY to the Edge Function secrets.",
            503,
          );
        await limited("proposal-send:" + user.id, 20);
        const token = newToken();
        const { data: started, error } = await db.rpc("proposal_begin", {
          pitch: text(p.pitch_id, 36),
          to_email: text(p.to_email, 254),
          to_name: optional(p.to_name, 200),
          title: text(p.subject, 200),
          body: optional(p.message, 5000),
          link_hash: await digest(token),
        });
        if (error) fromDatabase(error);
        // The token sits after "#", so browsers never send it to any server
        // or include it in referrer headers.
        const link = `${origin}/proposal#${token}`;
        const mail = proposalEmail({
          toName: started.to_name,
          message: started.message,
          link,
          sender: started.sender,
          org: started.org_name,
          expiresAt: started.expires_at,
        });
        let delivered = false,
          provider: string | null = null,
          failure = "";
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              // A retry of the same send can never deliver two emails.
              "Idempotency-Key": started.id,
            },
            body: JSON.stringify({
              from: `"${displayName(started.sender || started.org_name)} via Align" <${env("PROPOSAL_FROM_EMAIL") || "onboarding@resend.dev"}>`,
              to: [started.to_email],
              subject: started.subject,
              html: mail.html,
              text: mail.text,
              ...(started.reply_to ? { reply_to: started.reply_to } : {}),
            }),
            signal: AbortSignal.timeout(15000),
          });
          const out = await res.json().catch(() => ({}));
          if (res.ok && typeof out.id === "string") {
            delivered = true;
            provider = out.id;
          } else
            failure =
              typeof out.message === "string"
                ? out.message.slice(0, 300)
                : `Email provider answered ${res.status}`;
        } catch {
          failure = "Email provider did not respond";
        }
        const { error: finishError } = await db.rpc("proposal_finish", {
          send: started.id,
          delivered,
          provider,
          failure: failure || null,
        });
        if (finishError) fromDatabase(finishError);
        if (!delivered) throw new Failure(`Email not sent: ${failure}`, 502);
        return reply({ id: started.id, status: "sent" });
      }

      if (action === "revoke") {
        const { error } = await db.rpc("proposal_revoke", {
          send: text(p.send_id, 36),
        });
        if (error) fromDatabase(error);
        return reply({ ok: true });
      }
      throw new Failure("Unknown action");
    } catch (e) {
      if (e instanceof Failure) return reply({ error: e.message }, e.status);
      if (e instanceof SyntaxError || (e as Error).message === "Invalid input")
        return reply({ error: "Invalid request" }, 400);
      return reply({ error: "Proposal service failed. Try again." }, 500);
    }
  };
}
