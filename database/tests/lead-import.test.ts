import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const [admin, rep] = [crypto.randomUUID(), crypto.randomUUID()];
const sessions = new Map([admin, rep].map((u) => [u, crypto.randomUUID()]));
let org: string;
const rows = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql, args)).rows;
async function user(u = admin) {
  await db.exec("reset role");
  await rows("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [
    u,
    JSON.stringify({ session_id: sessions.get(u) }),
  ]);
  await db.exec("set role authenticated");
}
async function call(fn: "lead_import" | "contact_import", operation: string, j: string | null = null, p: any = {}) {
  return (await rows(`select public.${fn}($1,$2,$3,$4) value`, [org, operation, j, p]))[0].value;
}
const lead = (i: number, payload: Record<string, unknown>) => ({
  row_no: i + 2,
  payload,
  source: Object.values(payload).map(String),
  client_error: "",
});
async function preview(inputs: any[], policy = "skip", fn: "lead_import" | "contact_import" = "lead_import") {
  const job = await call(fn, "create", null, {
    file_name: "leads.csv",
    headers: ["Name"],
    rows: inputs.length,
    policy,
    file_meta: { sha256: "d".repeat(64), mapping: ["name"], sheet: "CSV" },
  });
  await call(fn, "append", job.id, { rows: inputs });
  await call(fn, "seal", job.id);
  let p = await call(fn, "review", job.id);
  while (p.job.state === "reviewing") p = await call(fn, "review", job.id);
  return p;
}
async function finish(p: any, fn: "lead_import" | "contact_import" = "lead_import") {
  await call(fn, "confirm", p.job.id, { confirmation: p.job.confirmation });
  let s = await call(fn, "status", p.job.id, { filter: "pending" });
  while (s.rows.length) {
    await call(fn, "batch", p.job.id, { rows: s.rows.map((r: any) => ({ retry_id: r.retry_id, target_id: r.target_id })) });
    s = await call(fn, "status", p.job.id, { filter: "pending" });
  }
  return call(fn, "status", p.job.id);
}
async function leadByEmail(email: string) {
  await db.exec("reset role");
  const [r] = await rows("select * from public.leads where org_id=$1 and email=$2", [org, email]);
  await user();
  return r;
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  for (const f of readdirSync("database/supabase/migrations").filter((x) => x.endsWith(".sql")).sort())
    await db.exec(readFileSync("database/supabase/migrations/" + f, "utf8"));
  for (const u of sessions.keys()) {
    await rows("insert into auth.users values($1,$2)", [u, u + "@test.invalid"]);
    await rows("insert into auth.sessions(id,user_id) values($1,$2)", [sessions.get(u), u]);
    await rows("insert into private.security_sessions(session_id,user_id) values($1,$2)", [sessions.get(u), u]);
  }
  await user();
  org = (await rows("select public.create_workspace('TEST ONLY Lead import','Admin') id"))[0].id;
  await rows("select public.manage_member($1,$2,'Sales Representative')", [org, rep + "@test.invalid"]);
  await rows("update public.subscription_plans set limits=jsonb_set(limits,'{leads}','500') where code='free'").catch(() => {});
}, 30000);
afterAll(() => db.close());

describe("leads import", () => {
  it("imports leads with normalised choices and a default source", async () => {
    const p = await preview([
      lead(0, { name: "Ann", email: "ANN@Example.com", status: "contacted", priority: "high", source: "referral", company_name: "Acme" }),
      lead(1, { name: "Ben", email: "ben@example.com" }),
    ]);
    expect(p.counts).toMatchObject({ errors: 0, duplicates: 0 });
    const done = await finish(p);
    expect(done.counts).toMatchObject({ imported: 2, failed: 0 });
    expect(await leadByEmail("ann@example.com")).toMatchObject({
      status: "Contacted",
      priority: "High",
      source: "Referral",
      company_name: "Acme",
      owner_id: admin,
    });
    expect(await leadByEmail("ben@example.com")).toMatchObject({ status: "New", priority: "Medium", source: "Manual" });
  });
  it("rejects unknown sources, statuses and conversion", async () => {
    const p = await preview([
      lead(0, { name: "Cat", source: "Billboard" }),
      lead(1, { name: "Dan", status: "Converted" }),
      lead(2, { name: "Eve", priority: "Urgent" }),
      lead(3, { name: "=HYPERLINK(1)" }),
    ]);
    const errors = p.rows.map((r: any) => r.error);
    expect(p.counts.errors).toBe(4);
    expect(errors[0]).toContain("Unknown lead source");
    expect(errors[1]).toContain("Status must be");
    expect(errors[2]).toContain("Priority must be");
    expect(errors[3]).toMatch(/formula/i);
    await call("lead_import", "cancel", p.job.id);
  });
  it("finds duplicates among leads only, and updates without erasing", async () => {
    // A contact with the same email must not count as a duplicate lead.
    await rows("insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Contact Fay','fay@example.com')", [org, admin]);
    let p = await preview([lead(0, { name: "Fay", email: "fay@example.com", company_name: "Old Co" })]);
    expect(p.rows[0].action).toBe("insert");
    await finish(p);
    p = await preview([lead(0, { name: "Fay Updated", email: "fay@example.com", status: "Qualified" })], "update");
    expect(p.rows[0].action).toBe("update");
    await finish(p);
    expect(await leadByEmail("fay@example.com")).toMatchObject({
      name: "Fay Updated",
      status: "Qualified",
      company_name: "Old Co",
      source: "Manual",
    });
    p = await preview([lead(0, { name: "Fay again", email: "fay@example.com" })], "skip");
    expect(p.rows[0].action).toBe("skip");
    await call("lead_import", "cancel", p.job.id);
  });
  it("lets a representative import but not update someone else's lead", async () => {
    await user(rep);
    const p = await preview([lead(0, { name: "Someone", email: "ann@example.com" })], "update");
    expect(p.rows[0].action).toBe("error");
    expect(p.rows[0].error).toContain("Matching lead is not editable");
    await call("lead_import", "cancel", p.job.id);
    const q = await preview([lead(0, { name: "Mine", email: "rep-own@example.com" })]);
    await finish(q);
    expect((await leadByEmail("rep-own@example.com")).owner_id).toBe(rep);
    await user();
  });
  it("keeps lead and contact imports apart", async () => {
    const p = await preview([lead(0, { name: "Gus", email: "gus@example.com" })]);
    await expect(call("contact_import", "status", p.job.id)).rejects.toThrow("unavailable");
    const leadJobs = (await call("lead_import", "list")).map((x: any) => x.id);
    const contactJobs = (await call("contact_import", "list")).map((x: any) => x.id);
    expect(leadJobs).toContain(p.job.id);
    expect(contactJobs).not.toContain(p.job.id);
    await call("lead_import", "cancel", p.job.id);
  });
  it("still imports contacts exactly as before", async () => {
    const p = await preview([lead(0, { name: "Hal", email: "hal@example.com", job_title: "CTO" })], "skip", "contact_import");
    const done = await finish(p, "contact_import");
    expect(done.counts.imported).toBe(1);
    await db.exec("reset role");
    expect((await rows("select job_title from public.contacts where email='hal@example.com'"))[0].job_title).toBe("CTO");
    await user();
  });
});
