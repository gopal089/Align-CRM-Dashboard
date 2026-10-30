import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const a = "10000000-0000-0000-0000-000000000001",
  b = "10000000-0000-0000-0000-000000000002",
  c = "10000000-0000-0000-0000-000000000003",
  outsider = "10000000-0000-0000-0000-000000000004";
let org: string,
  other: string,
  company: string,
  lead: string,
  deal: string,
  pitch: string;
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
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${a}','a@test.invalid'),('${b}','b@test.invalid'),('${c}','c@test.invalid'),('${outsider}','outsider@test.invalid');`,
  );
  for (const migration of readdirSync("database/supabase/migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await db.exec(
      readFileSync(`database/supabase/migrations/${migration}`, "utf8"),
    );
  }
  await user(a);
  org = (
    await rows("select public.create_workspace('TEST ONLY A','Test Admin') id")
  )[0].id;
  await rows(
    "select public.manage_member($1,'b@test.invalid','Sales Representative')",
    [org],
  );
  await user(c);
  other = (
    await rows("select public.create_workspace('TEST ONLY B','Other Admin') id")
  )[0].id;
  await user(a);
}, 30000);
afterAll(async () => await db.close());
describe("PostgreSQL business rules and access controls (isolated test records)", () => {
  it("starts with genuine zero metrics", async () => {
    const [r] = await rows("select public.crm_summary($1) s", [org]);
    expect(r.s.leads).toBe(0);
    expect(r.s.won).toBe(0);
    expect(r.s.pipeline).toBe(0);
  });
  it("enables RLS on every public application table", async () => {
    await db.exec("reset role");
    const tables = await rows(
      "select relname,relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind='r'",
    );
    expect(tables.length).toBe(23);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
    await user(a);
  });
  it("prevents cross-organization reads and forged ownership", async () => {
    expect(
      await rows("select * from public.organizations where id=$1", [other]),
    ).toHaveLength(0);
    await expect(
      rows(
        "insert into public.companies(org_id,owner_id,name) values($1,$2,'FORGED')",
        [other, a],
      ),
    ).rejects.toThrow();
  });
  it("blocks nonmembers from privileged membership RPCs", async () => {
    await user(outsider);
    await expect(
      rows(
        "select public.manage_member($1,'outsider@test.invalid','Administrator')",
        [org],
      ),
    ).rejects.toThrow("Administrator");
    await user(a);
  });
  it("validates emails and prevents duplicate companies", async () => {
    await expect(
      rows(
        "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Bad','bad-email')",
        [org, a],
      ),
    ).rejects.toThrow("valid email");
    company = (
      await rows(
        "insert into public.companies(org_id,owner_id,name) values($1,$2,'TEST ONLY Company') returning id",
        [org, a],
      )
    )[0].id;
    await expect(
      rows(
        "insert into public.companies(org_id,owner_id,name) values($1,$2,' test only company ') ",
        [org, a],
      ),
    ).rejects.toThrow("unique");
  });
  it("enforces representative roles for settings, targets, and ownership", async () => {
    await user(b);
    expect(
      await rows(
        "update public.organizations set name='FORGED' where id=$1 returning id",
        [org],
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        "update public.companies set name='FORGED' where id=$1 returning id",
        [company],
      ),
    ).toHaveLength(0);
    await expect(
      rows(
        "insert into public.sales_targets(org_id,owner_id,amount,period_start,period_end) values($1,$2,500,current_date,current_date)",
        [org, b],
      ),
    ).rejects.toThrow();
    await expect(
      rows("select public.manage_member($1,'b@test.invalid','Administrator')", [
        org,
      ]),
    ).rejects.toThrow();
    await user(a);
  });
  it("converts qualified leads atomically and idempotently, reusing company records", async () => {
    lead = (
      await rows(
        "insert into public.leads(org_id,owner_id,name,email,company_name,status) values($1,$2,'TEST ONLY Lead','lead@test.invalid','TEST ONLY Company','Qualified') returning id",
        [org, a],
      )
    )[0].id;
    deal = (await rows("select public.convert_lead($1,1200.50) id", [lead]))[0]
      .id;
    expect(
      (await rows("select public.convert_lead($1,999) id", [lead]))[0].id,
    ).toBe(deal);
    expect(
      (
        await rows(
          "select count(*)::int count from public.companies where org_id=$1",
          [org],
        )
      )[0].count,
    ).toBe(1);
    expect(
      (
        await rows(
          "select count(*)::int count from public.contacts where org_id=$1",
          [org],
        )
      )[0].count,
    ).toBe(1);
    expect(
      (await rows("select status from public.leads where id=$1", [lead]))[0]
        .status,
    ).toBe("Converted");
  });
  it("rejects nonqualified conversions without partial records", async () => {
    const l = (
      await rows(
        "insert into public.leads(org_id,owner_id,name) values($1,$2,'TEST ONLY Unqualified') returning id",
        [org, a],
      )
    )[0].id;
    await expect(rows("select public.convert_lead($1,0)", [l])).rejects.toThrow(
      "Qualify",
    );
    expect(
      (
        await rows(
          "select count(*)::int count from public.deals where org_id=$1",
          [org],
        )
      )[0].count,
    ).toBe(1);
  });
  it("calculates weighted pipeline without counting open deals as revenue", async () => {
    const [r] = await rows("select public.crm_summary($1) s", [org]);
    expect(r.s.pipeline).toBe(1200.5);
    expect(r.s.weighted).toBe(120.05);
    expect(r.s.won).toBe(0);
    expect(r.s.collected).toBe(0);
  });
  it("updates stage history and actual won metrics", async () => {
    await rows("update public.deals set stage='Closed won' where id=$1", [
      deal,
    ]);
    const [r] = await rows("select public.crm_summary($1) s", [org]);
    expect(r.s.pipeline).toBe(0);
    expect(r.s.won).toBe(1200.5);
    expect(
      (
        await rows("select * from public.deal_stage_history where deal_id=$1", [
          deal,
        ])
      ).length,
    ).toBe(2);
    expect(r.s.leadWon).toBe(1);
  });
  it("prevents invalid stages, amounts, currencies, and spoofed history", async () => {
    await expect(
      rows("update public.deals set stage='Invented' where id=$1", [deal]),
    ).rejects.toThrow("Unknown");
    await expect(
      rows("update public.deals set amount=-1 where id=$1", [deal]),
    ).rejects.toThrow();
    await expect(
      rows("update public.organizations set currency='EUR' where id=$1", [org]),
    ).rejects.toThrow("Currency is locked");
    await expect(
      rows(
        "insert into public.deal_stage_history(org_id,deal_id,to_stage,changed_by) values($1,$2,'Closed lost',$3)",
        [org, deal, a],
      ),
    ).rejects.toThrow();
  });
  it("prevents cross-organization foreign keys even for valid UUIDs", async () => {
    await user(c);
    await expect(
      rows(
        "insert into public.contacts(org_id,owner_id,name,company_id) values($1,$2,'FORGED',$3)",
        [other, c, company],
      ),
    ).rejects.toThrow("foreign key");
    await user(a);
  });
  it("atomically saves pitches and section order, rolling back on invalid sections", async () => {
    const payload = {
      org_id: org,
      owner_id: a,
      name: "TEST ONLY Proposal",
      amount: 900,
      status: "Draft",
    };
    pitch = (
      await rows("select public.save_pitch($1,$2,null) id", [
        payload,
        [
          { title: "First", content: "One" },
          { title: "Second", content: "Two" },
        ],
      ])
    )[0].id;
    await expect(
      rows("select public.save_pitch($1,$2,$3)", [
        { ...payload, name: "SHOULD ROLLBACK" },
        [{ title: "", content: "Bad" }],
        pitch,
      ]),
    ).rejects.toThrow();
    expect(
      (await rows("select name from public.pitches where id=$1", [pitch]))[0]
        .name,
    ).toBe("TEST ONLY Proposal");
    expect(
      (
        await rows(
          "select title from public.pitch_sections where pitch_id=$1 order by position",
          [pitch],
        )
      ).map((r) => r.title),
    ).toEqual(["First", "Second"]);
  });
  it("blocks fake view tracking and creates accepted deal only once", async () => {
    await expect(
      rows("update public.pitches set status='Viewed' where id=$1", [pitch]),
    ).rejects.toThrow("not configured");
    await rows("update public.pitches set status='Accepted' where id=$1", [
      pitch,
    ]);
    const d = (await rows("select public.pitch_to_deal($1) id", [pitch]))[0].id;
    expect(
      (await rows("select public.pitch_to_deal($1) id", [pitch]))[0].id,
    ).toBe(d);
    expect(
      (
        await rows(
          "select count(*)::int count from public.pitch_status_history where pitch_id=$1",
          [pitch],
        )
      )[0].count,
    ).toBe(2);
  });
  it("separates manual collected payments from deal values", async () => {
    await expect(
      rows(
        "insert into public.payments(org_id,owner_id,name,deal_id,amount) values($1,$2,'TEST ONLY Payment',$3,300)",
        [org, a, deal],
      ),
    ).rejects.toThrow("Enable");
    await rows(
      "update public.organizations set payment_tracking=true where id=$1",
      [org],
    );
    await rows(
      "insert into public.payments(org_id,owner_id,name,deal_id,amount) values($1,$2,'TEST ONLY Payment',$3,300)",
      [org, a, deal],
    );
    const [r] = await rows("select public.crm_summary($1) s", [org]);
    expect(r.s.collected).toBe(300);
    expect(r.s.won).toBe(1200.5);
  });
  it("applies report periods while explaining current pipeline snapshots", async () => {
    const [r] = await rows(
      "select public.crm_summary($1,'2000-01-01','2000-02-01') s",
      [org],
    );
    expect(r.s.won).toBe(0);
    expect(r.s.leads).toBe(0);
    expect(r.s.collected).toBe(0);
    expect(r.s.pitches).toBe(0);
    expect(r.s.pipeline).toBe(900);
  });
  it("archives records and excludes them from metrics", async () => {
    await rows("update public.leads set archived_at=now() where id=$1", [lead]);
    const [r] = await rows("select public.crm_summary($1) s", [org]);
    expect(r.s.leads).toBe(1);
    expect(r.s.qualified).toBe(0);
    await rows("update public.leads set archived_at=null where id=$1", [lead]);
  });
  it("keeps at least one administrator and denies anonymous CRM access", async () => {
    await expect(
      rows(
        "select public.manage_member($1,'a@test.invalid','Sales Representative')",
        [org],
      ),
    ).rejects.toThrow("at least one");
    await db.exec("reset role; set role anon");
    await expect(rows("select * from public.leads")).rejects.toThrow();
    await expect(
      rows("select public.crm_summary($1)", [org]),
    ).rejects.toThrow();
    await user(a);
  });
  it("supports independent company and contact create/read/update/archive/restore/delete", async () => {
    const co = (
      await rows(
        "insert into public.companies(org_id,owner_id,name) values($1,$2,'TEST ONLY disposable company') returning id",
        [org, a],
      )
    )[0].id;
    const ct = (
      await rows(
        "insert into public.contacts(org_id,owner_id,name,email,company_id) values($1,$2,'TEST ONLY disposable contact','disposable@test.invalid',$3) returning id",
        [org, a, co],
      )
    )[0].id;
    await expect(
      rows(
        "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'TEST ONLY duplicate','DISPOSABLE@test.invalid')",
        [org, a],
      ),
    ).rejects.toThrow("unique");
    await rows(
      "update public.contacts set job_title='Updated title',archived_at=now() where id=$1",
      [ct],
    );
    expect(
      (
        await rows(
          "select job_title,archived_at from public.contacts where id=$1",
          [ct],
        )
      )[0].job_title,
    ).toBe("Updated title");
    await rows("update public.contacts set archived_at=null where id=$1", [ct]);
    await rows(
      "update public.companies set industry='Updated industry' where id=$1",
      [co],
    );
    await rows("delete from public.contacts where id=$1", [ct]);
    await rows("delete from public.companies where id=$1", [co]);
    expect(
      await rows("select * from public.contacts where id=$1", [ct]),
    ).toHaveLength(0);
  });
  it("supports task completion, rescheduling, and deletion with real timestamps", async () => {
    const id = (
      await rows(
        "insert into public.tasks(org_id,owner_id,name,due_date,deal_id) values($1,$2,'TEST ONLY task',current_date,$3) returning id",
        [org, a, deal],
      )
    )[0].id;
    await rows("update public.tasks set status='Completed' where id=$1", [id]);
    expect(
      (await rows("select completed_at from public.tasks where id=$1", [id]))[0]
        .completed_at,
    ).not.toBeNull();
    await rows(
      "update public.tasks set status='Open',due_date=current_date+7 where id=$1",
      [id],
    );
    expect(
      (await rows("select completed_at from public.tasks where id=$1", [id]))[0]
        .completed_at,
    ).toBeNull();
    await rows("delete from public.tasks where id=$1", [id]);
    expect(
      await rows("select * from public.tasks where id=$1", [id]),
    ).toHaveLength(0);
  });
  it("supports recorded activity CRUD without claiming external delivery", async () => {
    const id = (
      await rows(
        "insert into public.activities(org_id,owner_id,name,type,description) values($1,$2,'TEST ONLY recorded call','Call','Manually recorded test') returning id",
        [org, a],
      )
    )[0].id;
    await rows(
      "update public.activities set description='Updated context',archived_at=now() where id=$1",
      [id],
    );
    expect(
      (
        await rows("select description from public.activities where id=$1", [
          id,
        ])
      )[0].description,
    ).toBe("Updated context");
    await rows("delete from public.activities where id=$1", [id]);
    expect(
      await rows("select * from public.activities where id=$1", [id]),
    ).toHaveLength(0);
  });
  it("supports reusable templates and safely deleting a draft pitch", async () => {
    const template = (
      await rows(
        "insert into public.pitch_templates(org_id,owner_id,name,sections) values($1,$2,'TEST ONLY template',$3) returning id",
        [org, a, [{ title: "Hello", content: "{{customer}}" }]],
      )
    )[0].id;
    await rows(
      "update public.pitch_templates set terms='Updated terms' where id=$1",
      [template],
    );
    const draft = (
      await rows("select public.save_pitch($1,$2,null) id", [
        {
          org_id: org,
          owner_id: a,
          name: "TEST ONLY deletable draft",
          amount: 50,
          status: "Draft",
          template_id: template,
        },
        [{ title: "A", content: "B" }],
      ])
    )[0].id;
    await rows("delete from public.pitches where id=$1", [draft]);
    expect(
      await rows("select * from public.pitch_sections where pitch_id=$1", [
        draft,
      ]),
    ).toHaveLength(0);
    await rows("delete from public.pitch_templates where id=$1", [template]);
  });
  it("uses overlapping targets and validates date ranges", async () => {
    const id = (
      await rows(
        "insert into public.sales_targets(org_id,owner_id,name,amount,period_start,period_end,team_target) values($1,$2,'TEST ONLY target',2000,current_date-5,current_date+5,true) returning id",
        [org, a],
      )
    )[0].id;
    const r = (
      await rows(
        "select public.crm_summary($1,current_date::timestamptz,(current_date+1)::timestamptz) s",
        [org],
      )
    )[0];
    expect(r.s.target).toBe(2000);
    await expect(
      rows(
        "update public.sales_targets set period_end=period_start-1 where id=$1",
        [id],
      ),
    ).rejects.toThrow();
    await rows(
      "update public.sales_targets set archived_at=now() where id=$1",
      [id],
    );
    expect(
      (await rows("select public.crm_summary($1) s", [org]))[0].s.target,
    ).toBe(0);
    await rows("delete from public.sales_targets where id=$1", [id]);
  });
  it("locks completed conversion relationships against later tampering", async () => {
    await expect(
      rows("update public.leads set status='New' where id=$1", [lead]),
    ).rejects.toThrow("Conversion relationships");
    await expect(
      rows("update public.leads set converted_deal_id=null where id=$1", [
        lead,
      ]),
    ).rejects.toThrow("Conversion relationships");
  });
  it("allows representative-owned updates while denying permanent deletion", async () => {
    await user(b);
    const id = (
      await rows(
        "insert into public.leads(org_id,owner_id,name) values($1,$2,'TEST ONLY rep lead') returning id",
        [org, b],
      )
    )[0].id;
    await rows("update public.leads set status='Contacted' where id=$1", [id]);
    expect(
      (await rows("select status from public.leads where id=$1", [id]))[0]
        .status,
    ).toBe("Contacted");
    expect(
      await rows("delete from public.leads where id=$1 returning id", [id]),
    ).toHaveLength(0);
    await expect(
      rows("update public.leads set owner_id=$1 where id=$2", [a, id]),
    ).rejects.toThrow();
    await user(a);
    await rows("delete from public.leads where id=$1", [id]);
  });
});
