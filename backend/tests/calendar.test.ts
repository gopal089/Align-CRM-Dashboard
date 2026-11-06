import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mock.rpc, auth: { getUser: mock.getUser } }),
}));
import { buildFeed, fold, icsText } from "../supabase/functions/calendar-feed/core";
import { createFeedHandler } from "../supabase/functions/calendar-feed/handler";
import {
  authUrl,
  digest,
  emailFromIdToken,
  simplifyEvent,
  taskEvent,
} from "../supabase/functions/calendar-google/core";
import { createCalendarHandler } from "../supabase/functions/calendar-google/handler";

const app = "https://app.test.invalid";
const env: Record<string, string> = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "public-test",
  SUPABASE_SERVICE_ROLE_KEY: "server-test",
  SECURITY_ALLOWED_ORIGINS: app,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
};
const org = crypto.randomUUID(),
  uid = crypto.randomUUID(),
  conn = crypto.randomUUID(),
  taskId = "11111111-2222-3333-4444-555555555555";
const planned = {
  task: taskId,
  event_id: "align11111111222233334444555555555555",
  name: "Call, Acme; today",
  due: "2026-11-10",
  priority: "High",
  description: "Line 1\nLine 2",
  fingerprint: "fp1",
};
let rpcData: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
const rpcArgs = (name: string) => mock.rpc.mock.calls.filter(([n]) => n === name).map(([, a]) => a);
beforeEach(() => {
  vi.resetAllMocks();
  env.GOOGLE_CLIENT_ID = "client-id";
  rpcData = {
    security_rate_limit: true,
    calendar_validate_job_token: true,
    calendar_status: {},
    calendar_refresh_token: "refresh-1",
    calendar_plan: { org: "Acme", upsert: [planned], remove: [{ task: "t-old", event_id: "alignold" }] },
    calendar_connection: { id: conn, org_id: org, user_id: uid, email: "me@gmail.com", sync_token: "sync-1" },
    calendar_connections_due: [{ id: conn, org_id: org, user_id: uid, email: "me@gmail.com", sync_token: null }],
    calendar_take_state: { org_id: org, user_id: uid, return_to: app },
    calendar_apply_event: "created",
    calendar_detach: { refresh_token: "refresh-1", events: ["align1", "align2"] },
  };
  mock.rpc.mockImplementation(async (name: string) => ({ data: rpcData[name] ?? null, error: null }));
  mock.getUser.mockResolvedValue({ data: { user: { id: uid } }, error: null });
  fetchMock = vi.fn(async (target: string, init: any = {}) => {
    if (target.endsWith("/token") && String(init.body).includes("refresh_token"))
      return new Response(JSON.stringify({ access_token: "access-1" }), { status: 200 });
    if (target.endsWith("/token"))
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "refresh-new",
          scope: "openid email https://www.googleapis.com/auth/calendar.events",
          id_token: "h." + btoa(JSON.stringify({ email: "me@gmail.com" })) + ".s",
        }),
        { status: 200 },
      );
    if (target.endsWith("/revoke")) return new Response("", { status: 200 });
    if (init.method === "POST") return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify({
        items: [
          { id: "m1", start: { dateTime: "2026-11-20T10:00:00Z" }, attendees: [{ email: "client@acme.test" }] },
          { id: "t1", start: { date: "2026-11-10" }, extendedProperties: { private: { alignTask: "x" } } },
        ],
        nextSyncToken: "sync-2",
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  createCalendarHandler((k) => env[k] || "")(
    new Request("https://proj.supabase.co/functions/v1/calendar-google", {
      method: "POST",
      headers: { Origin: app, Authorization: "Bearer member-jwt", ...headers },
      body: JSON.stringify(body),
    }),
  );

describe("calendar feed format", () => {
  it("escapes text and folds long lines without breaking characters", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = "SUMMARY:" + "é".repeat(60);
    const folded = fold(long);
    for (const line of folded.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
  it("writes each task as an all-day event with a link back to Align", () => {
    const ics = buildFeed({
      org: "Acme",
      appUrl: app,
      now: new Date("2026-11-06T10:00:00Z"),
      tasks: [{ id: taskId, name: "Call, Acme", due: "2026-11-30", priority: "High", description: null, updated_at: "2026-11-06T09:00:00Z" }],
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261130\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261201\r\n");
    expect(ics).toContain("SUMMARY:Call\\, Acme\r\n");
    expect(ics).toContain(`URL:${app}/tasks/${taskId}`);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });
});

describe("calendar feed endpoint", () => {
  const get = (token: string) =>
    createFeedHandler((k) => env[k] || "")(
      new Request(`https://proj.supabase.co/functions/v1/calendar-feed?token=${token}`),
    );
  it("serves the feed for a valid link and looks it up by hash", async () => {
    rpcData.calendar_feed = { org: "Acme", tasks: [] };
    const token = "a".repeat(64);
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    expect(rpcArgs("calendar_feed")[0]).toEqual({ link_hash: await digest(token) });
  });
  it("rejects malformed and unknown links", async () => {
    expect((await get("nope")).status).toBe(404);
    mock.rpc.mockImplementation(async (name: string) =>
      name === "security_rate_limit" ? { data: true, error: null } : { data: null, error: { message: "not valid" } },
    );
    expect((await get("b".repeat(64))).status).toBe(404);
  });
});

describe("Google helpers", () => {
  it("asks Google for offline calendar-event access only", () => {
    const u = new URL(authUrl({ clientId: "c", redirectUri: "https://r", state: "s" }));
    expect(u.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.events");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });
  it("turns a task into a tagged, free, all-day event", () => {
    const e = taskEvent(planned, app, "Acme");
    expect(e).toMatchObject({
      id: planned.event_id,
      start: { date: "2026-11-10" },
      end: { date: "2026-11-11" },
      transparency: "transparent",
      extendedProperties: { private: { alignTask: taskId } },
    });
  });
  it("keeps only timed meetings' details and spots Align's own events", () => {
    expect(simplifyEvent({ id: "1", start: { date: "2026-11-10" }, attendees: [{ email: "a@b.c" }] }).start).toBeNull();
    const s = simplifyEvent({ id: "2", status: "cancelled", organizer: { email: "o@x.y" }, extendedProperties: { private: { alignTask: "t" } } });
    expect(s).toMatchObject({ status: "cancelled", guests: ["o@x.y"], align: true });
    expect(emailFromIdToken("h." + btoa(JSON.stringify({ email: "me@gmail.com" })) + ".s")).toBe("me@gmail.com");
    expect(emailFromIdToken("garbage")).toBe("");
  });
});

describe("Google connection flow", () => {
  it("starts a connection with a one-time state tied to the member", async () => {
    const res = await post({ action: "connect", org_id: org });
    const { url } = await res.json();
    const state = new URL(url).searchParams.get("state")!;
    expect(rpcArgs("calendar_begin_connect")[0]).toEqual({ o: org, state_hash: await digest(state), return_to: app });
    expect(new URL(url).searchParams.get("redirect_uri")).toBe("https://proj.supabase.co/functions/v1/calendar-google");
  });
  it("explains when Google is not set up yet", async () => {
    env.GOOGLE_CLIENT_ID = "";
    const res = await post({ action: "connect", org_id: org });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("GOOGLE_CLIENT_ID");
  });
  it("stores the grant from Google's redirect and sends the member back", async () => {
    const res = await createCalendarHandler((k) => env[k] || "")(
      new Request(`https://proj.supabase.co/functions/v1/calendar-google?code=abc&state=${"s".repeat(43)}`),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${app}/settings?tab=calendar&google=connected`);
    expect(rpcArgs("calendar_save_connection")[0]).toEqual({ o: org, u: uid, email: "me@gmail.com", refresh_token: "refresh-new" });
  });
  it("sends the member back with a reason when they refuse or untick calendar access", async () => {
    const handler = createCalendarHandler((k) => env[k] || "");
    let res = await handler(new Request(`https://x/f?error=access_denied&state=${"s".repeat(43)}`));
    expect(res.headers.get("Location")).toContain("google=denied");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: "r", scope: "openid email" }), { status: 200 }));
    res = await handler(new Request(`https://x/f?code=abc&state=${"s".repeat(43)}`));
    expect(res.headers.get("Location")).toContain("google=missing_permission");
    expect(rpcArgs("calendar_save_connection")).toHaveLength(0);
  });
});

describe("two-way sync", () => {
  it("pushes changed tasks, removes finished ones and imports client meetings", async () => {
    const res = await post({ action: "sync" }, { "x-align-calendar-job": "x".repeat(64) });
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ pushed: 1, removed: 1, imported: 2, error: null });
    const created = fetchMock.mock.calls.find(([, i]) => i?.method === "POST" && !String(i.body).includes("grant_type"));
    expect(JSON.parse(created![1].body).id).toBe(planned.event_id);
    expect(rpcArgs("calendar_record_push")[0].done).toEqual([
      { task: taskId, fingerprint: "fp1" },
      { task: "t-old", removed: true },
    ]);
    expect(rpcArgs("calendar_apply_event")[1].ev.align).toBe(true);
    expect(rpcArgs("calendar_finish").at(-1)).toMatchObject({ new_sync_token: "sync-2", failure: null });
  });
  it("updates an event that already exists instead of making a second one", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 }));
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 409 }));
    await post({ action: "sync_now", org_id: org });
    const put = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(put![0]).toContain(`/events/${planned.event_id}`);
  });
  it("asks the member to reconnect when Google has ended access", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const res = await post({ action: "sync_now", org_id: org });
    expect((await res.json()).error).toBe("reconnect");
    expect(rpcArgs("calendar_finish")[0]).toMatchObject({ reconnect: true });
  });
  it("refuses the scheduler action without the Vault credential", async () => {
    rpcData.calendar_validate_job_token = false;
    expect((await post({ action: "sync" })).status).toBe(401);
  });
  it("disconnects, tidies Align's events and returns the permission to Google", async () => {
    const res = await post({ action: "disconnect", org_id: org });
    expect(await res.json()).toEqual({ ok: true, removed: 2 });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/revoke"))).toBe(true);
  });
});
