import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const admin = "40000000-0000-0000-0000-000000000001",
  rep = "40000000-0000-0000-0000-000000000002";
let org: string;
const field: Record<string, string> = {};
async function user(id: string) {
  await db.exec(
    `reset role; insert into auth.sessions(id,user_id) values('${id}','${id}') on conflict do nothing; insert into private.security_sessions(session_id,user_id) values('${id}','${id}') on conflict do nothing; select set_config('request.jwt.claims','{"session_id":"${id}"}',false)`,
  );
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false)`,
  );
}
async function rows(sql: string, params: any[] = []) {
  return (await db.query<any>(sql, params)).rows;
}
async function define(entity: string, name: string, type: string, options: string[] = []) {
  await user(admin);
  return (
    await rows(
      "insert into public.custom_field_definitions(org_id,entity,name,field_type,options) values($1,$2,$3,$4,$5) returning id",
      [org, entity, name, type, options],
    )
  )[0].id;
}
async function qualifiedLead(owner: string, email: string, values: Record<string, unknown>) {
  await user(owner);
  return (
    await rows(
      "insert into public.leads(org_id,owner_id,name,email,source,status,custom_values) values($1,$2,'Buyer',$3,'Website','Qualified',$4) returning id",
      [org, owner, email, values],
    )
  )[0].id;
}
async function contactValues(email: string) {
  await db.exec("reset role");
  return (
    await rows("select custom_values from public.contacts where org_id=$1 and email=$2", [org, email])
  )[0].custom_values;
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${admin}','admin@test.invalid'),('${rep}','rep@test.invalid');`,
  );
  for (const m of readdirSync("database/supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
    await db.exec(readFileSync(`database/supabase/migrations/${m}`, "utf8"));
  await user(admin);
  org = (await rows("select public.create_workspace('TEST ONLY Convert','Admin') id"))[0].id;
  await rows("select public.manage_member($1,'rep@test.invalid','Sales Representative')", [org]);
  field.leadBudget = await define("leads", "Budget", "number");
  field.leadTier = await define("leads", "Tier", "dropdown", ["Gold", "Silver"]);
  field.leadNote = await define("leads", "Source note", "text");
  field.contactBudget = await define("contacts", " budget ", "number");
  field.contactTier = await define("contacts", "Tier", "dropdown", ["Gold"]);
  field.contactNote = await define("contacts", "Source note", "boolean");
}, 30000);
afterAll(async () => await db.close());

describe("lead conversion keeps custom field values", () => {
  it("copies values to contact fields with the same name and type", async () => {
    const lead = await qualifiedLead(rep, "one@example.com", {
      [field.leadBudget]: 5000,
      [field.leadTier]: "Gold",
      [field.leadNote]: "met at expo",
    });
    await rows("select public.convert_lead($1,0)", [lead]);
    expect(await contactValues("one@example.com")).toEqual({
      [field.contactBudget]: 5000,
      [field.contactTier]: "Gold",
    });
  });
  it("skips dropdown choices the contact field does not offer", async () => {
    const lead = await qualifiedLead(rep, "two@example.com", { [field.leadTier]: "Silver" });
    await rows("select public.convert_lead($1,0)", [lead]);
    expect(await contactValues("two@example.com")).toEqual({});
  });
  it("never overwrites values already on an existing contact owned by someone else", async () => {
    await user(admin);
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email,custom_values) values($1,$2,'Existing','three@example.com',$3)",
      [org, admin, { [field.contactBudget]: 1 }],
    );
    const lead = await qualifiedLead(rep, "three@example.com", {
      [field.leadBudget]: 9999,
      [field.leadTier]: "Gold",
    });
    await rows("select public.convert_lead($1,0)", [lead]);
    expect(await contactValues("three@example.com")).toEqual({
      [field.contactBudget]: 1,
      [field.contactTier]: "Gold",
    });
  });
  it("still converts the lead if copying fails", async () => {
    await db.exec(`reset role;
      create function public.block_test_update() returns trigger language plpgsql as $$
      begin if old.name='Blocked' then raise exception 'simulated failure'; end if; return new; end $$;
      create trigger block_test_update before update on public.contacts for each row execute function public.block_test_update();`);
    await user(admin);
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Blocked','four@example.com')",
      [org, admin],
    );
    const lead = await qualifiedLead(admin, "four@example.com", { [field.leadBudget]: 7 });
    const deal = (await rows("select public.convert_lead($1,0) id", [lead]))[0].id;
    expect(deal).toBeTruthy();
    expect(await contactValues("four@example.com")).toEqual({});
    await db.exec("reset role; drop trigger block_test_update on public.contacts; drop function public.block_test_update();");
  });
});
