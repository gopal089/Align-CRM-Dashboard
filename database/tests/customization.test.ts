import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const db = new PGlite();
const [admin, rep, manager, outsider] = Array.from({ length: 4 }, () =>
  crypto.randomUUID(),
);
const sessions = new Map(
  [admin, rep, manager, outsider].map((id) => [id, crypto.randomUUID()]),
);
let org: string, other: string;
const rows = async (sql: string, params: unknown[] = []) =>
  (await db.query<any>(sql, params)).rows;
async function asUser(id = admin) {
  await db.exec("reset role");
  await rows(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [id, JSON.stringify({ session_id: sessions.get(id) })],
  );
  await db.exec("set role authenticated");
}
async function field(type = "text", entity = "leads", options: string[] = []) {
  return (
    await rows(
      "insert into public.custom_field_definitions(org_id,entity,name,field_type,options) values($1,$2,$3,$4,$5) returning *",
      [org, entity, "Field " + crypto.randomUUID(), type, options],
    )
  )[0];
}
async function lead(values: unknown = {}, owner = admin, entity = "leads") {
  return (
    await rows(
      `insert into public.${entity}(org_id,owner_id,name,custom_values) values($1,$2,'Test record',$3) returning *`,
      [org, owner, values],
    )
  )[0];
}
function config(columns = ["name"], params: Record<string, string> = {}) {
  return { version: 1, columns, params };
}
async function view(
  visibility = "personal",
  configuration: unknown = config(),
  workspace = org,
) {
  return (
    await rows(
      "insert into public.saved_views(org_id,entity,name,visibility,configuration) values($1,'leads',$2,$3,$4) returning *",
      [workspace, "View " + crypto.randomUUID(), visibility, configuration],
    )
  )[0];
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  for (const file of readdirSync("database/supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`database/supabase/migrations/${file}`, "utf8"));
  for (const id of sessions.keys()) {
    await rows("insert into auth.users values($1,$2)", [
      id,
      id + "@test.invalid",
    ]);
    await rows("insert into auth.sessions(id,user_id) values($1,$2)", [
      sessions.get(id),
      id,
    ]);
    await rows(
      "insert into private.security_sessions(session_id,user_id) values($1,$2)",
      [sessions.get(id), id],
    );
  }
  await asUser();
  org = (await rows("select public.create_workspace('Custom A','Admin') id"))[0]
    .id;
  await rows("select public.manage_member($1,$2,'Sales Representative')", [
    org,
    rep + "@test.invalid",
  ]);
  await rows("select public.manage_member($1,$2,'Sales Manager')", [
    org,
    manager + "@test.invalid",
  ]);
  await asUser(outsider);
  other = (
    await rows("select public.create_workspace('Custom B','Outside') id")
  )[0].id;
}, 30000);
beforeEach(async () => {
  await db.exec("reset role");
  await rows(
    "update public.subscription_plans set limits=jsonb_set(limits,'{leads}','200') where code='free'",
  );
  await rows(
    "update public.organization_subscriptions set limits_reduced_at=null where org_id=$1",
    [org],
  );
  await asUser();
});
afterAll(() => db.close());
describe("Workspace custom fields and saved views", () => {
  it("accepts typed values, false, zero and leap dates on Leads and Contacts", async () => {
    const fields = await Promise.all([
      field(),
      field("number"),
      field("date"),
      field("dropdown", "leads", ["Gold", "Silver"]),
      field("boolean"),
    ]);
    const values = Object.fromEntries(
      fields.map((f, i) => [f.id, ["Text", 0, "2028-02-29", "Gold", false][i]]),
    );
    expect((await lead(values)).custom_values).toEqual(values);
    const contactField = await field("number", "contacts");
    expect(
      (await lead({ [contactField.id]: -12.5 }, admin, "contacts"))
        .custom_values[contactField.id],
    ).toBe(-12.5);
  });
  it("rejects wrong types, invalid dates, unknown options and oversized text", async () => {
    for (const [type, value, options] of [
      ["number", "2", []],
      ["boolean", "false", []],
      ["date", "2026-02-31", []],
      ["dropdown", "Unknown", ["Gold"]],
      ["text", "x".repeat(2001), []],
    ] as const) {
      const f = await field(type, "leads", [...options]);
      await expect(lead({ [f.id]: value })).rejects.toThrow();
    }
    await expect(lead([])).rejects.toThrow();
    await expect(lead({ [crypto.randomUUID()]: "forged" })).rejects.toThrow(
      "Unknown custom field",
    );
  });
  it("rejects another entity's field even inside the same workspace", async () => {
    const f = await field("text", "contacts");
    await expect(lead({ [f.id]: "Wrong entity" })).rejects.toThrow(
      "Unknown custom field",
    );
  });
  it("keeps permanent field IDs and values after renaming", async () => {
    const f = await field();
    const record = await lead({ [f.id]: "Keep" });
    await rows(
      "update public.custom_field_definitions set name='Renamed' where id=$1",
      [f.id],
    );
    expect(
      (
        await rows("select custom_values from public.leads where id=$1", [
          record.id,
        ])
      )[0].custom_values,
    ).toEqual({ [f.id]: "Keep" });
    await expect(
      rows(
        "update public.custom_field_definitions set field_type='number' where id=$1",
        [f.id],
      ),
    ).rejects.toThrow("identity and type");
    await expect(
      rows("update public.custom_field_definitions set id=$1 where id=$2", [
        crypto.randomUUID(),
        f.id,
      ]),
    ).rejects.toThrow("identity and type");
  });
  it("archives without losing data, allows normal edits, and restores values", async () => {
    const f = await field();
    const record = await lead({ [f.id]: "Keep" });
    await rows(
      "update public.custom_field_definitions set archived_at=now() where id=$1",
      [f.id],
    );
    await rows("update public.leads set name='Normal edit' where id=$1", [
      record.id,
    ]);
    await expect(
      rows("update public.leads set custom_values='{}' where id=$1", [
        record.id,
      ]),
    ).rejects.toThrow("preserved");
    await expect(lead({ [f.id]: "New archived value" })).rejects.toThrow(
      "Archived fields",
    );
    await expect(
      rows("delete from public.custom_field_definitions where id=$1", [f.id]),
    ).rejects.toThrow("permission denied");
    await rows(
      "update public.custom_field_definitions set archived_at=null where id=$1",
      [f.id],
    );
    expect(
      (
        await rows("select custom_values from public.leads where id=$1", [
          record.id,
        ])
      )[0].custom_values[f.id],
    ).toBe("Keep");
  });
  it("keeps old dropdown options but accepts additions", async () => {
    const f = await field("dropdown", "leads", ["Gold"]);
    await expect(
      rows(
        "update public.custom_field_definitions set options=array['Silver'] where id=$1",
        [f.id],
      ),
    ).rejects.toThrow("retained");
    await rows(
      "update public.custom_field_definitions set options=array['Gold','Silver'] where id=$1",
      [f.id],
    );
    expect((await lead({ [f.id]: "Silver" })).custom_values[f.id]).toBe(
      "Silver",
    );
  });
  it("denies cross-workspace definitions, values, saved views and forged IDs", async () => {
    const f = await field();
    const record = await lead({ [f.id]: "Private" });
    const saved = await view("shared");
    await asUser(outsider);
    expect(
      await rows(
        "select * from public.custom_field_definitions where org_id=$1",
        [org],
      ),
    ).toEqual([]);
    expect(
      await rows("select * from public.leads where id=$1", [record.id]),
    ).toEqual([]);
    expect(
      await rows("select * from public.saved_views where id=$1", [saved.id]),
    ).toEqual([]);
    expect(
      await rows(
        "update public.leads set custom_values='{}' where id=$1 returning id",
        [record.id],
      ),
    ).toEqual([]);
    expect(
      await rows(
        "update public.custom_field_definitions set name='Forged' where id=$1 returning id",
        [f.id],
      ),
    ).toEqual([]);
    await expect(
      rows(
        "insert into public.custom_field_definitions(org_id,entity,name,field_type) values($1,'leads','Forged','text')",
        [org],
      ),
    ).rejects.toThrow();
    await expect(view("personal", config(), org)).rejects.toThrow();
    await expect(
      view("personal", config(["name", `cf:${f.id}`]), other),
    ).rejects.toThrow("Unknown column");
  });
  it("reserves field management and shared views for administrators, not managers", async () => {
    const f = await field();
    for (const user of [rep, manager]) {
      await asUser(user);
      await expect(field()).rejects.toThrow();
      expect(
        await rows(
          "update public.custom_field_definitions set archived_at=now() where id=$1 returning id",
          [f.id],
        ),
      ).toEqual([]);
      await expect(view("shared")).rejects.toThrow();
      const personal = await view();
      await expect(
        rows("update public.saved_views set visibility='shared' where id=$1", [
          personal.id,
        ]),
      ).rejects.toThrow();
    }
  });
  it("keeps personal views private and lets administrators manage shared views", async () => {
    const personal = await view();
    const shared = await view("shared");
    await asUser(rep);
    const ids = (await rows("select id from public.saved_views")).map(
      (r) => r.id,
    );
    expect(ids).not.toContain(personal.id);
    expect(ids).toContain(shared.id);
    expect(
      await rows(
        "update public.saved_views set name='Unauthorized' where id=$1 returning id",
        [shared.id],
      ),
    ).toEqual([]);
    expect(
      await rows("delete from public.saved_views where id=$1 returning id", [
        shared.id,
      ]),
    ).toEqual([]);
    const own = await view();
    await rows(
      "update public.saved_views set name='My renamed view' where id=$1",
      [own.id],
    );
    await asUser();
    expect(
      await rows("select id from public.saved_views where id=$1", [own.id]),
    ).toEqual([]);
    await rows(
      "update public.saved_views set name='Shared renamed' where id=$1",
      [shared.id],
    );
    await asUser(rep);
    expect(
      await rows("delete from public.saved_views where id=$1 returning id", [
        own.id,
      ]),
    ).toHaveLength(1);
  });
  it("cannot forge a view owner, move it between workspaces or inject query configuration", async () => {
    await expect(
      rows(
        "insert into public.saved_views(org_id,owner_id,entity,name,configuration) values($1,$2,'leads','Forged',$3)",
        [org, rep, config()],
      ),
    ).rejects.toThrow();
    const own = await view();
    await expect(
      rows("update public.saved_views set org_id=$1 where id=$2", [
        other,
        own.id,
      ]),
    ).rejects.toThrow();
    for (const invalid of [
      config(["name", "password"]),
      config(["name"], { sort: "name;drop table leads" }),
      config(["name"], { arbitrary: "SQL" }),
      config(["name"], { direction: "sideways" }),
      config(["name"], { page: "2" }),
    ])
      await expect(view("personal", invalid)).rejects.toThrow();
  });
  it("validates typed custom filters and retains archived-field view references", async () => {
    const f = await field("number");
    const cfg = config(["name", `cf:${f.id}`], {
      sort: `cf:${f.id}`,
      direction: "asc",
      cf: JSON.stringify([{ field: f.id, op: "gte", value: "12" }]),
    });
    const saved = await view("shared", cfg);
    await expect(
      view(
        "personal",
        config(["name"], {
          cf: JSON.stringify([{ field: f.id, op: "contains", value: "1" }]),
        }),
      ),
    ).rejects.toThrow("text field");
    await expect(
      view(
        "personal",
        config(["name"], {
          cf: JSON.stringify([{ field: f.id, op: "gte", value: "NaN" }]),
        }),
      ),
    ).rejects.toThrow();
    await rows(
      "update public.custom_field_definitions set archived_at=now() where id=$1",
      [f.id],
    );
    expect(
      (
        await rows("select configuration from public.saved_views where id=$1", [
          saved.id,
        ])
      )[0].configuration,
    ).toEqual(cfg);
  });
  it("allows representatives to edit only their own record values", async () => {
    const f = await field();
    const own = await lead({}, rep);
    const others = await lead();
    await asUser(rep);
    expect(
      await rows(
        "update public.leads set custom_values=$1 where id=$2 returning id",
        [{ [f.id]: "Allowed" }, own.id],
      ),
    ).toHaveLength(1);
    expect(
      await rows(
        "update public.leads set custom_values=$1 where id=$2 returning id",
        [{ [f.id]: "Denied" }, others.id],
      ),
    ).toEqual([]);
  });
  it("preserves quotas and view-only retention for custom values", async () => {
    const f = await field();
    const first = await lead({ [f.id]: "Kept" });
    const second = await lead({ [f.id]: "Preserved" });
    const limit =
      Number(
        (
          await rows("select count(*) n from public.leads where org_id=$1", [
            org,
          ])
        )[0].n,
      ) - 1;
    await db.exec("reset role");
    await rows(
      "update public.subscription_plans set limits=jsonb_set(limits,'{leads}',$1::jsonb) where code='free'",
      [String(limit)],
    );
    await rows(
      "update public.organization_subscriptions set limits_reduced_at=now() where org_id=$1",
      [org],
    );
    await asUser();
    await expect(lead()).rejects.toThrow();
    await expect(
      rows(
        "update public.leads set custom_values=$1 where id=$2 returning id",
        [{ [f.id]: "Forbidden" }, second.id],
      ),
    ).rejects.toThrow("Just upgrade your plan");
    await rows("update public.leads set custom_values=$1 where id=$2", [
      { [f.id]: "Allowed" },
      first.id,
    ]);
    await db.exec("reset role");
    await rows(
      "update public.subscription_plans set limits=jsonb_set(limits,'{leads}','200') where code='free'",
    );
    await asUser();
  });
  it("denies new-table access for idle and revoked sessions and for anonymous callers", async () => {
    const f = await field();
    const saved = await view();
    for (const clause of [
      "last_active=now()-interval '31 minutes'",
      "last_active=now(),revoked_at=now() ",
    ]) {
      await db.exec("reset role");
      await rows(
        `update private.security_sessions set ${clause} where session_id=$1`,
        [sessions.get(admin)],
      );
      await asUser();
      expect(
        await rows(
          "select * from public.custom_field_definitions where id=$1",
          [f.id],
        ),
      ).toEqual([]);
      expect(
        await rows("select * from public.saved_views where id=$1", [saved.id]),
      ).toEqual([]);
      await expect(view()).rejects.toThrow();
    }
    await db.exec("reset role");
    await rows(
      "update private.security_sessions set last_active=now(),revoked_at=null where session_id=$1",
      [sessions.get(admin)],
    );
    await db.exec("set role anon");
    await expect(rows("select * from public.saved_views")).rejects.toThrow(
      "permission denied",
    );
  });
  it("applies the MFA latch to new metadata tables and record custom values", async () => {
    const f = await field();
    const record = await lead();
    await db.exec("reset role");
    await rows(
      "insert into private.security_accounts(user_id,factor_id,enabled_at) values($1,$2,now()+interval '1 second')",
      [admin, crypto.randomUUID()],
    );
    await asUser();
    expect(await rows("select * from public.custom_field_definitions")).toEqual(
      [],
    );
    expect(await rows("select * from public.saved_views")).toEqual([]);
    expect(
      await rows(
        "update public.leads set custom_values=$1 where id=$2 returning id",
        [{ [f.id]: "Bypass" }, record.id],
      ),
    ).toEqual([]);
    await db.exec("reset role");
    await rows("delete from private.security_accounts where user_id=$1", [
      admin,
    ]);
  });
});
