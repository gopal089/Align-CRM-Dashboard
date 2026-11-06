import { createClient } from "@supabase/supabase-js";
import {
  appUrl,
  authUrl,
  digest,
  emailFromIdToken,
  newToken,
  SCOPE_EVENTS,
  simplifyEvent,
  taskEvent,
  type PlannedTask,
} from "./core.ts";

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TOKEN = "https://oauth2.googleapis.com/token";
const safeMessages = [
  "Verify your account",
  "Workspace access required",
  "Invalid connection request",
  "This connection request expired",
  "Google did not grant offline access",
];
type Connection = { id: string; org_id: string; user_id: string; email: string; sync_token: string | null };

// One function for the whole Google flow:
//   POST connect / sync_now / disconnect  - a signed-in member, from the app
//   GET  ?code&state                      - Google sending the member back
//   POST sync                             - the scheduler, with the Vault credential
export function createCalendarHandler(env: (key: string) => string) {
  const url = env("SUPABASE_URL"),
    anon = env("SUPABASE_ANON_KEY");
  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const origins = new Set(env("SECURITY_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean));
  const redirectUri = env("GOOGLE_REDIRECT_URI") || `${url}/functions/v1/calendar-google`;
  const app = appUrl(env("APP_URL"), env("SECURITY_ALLOWED_ORIGINS"));
  class Failure extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  }
  const generic = "Calendar service failed. Try again.";
  async function rpc(client: any, name: string, args: Record<string, unknown>) {
    const { data, error } = await client.rpc(name, args);
    if (error)
      throw new Failure(safeMessages.some((m) => error.message?.includes(m)) ? error.message : generic, 400);
    return data;
  }
  const form = (body: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10000),
  });
  async function refreshAccess(refresh: string | null): Promise<string | null> {
    if (!refresh) return null;
    const res = await fetch(TOKEN, form({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: refresh,
      grant_type: "refresh_token",
    }));
    const out = await res.json().catch(() => ({}));
    if (res.ok && typeof out.access_token === "string") return out.access_token;
    // Expired test-mode grants and removed access both come back as invalid_grant.
    if (out.error === "invalid_grant") return null;
    throw new Error(`Google sign-in check failed (${res.status})`);
  }
  const google = (token: string, target: string, init: RequestInit = {}) =>
    fetch(target, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

  async function sync(c: Connection) {
    const result = { pushed: 0, removed: 0, imported: 0, error: null as string | null };
    try {
      const token = await refreshAccess(await rpc(admin, "calendar_refresh_token", { conn: c.id }));
      if (!token) {
        await rpc(admin, "calendar_finish", {
          conn: c.id,
          new_sync_token: null,
          failure: "Google access ended. Test-mode connections last 7 days, or access was removed. Reconnect in Settings.",
          reconnect: true,
        });
        result.error = "reconnect";
        return result;
      }
      // Align -> Google: create, update or remove only what changed.
      const plan = await rpc(admin, "calendar_plan", { conn: c.id, max_ops: 50 });
      const done: Record<string, unknown>[] = [];
      for (const t of plan.upsert as PlannedTask[]) {
        const body = JSON.stringify(taskEvent(t, app, plan.org));
        let res = await google(token, EVENTS, { method: "POST", body });
        // The event ID is fixed per task, so "already exists" means update it
        // (this also restores an event that was deleted earlier).
        if (res.status === 409) res = await google(token, `${EVENTS}/${t.event_id}`, { method: "PUT", body });
        if (res.ok) {
          done.push({ task: t.task, fingerprint: t.fingerprint });
          result.pushed++;
        } else if (res.status === 403 || res.status === 429) break;
      }
      for (const r of plan.remove as { task: string; event_id: string }[]) {
        const res = await google(token, `${EVENTS}/${r.event_id}`, { method: "DELETE" });
        if (res.ok || res.status === 404 || res.status === 410) {
          done.push({ task: r.task, removed: true });
          result.removed++;
        } else if (res.status === 403 || res.status === 429) break;
      }
      if (done.length) await rpc(admin, "calendar_record_push", { conn: c.id, done });

      // Google -> Align: only changes since last time, via Google's sync token.
      let pageToken = "",
        next: string | null = null;
      for (let page = 0; page < 4; page++) {
        const q = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
        if (c.sync_token) q.set("syncToken", c.sync_token);
        else q.set("timeMin", new Date(Date.now() - 30 * 86400000).toISOString());
        if (pageToken) q.set("pageToken", pageToken);
        const res = await google(token, `${EVENTS}?${q}`);
        if (res.status === 410) {
          // Google expired the sync token; start fresh on the next run.
          await rpc(admin, "calendar_reset_sync", { conn: c.id });
          break;
        }
        if (!res.ok) throw new Error(`Google Calendar answered ${res.status}`);
        const out = await res.json();
        for (const e of out.items || []) {
          if ((await rpc(admin, "calendar_apply_event", { conn: c.id, ev: simplifyEvent(e) })) === "created")
            result.imported++;
        }
        if (out.nextPageToken) {
          pageToken = out.nextPageToken;
          continue;
        }
        next = out.nextSyncToken || null;
        break;
      }
      await rpc(admin, "calendar_finish", { conn: c.id, new_sync_token: next, failure: null, reconnect: false });
    } catch (e) {
      result.error = ((e as Error).message || generic).slice(0, 300);
      await admin.rpc("calendar_finish", { conn: c.id, new_sync_token: null, failure: result.error, reconnect: false });
    }
    return result;
  }

  async function callback(req: Request) {
    const q = new URL(req.url).searchParams;
    const text = (message: string) =>
      new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const state = q.get("state") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return text("This link is not valid. Start again from Settings in Align.");
    let s: { org_id: string; user_id: string; return_to: string };
    try {
      s = await rpc(admin, "calendar_take_state", { state_hash: await digest(state) });
    } catch (e) {
      return text((e as Error).message);
    }
    const back = (outcome: string) =>
      new Response(null, {
        status: 302,
        headers: { Location: `${s.return_to}/settings?tab=calendar&google=${outcome}` },
      });
    if (q.get("error")) return back("denied");
    const code = q.get("code");
    if (!code) return back("failed");
    const res = await fetch(TOKEN, form({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }));
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return back("failed");
    // Google lets people untick the calendar box on the consent screen.
    if (!String(out.scope || "").split(" ").includes(SCOPE_EVENTS)) return back("missing_permission");
    try {
      await rpc(admin, "calendar_save_connection", {
        o: s.org_id,
        u: s.user_id,
        email: emailFromIdToken(out.id_token),
        refresh_token: out.refresh_token || "",
      });
      const c = await rpc(admin, "calendar_connection", { o: s.org_id, u: s.user_id });
      await sync(c);
    } catch {
      return back("failed");
    }
    return back("connected");
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "GET") return callback(req);
    const origin = req.headers.get("origin") || "";
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "Access-Control-Allow-Origin": origins.has(origin) ? origin : "",
      "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-client-info",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    };
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (origin && !origins.has(origin)) return reply({ error: "Origin is not allowed" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
    try {
      const raw = await req.text();
      if (raw.length > 8192) throw new Failure("Request too large", 413);
      const p = raw ? JSON.parse(raw) : {};
      const action = typeof p.action === "string" ? p.action : "";

      if (action === "sync") {
        const token = req.headers.get("x-align-calendar-job") || "";
        if ((await rpc(admin, "calendar_validate_job_token", { token })) !== true)
          throw new Failure("Invalid scheduler credential", 401);
        const due = (await rpc(admin, "calendar_connections_due", { max_rows: 20 })) as Connection[];
        const results = [];
        for (const c of due) results.push(await sync(c));
        return reply({ connections: due.length, results });
      }

      const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      const { data: { user }, error: authError } = await admin.auth.getUser(jwt);
      if (authError || !user) throw new Failure("Sign in again", 401);
      const db = createClient(url, anon, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const org = typeof p.org_id === "string" && /^[0-9a-f-]{36}$/i.test(p.org_id) ? p.org_id : "";
      if (!org) throw new Failure("Choose a workspace");
      const limited = async (bucket: string, max: number) => {
        if ((await rpc(admin, "security_rate_limit", { b: bucket, max_attempts: max })) !== true)
          throw new Failure("Too many requests. Try again in 15 minutes.", 429);
      };

      if (action === "connect") {
        if (!env("GOOGLE_CLIENT_ID") || !env("GOOGLE_CLIENT_SECRET"))
          throw new Failure("Google Calendar is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the Edge Function secrets.", 503);
        if (!origin) throw new Failure("Connect from the Align app");
        await limited("calendar-connect:" + user.id, 10);
        const state = newToken();
        await rpc(db, "calendar_begin_connect", { o: org, state_hash: await digest(state), return_to: origin });
        return reply({ url: authUrl({ clientId: env("GOOGLE_CLIENT_ID"), redirectUri, state }) });
      }
      // The member must belong to the workspace; calendar_status checks that.
      await rpc(db, "calendar_status", { o: org });

      if (action === "sync_now") {
        await limited("calendar-sync:" + user.id, 6);
        const c = await rpc(admin, "calendar_connection", { o: org, u: user.id });
        if (!c) throw new Failure("Connect Google Calendar first", 404);
        return reply(await sync(c));
      }
      if (action === "disconnect") {
        const out = await rpc(admin, "calendar_detach", { o: org, u: user.id });
        let removed = 0;
        if (out?.refresh_token) {
          // Best effort: take Align's events out of the calendar, then give the
          // permission back to Google. The connection is already gone either way.
          try {
            const token = await refreshAccess(out.refresh_token);
            if (token)
              for (const id of (out.events || []).slice(0, 200)) {
                const res = await google(token, `${EVENTS}/${id}`, { method: "DELETE" });
                if (res.ok || res.status === 404 || res.status === 410) removed++;
              }
            await fetch(TOKEN.replace("/token", "/revoke"), form({ token: out.refresh_token }));
          } catch {
            /* already disconnected in Align */
          }
        }
        return reply({ ok: true, removed });
      }
      throw new Failure("Unknown action");
    } catch (e) {
      if (e instanceof Failure) return reply({ error: e.message }, e.status);
      if (e instanceof SyntaxError) return reply({ error: "Invalid request" }, 400);
      return reply({ error: generic }, 500);
    }
  };
}
