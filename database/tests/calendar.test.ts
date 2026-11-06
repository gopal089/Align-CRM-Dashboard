import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const owner = "50000000-0000-0000-0000-000000000001",
  rep = "50000000-0000-0000-0000-000000000002",
  outsider = "50000000-0000-0000-0000-000000000003";
let org: string, conn: string;
async function user(id: string) {
  await db.exec(
    `reset role; insert into auth.sessions(id,user_id) values('${id}','${id}') on conflict do nothing; insert into private.security_sessions(session_id,user_id) values('${id}','${id}') on conflict do nothing; select set_config('request.jwt.claims','{"session_id":"${id}"}',false)`,
  );
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false)`,
  );
}
async function server() {
  await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)");
}
async function rows(sql: string, params: any[] = []) {
  return (await db.query<any>(sql, params)).rows;
}
const one = async (sql: string, params: any[] = []) => (await rows(sql, params))[0]?.v;
const hash = async (token: string) => {
  await server();
  return one("select private.calendar_hash($1) v", [token]);
};
async function task(name: string, due = "current_date+1", status = "Open", who = owner) {
  await user(owner);
  return one(
    `insert into public.tasks(org_id,owner_id,name,due_date,status) values($1,$2,$3,${due},$4) returning id v`,
    [org, who, name, status],
  );
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${owner}','owner@test.invalid'),('${rep}','rep@test.invalid'),('${outsider}','out@test.invalid');`,
  );
  for (const m of readdirSync("database/supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
    await db.exec(readFileSync(`database/supabase/migrations/${m}`, "utf8"));
  await user(owner);
  org = await one("select public.create_workspace('TEST ONLY Calendar','Owner') v");
  await rows("select public.manage_member($1,'rep@test.invalid','Sales Representative')", [org]);
  await user(outsider);
  await rows("select public.create_workspace('TEST ONLY Elsewhere','Out')");
}, 30000);
afterAll(async () => await db.close());

describe("calendar subscribe link", () => {
  it("lists only the member's own open, dated tasks", async () => {
    const mine = await task("Call Acme");
    await task("Done already", "current_date", "Completed");
    await task("Rep's task", "current_date", "Open", rep);
    await task("Far future", "current_date+800");
    await user(owner);
    const token = await one("select public.calendar_new_feed($1) v", [org]);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    await server();
    const feed = await one("select public.calendar_feed($1) v", [await hash(token)]);
    expect(feed.org).toBe("TEST ONLY Calendar");
    expect(feed.tasks.map((t: any) => t.id)).toEqual([mine]);
    expect(
      await one("select last_used_at is not null v from private.calendar_feeds where user_id=$1", [owner]),
    ).toBe(true);
  });
  it("stops the old link working when a new one is made, or the member leaves", async () => {
    await user(owner);
    const old = await one("select public.calendar_new_feed($1) v", [org]);
    const fresh = await one("select public.calendar_new_feed($1) v", [org]);
    await server();
    await expect(rows("select public.calendar_feed($1)", [await hash(old)])).rejects.toThrow("not valid");
    await user(rep);
    const repToken = await one("select public.calendar_new_feed($1) v", [org]);
    await server();
    await rows("update public.memberships set active=false where org_id=$1 and user_id=$2", [org, rep]);
    await expect(rows("select public.calendar_feed($1)", [await hash(repToken)])).rejects.toThrow("not valid");
    await rows("update public.memberships set active=true where org_id=$1 and user_id=$2", [org, rep]);
    expect((await one("select public.calendar_feed($1) v", [await hash(fresh)])).tasks.length).toBeGreaterThan(0);
  });
  it("only lets workspace members make links", async () => {
    await user(outsider);
    await expect(rows("select public.calendar_new_feed($1)", [org])).rejects.toThrow("Workspace access required");
  });
});

describe("Google connection", () => {
  it("uses each connection request once and only within ten minutes", async () => {
    const state = await hash("state-one");
    await user(owner);
    await rows("select public.calendar_begin_connect($1,$2,'https://app.test.invalid')", [org, state]);
    await server();
    expect(await one("select public.calendar_take_state($1) v", [state])).toEqual({
      org_id: org,
      user_id: owner,
      return_to: "https://app.test.invalid",
    });
    await expect(rows("select public.calendar_take_state($1)", [state])).rejects.toThrow("expired");
    const late = await hash("state-two");
    await user(owner);
    await rows("select public.calendar_begin_connect($1,$2,'https://app.test.invalid')", [org, late]);
    await server();
    await rows("update private.calendar_oauth_states set expires_at=now()-interval '1 second'");
    await expect(rows("select public.calendar_take_state($1)", [late])).rejects.toThrow("expired");
    await user(owner);
    await expect(
      rows("select public.calendar_begin_connect($1,$2,'javascript:alert(1)')", [org, await hash("x")]),
    ).rejects.toThrow();
  });
  it("refuses to store a Google credential outside Vault", async () => {
    await server();
    await expect(
      rows("select public.calendar_save_connection($1,$2,'owner@gmail.com','refresh-1')", [org, owner]),
    ).rejects.toThrow("Vault is required");
    // The isolated test database has no Vault, so tests opt in explicitly.
    await db.exec("select set_config('align.calendar_test_tokens','on',false)");
    conn = await one("select public.calendar_save_connection($1,$2,'owner@gmail.com','refresh-1') v", [org, owner]);
    expect(await one("select public.calendar_refresh_token($1) v", [conn])).toBe("refresh-1");
    await user(owner);
    expect(await one("select public.calendar_status($1) v", [org])).toMatchObject({
      google: { email: "owner@gmail.com", status: "active" },
    });
  });
  it("plans exactly the changes Google needs, and nothing twice", async () => {
    await server();
    let plan = await one("select public.calendar_plan($1) v", [conn]);
    const call = plan.upsert.find((x: any) => x.name === "Call Acme");
    expect(call.event_id).toBe("align" + call.task.replace(/-/g, ""));
    expect(plan.upsert.map((x: any) => x.name)).not.toContain("Done already");
    expect(plan.upsert.map((x: any) => x.name)).not.toContain("Rep's task");
    await rows("select public.calendar_record_push($1,$2)", [
      conn,
      JSON.stringify(plan.upsert.map((x: any) => ({ task: x.task, fingerprint: x.fingerprint }))),
    ]);
    plan = await one("select public.calendar_plan($1) v", [conn]);
    expect(plan).toMatchObject({ upsert: [], remove: [] });
    await user(owner);
    await rows("update public.tasks set name='Call Acme today' where id=$1", [call.task]);
    await server();
    plan = await one("select public.calendar_plan($1) v", [conn]);
    expect(plan.upsert.map((x: any) => x.name)).toEqual(["Call Acme today"]);
    await user(owner);
    await rows("update public.tasks set status='Completed' where id=$1", [call.task]);
    await server();
    plan = await one("select public.calendar_plan($1) v", [conn]);
    expect(plan.upsert).toEqual([]);
    expect(plan.remove).toEqual([{ task: call.task, event_id: call.event_id }]);
    await rows("select public.calendar_record_push($1,$2)", [conn, JSON.stringify([{ task: call.task, removed: true }])]);
    expect((await one("select public.calendar_plan($1) v", [conn])).remove).toEqual([]);
  });
});

describe("Google meetings coming into Align", () => {
  const event = (id: string, guests: string[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, status: "confirmed", summary: "Kick-off", start: "2026-11-20T10:00:00Z", guests, ...extra });
  it("brings in a meeting with a known contact, then follows its changes", async () => {
    await user(owner);
    const company = await one("insert into public.companies(org_id,owner_id,name) values($1,$2,'Acme') returning id v", [org, owner]);
    const contact = await one(
      "insert into public.contacts(org_id,owner_id,name,email,company_id) values($1,$2,'Priya','priya@acme.test',$3) returning id v",
      [org, owner, company],
    );
    await server();
    expect(await one("select public.calendar_apply_event($1,$2) v", [conn, event("ev1", ["owner@gmail.com", "PRIYA@acme.test"])])).toBe("created");
    const [a] = await rows("select a.* from public.activities a join private.calendar_event_activities m on m.activity_id=a.id where m.event_id='ev1'");
    expect(a).toMatchObject({ type: "Meeting", name: "Kick-off", contact_id: contact, company_id: company, owner_id: owner });
    expect(a.description).toBe("From Google Calendar");
    expect(await one("select public.calendar_apply_event($1,$2) v", [conn, event("ev1", ["priya@acme.test"], { summary: "Kick-off v2", start: "2026-11-21T10:00:00Z" })])).toBe("updated");
    expect(await one("select name v from public.activities where id=$1", [a.id])).toBe("Kick-off v2");
    expect(await one("select public.calendar_apply_event($1,$2) v", [conn, event("ev1", [], { status: "cancelled" })])).toBe("archived");
    expect(await one("select archived_at is not null v from public.activities where id=$1", [a.id])).toBe(true);
  });
  it("matches a lead when there is no contact", async () => {
    await user(owner);
    const lead = await one(
      "insert into public.leads(org_id,owner_id,name,email,source) values($1,$2,'Ravi','ravi@lead.test','Website') returning id v",
      [org, owner],
    );
    await server();
    expect(await one("select public.calendar_apply_event($1,$2) v", [conn, event("ev2", ["ravi@lead.test"])])).toBe("created");
    expect(await one("select a.lead_id v from public.activities a join private.calendar_event_activities m on m.activity_id=a.id where m.event_id='ev2'")).toBe(lead);
  });
  it("leaves personal events, all-day events and Align's own task events alone", async () => {
    await server();
    const before = await one("select count(*)::int v from public.activities");
    for (const ev of [
      event("p1", ["friend@personal.test"]),
      event("p2", ["owner@gmail.com"]),
      event("p3", ["priya@acme.test"], { start: null }),
      event("p4", ["priya@acme.test"], { align: true }),
      event("p5", ["priya@acme.test"], { status: "cancelled" }),
    ])
      expect(await one("select public.calendar_apply_event($1,$2) v", [conn, ev])).toBe("ignored");
    expect(await one("select count(*)::int v from public.activities")).toBe(before);
    expect(await one("select count(*)::int v from private.calendar_event_activities where event_id like 'p%'")).toBe(0);
  });
});

describe("calendar access", () => {
  it("keeps server-only functions away from members and the public", async () => {
    await user(owner);
    for (const sql of [
      "select public.calendar_feed('x')",
      "select public.calendar_plan(gen_random_uuid())",
      "select public.calendar_refresh_token(gen_random_uuid())",
      "select public.calendar_take_state('x')",
      "select * from private.calendar_connections",
    ])
      await expect(rows(sql)).rejects.toThrow();
    await db.exec("reset role; set role anon");
    await expect(rows("select public.calendar_new_feed($1)", [org])).rejects.toThrow("permission denied");
  });
  it("disconnecting removes the credential and lists Align's events to tidy up", async () => {
    await user(owner);
    const t = await task("Send quote");
    await server();
    const plan = await one("select public.calendar_plan($1) v", [conn]);
    await rows("select public.calendar_record_push($1,$2)", [
      conn,
      JSON.stringify(plan.upsert.map((x: any) => ({ task: x.task, fingerprint: x.fingerprint }))),
    ]);
    const out = await one("select public.calendar_detach($1,$2) v", [org, owner]);
    expect(out.refresh_token).toBe("refresh-1");
    expect(out.events).toContain("align" + t.replace(/-/g, ""));
    expect(await one("select count(*)::int v from private.calendar_connections")).toBe(0);
    expect(await one("select count(*)::int v from private.calendar_event_activities")).toBe(0);
  });
});
