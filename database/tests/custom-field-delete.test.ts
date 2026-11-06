import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const owner = "61000000-0000-0000-0000-000000000001",
  rep = "61000000-0000-0000-0000-000000000002",
  outsider = "61000000-0000-0000-0000-000000000003";
let org: string;
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
const field = async (entity: string, name: string, type: string) => {
  await user(owner);
  return one(
    "insert into public.custom_field_definitions(org_id,entity,name,field_type) values($1,$2,$3,$4) returning id v",
    [org, entity, name, type],
  );
};
async function lead(name: string, values: Record<string, unknown>) {
  await user(owner);
  return one(
    "insert into public.leads(org_id,owner_id,source,name,custom_values) values($1,$2,'Referral',$3,$4) returning id v",
    [org, owner, name, JSON.stringify(values)],
  );
}
const remove = (id: string, dryRun = false) =>
  one("select public.delete_custom_field($1,$2) v", [id, dryRun]);
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
    "select public.create_workspace('TEST ONLY Delete fields','Owner') v",
  );
  await rows(
    "select public.manage_member($1,'rep@test.invalid','Sales Representative')",
    [org],
  );
  await user(outsider);
  await rows("select public.create_workspace('TEST ONLY Elsewhere','Out')");
}, 30000);
afterAll(async () => await db.close());

describe("delete a custom field", () => {
  it("removes the field, its values and its saved-view references, and nothing else", async () => {
    const budget = await field("leads", "Budget", "number");
    const region = await field("leads", "Region", "text");
    const contactBudget = await field("contacts", "Budget", "number");
    const a = await lead("Has budget", { [budget]: 5000, [region]: "South" });
    const b = await lead("No budget", { [region]: "North" });
    await user(owner);
    const contact = await one(
      "insert into public.contacts(org_id,owner_id,name,custom_values) values($1,$2,'Contact',$3) returning id v",
      [org, owner, JSON.stringify({ [contactBudget]: 7 })],
    );
    const view = await one(
      "insert into public.saved_views(org_id,entity,name,visibility,configuration) values($1,'leads','Big budgets','shared',$2) returning id v",
      [
        org,
        JSON.stringify({
          version: 1,
          params: {
            sort: `cf:${budget}`,
            direction: "desc",
            cf: JSON.stringify([
              { field: budget, op: "gte", value: "100" },
              { field: region, op: "eq", value: "South" },
            ]),
          },
          columns: ["name", `cf:${budget}`, `cf:${region}`],
        }),
      ],
    );

    expect(await remove(budget, true)).toEqual({
      name: "Budget",
      records: 1,
      views: 1,
    });
    // A dry run changes nothing.
    expect(
      await one(
        "select count(*)::int v from public.custom_field_definitions where id=$1",
        [budget],
      ),
    ).toBe(1);

    expect(await remove(budget)).toEqual({
      name: "Budget",
      records: 1,
      views: 1,
    });
    expect(
      await one(
        "select count(*)::int v from public.custom_field_definitions where id=$1",
        [budget],
      ),
    ).toBe(0);
    expect(
      await one("select custom_values v from public.leads where id=$1", [a]),
    ).toEqual({ [region]: "South" });
    expect(
      await one("select custom_values v from public.leads where id=$1", [b]),
    ).toEqual({ [region]: "North" });
    // The same-named contact field is a different field and is untouched.
    expect(
      await one("select custom_values v from public.contacts where id=$1", [
        contact,
      ]),
    ).toEqual({ [contactBudget]: 7 });
    const cfg = await one(
      "select configuration v from public.saved_views where id=$1",
      [view],
    );
    expect(cfg.columns).toEqual(["name", `cf:${region}`]);
    expect(cfg.params.sort).toBeUndefined();
    expect(cfg.params.direction).toBeUndefined();
    expect(JSON.parse(cfg.params.cf)).toEqual([
      { field: region, op: "eq", value: "South" },
    ]);
    // Records stay editable and the name can be reused.
    await user(owner);
    await rows("update public.leads set name='Edited' where id=$1", [a]);
    expect(await field("leads", "Budget", "number")).toBeTruthy();
  });

  it("deletes an archived field and its preserved values", async () => {
    const old = await field("leads", "Old score", "number");
    const id = await lead("Archived value", { [old]: 3 });
    await user(owner);
    await rows(
      "update public.custom_field_definitions set archived_at=now() where id=$1",
      [old],
    );
    expect((await remove(old)).records).toBe(1);
    expect(
      await one("select custom_values v from public.leads where id=$1", [id]),
    ).toEqual({});
  });

  it("only lets administrators of the workspace delete", async () => {
    const f = await field("contacts", "Secret", "text");
    await user(rep);
    await expect(remove(f)).rejects.toThrow(
      "Only administrators can delete custom fields",
    );
    await user(outsider);
    await expect(remove(f)).rejects.toThrow("Custom field not found");
    await db.exec("reset role; set role anon");
    await expect(remove(f)).rejects.toThrow(/permission denied/);
    await user(owner);
    expect(
      await one(
        "select count(*)::int v from public.custom_field_definitions where id=$1",
        [f],
      ),
    ).toBe(1);
  });

  it("waits for an import that is still in progress", async () => {
    const f = await field("leads", "Imported", "text");
    await db.exec("reset role");
    const job = await one(
      `insert into private.contact_import_jobs(org_id,owner_id,entity,file_name,headers,file_meta,expected_rows,duplicate_policy) values($1,$2,'leads','leads.csv','["Name"]',$3,1,'skip') returning id v`,
      [org, owner, JSON.stringify({ sha256: "a".repeat(64), mapping: [] })],
    );
    await user(owner);
    await expect(remove(f)).rejects.toThrow(/import is in progress for Leads/);
    await db.exec("reset role");
    await rows(
      "update private.contact_import_jobs set state='cancelled' where id=$1",
      [job],
    );
    await user(owner);
    expect((await remove(f)).name).toBe("Imported");
  });
});
