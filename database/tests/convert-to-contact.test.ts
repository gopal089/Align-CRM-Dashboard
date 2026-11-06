import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const owner = "60000000-0000-0000-0000-000000000001",
  rep = "60000000-0000-0000-0000-000000000002",
  outsider = "60000000-0000-0000-0000-000000000003";
let org: string,
  budgetLead: string,
  budgetContact: string,
  mismatchLead: string;
async function user(id: string) {
  await db.exec(
    `reset role; insert into auth.sessions(id,user_id) values('${id}','${id}') on conflict do nothing; insert into private.security_sessions(session_id,user_id) values('${id}','${id}') on conflict do nothing; select set_config('request.jwt.claims','{"session_id":"${id}"}',false)`,
  );
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false)`,
  );
}
const rows = async (sql: string, params: any[] = []) =>
  (await db.query<any>(sql, params)).rows;
const one = async (sql: string, params: any[] = []) =>
  (await rows(sql, params))[0]?.v;
async function lead(fields: Record<string, unknown>, as = owner) {
  await user(as);
  const keys = Object.keys(fields);
  return one(
    `insert into public.leads(org_id,owner_id,source,${keys.join(",")}) values($1,$2,'Referral',${keys.map((_, i) => `$${i + 3}`).join(",")}) returning id v`,
    [org, as, ...Object.values(fields)],
  );
}
const convert = (id: string, withDeal = false) =>
  one("select public.convert_lead_to_contact($1,$2) v", [id, withDeal]);
async function asOwner<T>(sql: string, params: any[] = []) {
  await db.exec("reset role");
  return (await rows(sql, params))[0] as T;
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${owner}','owner@test.invalid'),('${rep}','rep@test.invalid'),('${outsider}','out@test.invalid');`,
  );
  for (const m of readdirSync("database/supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`database/supabase/migrations/${m}`, "utf8"));
  await user(owner);
  org = await one(
    "select public.create_workspace('TEST ONLY Convert to contact','Owner') v",
  );
  await rows(
    "select public.manage_member($1,'rep@test.invalid','Sales Representative')",
    [org],
  );
  const field = (entity: string, name: string, type: string) =>
    one(
      "insert into public.custom_field_definitions(org_id,entity,name,field_type) values($1,$2,$3,$4) returning id v",
      [org, entity, name, type],
    );
  budgetLead = await field("leads", "Budget", "number");
  budgetContact = await field("contacts", "Budget", "number");
  mismatchLead = await field("leads", "Region", "text");
  await field("contacts", "Region", "number");
  await user(outsider);
  await rows("select public.create_workspace('TEST ONLY Elsewhere','Out')");
}, 30000);
afterAll(async () => await db.close());

describe("convert a lead to a contact", () => {
  it("creates the contact with name, email, company and source, and copies matching custom fields", async () => {
    const id = await lead({
      name: "Asha Rao",
      email: "asha@globex.test",
      phone: "9000000001",
      company_name: "Globex",
      custom_values: JSON.stringify({
        [budgetLead]: 5000,
        [mismatchLead]: "South",
      }),
    });
    const out = await convert(id);
    expect(out.deal_id).toBeNull();
    const c = await asOwner<any>("select * from public.contacts where id=$1", [
      out.contact_id,
    ]);
    expect(c).toMatchObject({
      name: "Asha Rao",
      email: "asha@globex.test",
      phone: "9000000001",
      source: "Referral",
      owner_id: owner,
    });
    // Budget matches by name and type; Region is text on leads but a number on contacts.
    expect(c.custom_values).toEqual({ [budgetContact]: 5000 });
    expect(
      (
        await asOwner<any>("select name from public.companies where id=$1", [
          c.company_id,
        ])
      ).name,
    ).toBe("Globex");
    const l = await asOwner<any>(
      "select status,converted_at,converted_contact_id,converted_deal_id from public.leads where id=$1",
      [id],
    );
    expect(l).toMatchObject({
      status: "Converted",
      converted_contact_id: out.contact_id,
      converted_deal_id: null,
    });
    expect(l.converted_at).not.toBeNull();
  });
  it("can also create a deal in the same step", async () => {
    const id = await lead({
      name: "Ben",
      email: "ben@initech.test",
      company_name: "Initech",
      status: "Contacted",
    });
    await user(owner);
    const out = await convert(id, true);
    const deal = await asOwner<any>("select * from public.deals where id=$1", [
      out.deal_id,
    ]);
    expect(deal).toMatchObject({
      contact_id: out.contact_id,
      lead_id: id,
      amount: "0.00",
    });
  });
  it("refuses a duplicate email and leaves everything untouched", async () => {
    await user(owner);
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Existing','dup@acme.test')",
      [org, owner],
    );
    const id = await lead({
      name: "Dup",
      email: "DUP@acme.test",
      company_name: "Brand New Co",
    });
    await user(owner);
    await expect(convert(id)).rejects.toThrow(
      "A contact with the email dup@acme.test already exists",
    );
    expect(
      (await asOwner<any>("select status from public.leads where id=$1", [id]))
        .status,
    ).toBe("New");
    expect(
      (
        await asOwner<any>(
          "select count(*)::int n from public.companies where name='Brand New Co'",
        )
      ).n,
    ).toBe(0);
  });
  it("only converts open leads, and only once", async () => {
    const lost = await lead({ name: "Lost one", status: "Lost" });
    await user(owner);
    await expect(convert(lost)).rejects.toThrow("Only open leads");
    const done = await lead({ name: "Twice" });
    await user(owner);
    await convert(done);
    await expect(convert(done)).rejects.toThrow("already been converted");
    // A converted lead without a deal can still be edited.
    await rows("update public.leads set notes='Followed up' where id=$1", [
      done,
    ]);
  });
  it("lets any member convert a lead they can see, but nobody outside the workspace", async () => {
    const id = await lead({ name: "Owner's lead", email: "own@lead.test" });
    await user(outsider);
    await expect(convert(id)).rejects.toThrow("Lead not found");
    await user(rep);
    const out = await convert(id);
    // The contact keeps the lead owner, not the person who clicked.
    expect(
      (
        await asOwner<any>("select owner_id from public.contacts where id=$1", [
          out.contact_id,
        ])
      ).owner_id,
    ).toBe(owner);
    await db.exec("reset role; set role anon");
    await expect(
      rows("select public.convert_lead_to_contact(gen_random_uuid())"),
    ).rejects.toThrow("permission denied");
  });
});
