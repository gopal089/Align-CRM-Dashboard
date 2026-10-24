import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

const db = new PGlite();
let org: string, uid: string;
const query = async (sql: string, values: unknown[] = []) =>
  (await db.query<any>(sql, values)).rows;
async function actor(id = uid) {
  await db.exec(
    `reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false)`,
  );
}
async function owner(sql: string, values: unknown[] = []) {
  await db.exec("reset role");
  try {
    return await query(sql, values);
  } finally {
    await actor();
  }
}
async function paid(offset = "1 month", verified = true, plan = "starter") {
  await owner(
    `update public.organization_subscriptions set paid_plan_code=$2,paid_until=statement_timestamp()+$3::interval,last_verified_at=case when $4 then statement_timestamp() else null end,provider_subscription_id='sub_'||replace(org_id::text,'-',''),provider_status='active' where org_id=$1`,
    [org, plan, offset, verified],
  );
}
async function contacts(n: number) {
  return query(
    "insert into public.contacts(org_id,name) select $1,'CONTACT '||g from generate_series(1,$2::integer)g returning id,name,created_at",
    [org, n],
  );
}
async function limit(n: number) {
  await owner(
    "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}',to_jsonb($1::integer)) where code='free'",
    [n],
  );
}
async function cleanup() {
  return (
    await owner("select private.process_billing_retention($1) result", [org])
  )[0].result;
}
beforeAll(async () => {
  await db.exec(
    `create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
}, 30000);
beforeEach(async () => {
  await db.exec("reset role");
  uid = crypto.randomUUID();
  await query("insert into auth.users values($1,$2)", [
    uid,
    `${uid}@test.invalid`,
  ]);
  await query(
    "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}','100') where code='free'",
  );
  await actor();
  org = (
    await query(
      "select public.create_workspace('BILLING TEST','Test admin') id",
    )
  )[0].id;
});
afterAll(() => db.close());

describe("Subscription enforcement and LIFO retention", () => {
  it("starts on Free with the approved monthly prices and limits", async () => {
    const s = (await query("select public.billing_status($1) s", [org]))[0].s;
    expect(s.plan.code).toBe("free");
    expect(s.usage.memberships).toMatchObject({ used: 1, limit: 3 });
    const prices = await query(
      "select code,monthly_price from public.subscription_plans order by monthly_price",
    );
    expect(prices.map((p) => p.monthly_price)).toEqual([0, 199900, 499900]);
  });
  it("enforces customer quotas at the database and counts archived records", async () => {
    await limit(2);
    const records = await contacts(2);
    await query("update public.contacts set archived_at=now() where id=$1", [
      records[0].id,
    ]);
    await expect(contacts(1)).rejects.toThrow("Plan limit reached");
    await query("delete from public.contacts where id=$1", [records[0].id]);
    await expect(contacts(1)).resolves.toHaveLength(1);
  });
  it("enforces active seats, including admins, without deleting login accounts", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids)
      await owner("insert into auth.users values($1,$2)", [
        id,
        `${id}@test.invalid`,
      ]);
    for (const id of ids.slice(0, 2))
      await query("select public.manage_member($1,$2,'Sales Representative')", [
        org,
        `${id}@test.invalid`,
      ]);
    await expect(
      query("select public.manage_member($1,$2,'Sales Representative')", [
        org,
        `${ids[2]}@test.invalid`,
      ]),
    ).rejects.toThrow("Plan limit reached");
    const member = (
      await query("select id from memberships where org_id=$1 and user_id=$2", [
        org,
        ids[0],
      ])
    )[0];
    await query("select public.set_member_active($1,$2,false)", [
      org,
      member.id,
    ]);
    await query("select public.manage_member($1,$2,'Sales Representative')", [
      org,
      `${ids[2]}@test.invalid`,
    ]);
    await actor(ids[0]);
    expect(
      await query("select * from companies where org_id=$1", [org]),
    ).toHaveLength(0);
    await actor();
    expect(
      (
        await owner("select count(*) n from auth.users where id=$1", [ids[0]])
      )[0].n,
    ).toBe(1);
  });
  it("protects the last active administrator", async () => {
    const m = (
      await query("select id from memberships where org_id=$1 and user_id=$2", [
        org,
        uid,
      ])
    )[0];
    await expect(
      query("select public.set_member_active($1,$2,false)", [org, m.id]),
    ).rejects.toThrow("active administrator");
  });
  it("expires exactly at paid_until with no paid access grace", async () => {
    await paid("1 hour");
    expect(
      (await query("select billing_status($1) s", [org]))[0].s.plan.code,
    ).toBe("starter");
    await paid("-1 second");
    const s = (await query("select billing_status($1) s", [org]))[0].s;
    expect(s.plan.code).toBe("free");
    expect(
      new Date(s.retention_deadline).getTime() -
        new Date(s.paid_until).getTime(),
    ).toBe(7 * 86400000);
  });
  it("warns only during the last seven paid days", async () => {
    await paid("8 days");
    expect(
      (await query("select billing_status($1) s", [org]))[0].s.renewal_warning,
    ).toBe(false);
    await paid("6 days");
    expect(
      (await query("select billing_status($1) s", [org]))[0].s.renewal_warning,
    ).toBe(true);
    await paid("-1 second");
    expect(
      (await query("select billing_status($1) s", [org]))[0].s.renewal_warning,
    ).toBe(false);
  });
  it("keeps oldest 300 and marks newest 200 as read-only in the approved 500/300 example", async () => {
    await paid();
    await limit(300);
    const rows = await contacts(500);
    await paid("-1 day");
    const p = (
      await query("select billing_record_permissions($1,'contacts',$2) p", [
        org,
        [rows[0].id, rows[299].id, rows[300].id, rows[499].id],
      ])
    )[0].p;
    expect(p[rows[0].id].preserved).toBe(false);
    expect(p[rows[299].id].preserved).toBe(false);
    expect(p[rows[300].id].preserved).toBe(true);
    expect(p[rows[499].id].preserved).toBe(true);
    await expect(
      query("update contacts set notes='forged' where id=$1", [rows[499].id]),
    ).rejects.toThrow("Just upgrade your plan to edit or export.");
    await expect(
      query("delete from contacts where id=$1", [rows[499].id]),
    ).rejects.toThrow("Just upgrade your plan to edit or export.");
    expect(
      await query("select * from contacts where org_id=$1", [org]),
    ).toHaveLength(500);
    await expect(
      query("select billing_assert_export($1,'contacts')", [org]),
    ).rejects.toThrow("Just upgrade your plan");
    await paid("-8 days");
    expect(await cleanup()).toEqual({ contacts: 200 });
    const kept = await query(
      "select id from contacts where org_id=$1 order by created_at,billing_order,id",
      [org],
    );
    expect(kept.map((r) => r.id)).toEqual(rows.slice(0, 300).map((r) => r.id));
  }, 30000); // Hundreds of real Postgres trigger calls take longer on Render's shared builder.
  it("does not let clients backdate creation order or change billing data", async () => {
    const [r] = await contacts(1);
    await expect(
      query("update contacts set created_at='2000-01-01' where id=$1", [r.id]),
    ).rejects.toThrow("identity");
    await expect(
      query(
        "update subscription_plans set monthly_price=1 where code='business'",
      ),
    ).rejects.toThrow();
    await expect(
      query(
        "update organization_subscriptions set paid_until=now()+interval '1 year' where org_id=$1",
        [org],
      ),
    ).rejects.toThrow();
    await expect(
      query("select billing_apply_receipt($1,'sub_forged','{}')", [org]),
    ).rejects.toThrow();
    await expect(
      query("select billing_process_retention($1)", [org]),
    ).rejects.toThrow();
  });
  it("only deletes after seven days and a fresh provider reconciliation", async () => {
    await limit(1);
    await paid();
    await contacts(2);
    await paid("-6 days");
    expect(await cleanup()).toEqual({});
    await paid("-8 days", false);
    expect(await cleanup()).toEqual({});
    await paid("-8 days");
    expect(await cleanup()).toEqual({ contacts: 1 });
    expect(await cleanup()).toEqual({});
    expect(
      await query("select * from billing_retention_log where org_id=$1", [org]),
    ).toHaveLength(1);
  });
  it("hides expired excess data when reconciliation or cleanup is delayed", async () => {
    await limit(1);
    await paid();
    await contacts(2);
    await paid("-8 days", false);
    expect(
      await query("select * from contacts where org_id=$1", [org]),
    ).toHaveLength(1);
    expect(
      (await owner("select count(*) n from contacts where org_id=$1", [org]))[0]
        .n,
    ).toBe(2);
    expect(
      (
        await query("select billing_retained_records($1,'contacts',1) r", [org])
      )[0].r,
    ).toEqual([]);
  });
  it("an upgrade before the deadline restores access and cancels deletion", async () => {
    await limit(1);
    await paid();
    const r = await contacts(2);
    await paid("-6 days");
    await paid();
    await expect(
      query("update contacts set notes='restored' where id=$1", [r[1].id]),
    ).resolves.toBeDefined();
    expect(await cleanup()).toEqual({});
    expect(
      await query("select * from contacts where org_id=$1", [org]),
    ).toHaveLength(2);
    await expect(
      query("select billing_assert_export($1,'contacts')", [org]),
    ).resolves.toBeDefined();
  });
  it("purges customer links without deleting converted leads, deals, activities or payments", async () => {
    await limit(2);
    await paid();
    await contacts(2);
    const l = (
      await query(
        "insert into leads(org_id,name,status) values($1,'CONVERTED','Qualified') returning id",
        [org],
      )
    )[0];
    const d = (await query("select convert_lead($1,1000) id", [l.id]))[0];
    await query("update organizations set payment_tracking=true where id=$1", [
      org,
    ]);
    await query(
      "insert into payments(org_id,name,deal_id,amount) values($1,'Kept payment',$2,100)",
      [org, d.id],
    );
    await paid("-8 days");
    expect(await cleanup()).toEqual({ contacts: 1 });
    expect(
      (
        await query(
          "select converted_contact_id,status from leads where id=$1",
          [l.id],
        )
      )[0],
    ).toMatchObject({ converted_contact_id: null, status: "Converted" });
    expect(
      (await query("select contact_id from deals where id=$1", [d.id]))[0]
        .contact_id,
    ).toBe(null);
    expect(
      await query("select * from payments where org_id=$1", [org]),
    ).toHaveLength(1);
    expect(
      await query("select * from activities where org_id=$1", [org]),
    ).toHaveLength(1);
    await expect(
      query("update leads set notes='still editable' where id=$1", [l.id]),
    ).resolves.toBeDefined();
  });
  it("retention listing includes only excess records and never the kept partition", async () => {
    await limit(2);
    await paid();
    await contacts(4);
    await paid("-1 day");
    const rows = (
      await query("select billing_retained_records($1,'contacts',1) r", [org])
    )[0].r;
    expect(rows.map((r: any) => r.name)).toEqual(["CONTACT 4", "CONTACT 3"]);
    expect(
      (
        await query("select billing_retained_records($1,'contacts',2) r", [org])
      )[0].r,
    ).toEqual([]);
  });
  it("does not expose subscription information across workspaces", async () => {
    await actor(crypto.randomUUID());
    await expect(query("select billing_status($1)", [org])).rejects.toThrow(
      "Workspace access",
    );
    await expect(
      query("select billing_record_permissions($1,'contacts','{}')", [org]),
    ).rejects.toThrow("Workspace access");
    expect(
      await query("select * from organization_subscriptions where org_id=$1", [
        org,
      ]),
    ).toHaveLength(0);
  });
  it("does not apply paid entitlements from activation alone or replayed old receipts", async () => {
    const sub = "sub_" + org.replaceAll("-", "");
    await owner(
      "update organization_subscriptions set provider_subscription_id=$2 where org_id=$1",
      [org, sub],
    );
    await owner('select billing_apply_receipt($1,$2,\'{"status":"active"}\')', [
      org,
      sub,
    ]);
    expect(
      (await query("select billing_status($1) s", [org]))[0].s.plan.code,
    ).toBe("free");
    const receipt = {
      payment_id: crypto.randomUUID(),
      invoice_id: crypto.randomUUID(),
      plan_code: "starter",
      amount: 199900,
      currency: "INR",
      paid_at: new Date().toISOString(),
      period_start: new Date(Date.now() - 3600000).toISOString(),
      period_end: new Date(Date.now() + 86400000).toISOString(),
    };
    await owner(
      "select billing_apply_receipt($1,$2,'{\"status\":\"active\"}',$3,'evt_same','subscription.charged')",
      [org, sub, receipt],
    );
    await owner(
      "select billing_apply_receipt($1,$2,'{\"status\":\"active\"}',$3,'evt_same','subscription.charged')",
      [org, sub, receipt],
    );
    expect(
      (await query("select billing_status($1) s", [org]))[0].s.plan.code,
    ).toBe("starter");
    expect(
      await query("select * from billing_receipts where org_id=$1", [org]),
    ).toHaveLength(1);
    expect(
      await query("select * from billing_events where org_id=$1", [org]),
    ).toHaveLength(1);
    await owner(
      'select billing_apply_receipt($1,$2,\'{"status":"pending"}\')',
      [org, sub],
    );
    expect(
      new Date(
        (await query("select billing_status($1) s", [org]))[0].s.paid_until,
      ).toISOString(),
    ).toBe(receipt.period_end);
  });
  it("keeps platform revenue private even from workspace administrators", async () => {
    expect(
      (await query("select platform_billing_access() allowed"))[0].allowed,
    ).toBe(false);
    await expect(
      query("select platform_billing_report(now()-interval '1 month',now())"),
    ).rejects.toThrow("Platform billing owner");
    await owner("insert into private.platform_billing_admins values($1)", [
      uid,
    ]);
    expect(
      (
        await query(
          "select platform_billing_report(now()-interval '1 month',now()) r",
        )
      )[0].r,
    ).toMatchObject({ currency: "INR", trials_enabled: false });
  });
});
