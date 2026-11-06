import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const rep = "30000000-0000-0000-0000-000000000002";
// Each person may create only one workspace, so every test gets a new admin.
let admin = "";
async function user(id: string) {
  await db.exec(
    `reset role; insert into auth.sessions(id,user_id) values('${id}','${id}') on conflict do nothing; insert into private.security_sessions(session_id,user_id) values('${id}','${id}') on conflict do nothing; select set_config('request.jwt.claims','{"session_id":"${id}"}',false)`,
  );
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false)`,
  );
}
// The scheduled job and the email sender run with nobody signed in.
async function system() {
  await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)");
}
async function rows(sql: string, params: any[] = []) {
  return (await db.query<any>(sql, params)).rows;
}
// 8:30 am in Kolkata, `days` days from now. Records are created "now", so a
// later run sees them as untouched for that many days.
async function morning(days: number, hour = "8 hours 30 minutes") {
  return (
    await rows(
      `select ((date_trunc('day', now() at time zone 'Asia/Kolkata') + make_interval(days=>$1) + interval '${hour}') at time zone 'Asia/Kolkata') t`,
      [days],
    )
  )[0].t;
}
async function run(at: Date) {
  await system();
  return (await rows("select private.run_follow_ups($1) v", [at]))[0].v;
}
let n = 0;
async function workspace(withRep = true) {
  await system();
  admin = crypto.randomUUID();
  await rows("insert into auth.users values($1,$2)", [
    admin,
    `admin${++n}@test.invalid`,
  ]);
  await user(admin);
  const org = (
    await rows("select public.create_workspace($1,'Admin Person') id", [
      `TEST ONLY Follow-ups ${++n}`,
    ])
  )[0].id;
  if (withRep)
    await rows(
      "select public.manage_member($1,'rep@test.invalid','Sales Representative')",
      [org],
    );
  return org;
}
async function lead(org: string, owner = rep, extra = "") {
  await user(admin);
  return (
    await rows(
      `insert into public.leads(org_id,owner_id,name,source${extra ? ",status" : ""}) values($1,$2,$3,'Website'${extra ? ",$4" : ""}) returning id`,
      extra ? [org, owner, "Lead " + ++n, extra] : [org, owner, "Lead " + ++n],
    )
  )[0].id;
}
async function autoTasks(source: string) {
  await system();
  return rows(
    "select id,owner_id,name,priority,status,lead_id,contact_id,due_date::text due,auto_rule from public.tasks where auto_source=$1 order by created_at",
    [source],
  );
}
async function outbox(org: string) {
  await system();
  return rows(
    "select user_id,kind,payload,status from private.notification_outbox where org_id=$1 order by kind,user_id",
    [org],
  );
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${rep}','rep@test.invalid');`,
  );
  for (const migration of readdirSync("database/supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      readFileSync(`database/supabase/migrations/${migration}`, "utf8"),
    );
  // The rep needs a profile before they can be added to a workspace.
  await user(rep);
  await rows("select public.create_workspace('TEST ONLY rep home','Rep Person')");
}, 30000);
beforeEach(async () => {
  await system();
  // Each test runs on its own days; clearing the run log keeps them independent.
  await db.exec("delete from private.follow_up_runs");
});
afterAll(async () => await db.close());

describe("automated follow-ups", () => {
  it("creates one task for an untouched lead, once a day, without duplicates", async () => {
    const org = await workspace();
    const id = await lead(org);
    const first = await run(await morning(5));
    expect(first.tasks).toBeGreaterThanOrEqual(1);
    let tasks = await autoTasks(id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      owner_id: rep,
      lead_id: id,
      auto_rule: "lead_untouched",
      status: "Open",
      priority: "Medium",
    });
    expect(tasks[0].name).toMatch(/^Follow up: Lead/);
    const [digest] = (await outbox(org)).filter((x) => x.user_id === rep);
    expect(digest.kind).toBe("follow_up_digest");
    expect(digest.payload.items).toEqual([
      { task: tasks[0].id, name: tasks[0].name, kind: "lead" },
    ]);
    // Same morning again: the workspace has already run today.
    expect((await run(await morning(5))).workspaces).toBe(0);
    // Next morning: the open follow-up is not duplicated.
    await run(await morning(6));
    tasks = await autoTasks(id);
    expect(tasks).toHaveLength(1);
  });
  it("counts a logged activity or a completed follow-up as contact", async () => {
    const org = await workspace();
    const touched = await lead(org);
    await user(admin);
    await rows(
      "insert into public.activities(org_id,owner_id,name,type,lead_id,occurred_at) values($1,$2,'Call','Call',$3,$4)",
      [org, rep, touched, await morning(4)],
    );
    await run(await morning(5));
    expect(await autoTasks(touched)).toHaveLength(0);

    const done = await lead(org);
    await run(await morning(6));
    const [task] = await autoTasks(done);
    await user(admin);
    await rows(
      "update public.tasks set status='Completed',completed_at=$2 where id=$1",
      [task.id, await morning(6)],
    );
    await run(await morning(8));
    expect(await autoTasks(done)).toHaveLength(1);
    await run(await morning(9));
    const after = await autoTasks(done);
    expect(after).toHaveLength(2);
    expect(after[1].status).toBe("Open");
  });
  it("skips closed or archived leads and owners who left the workspace", async () => {
    const org = await workspace();
    const lost = await lead(org, rep, "Lost");
    const archived = await lead(org);
    await user(admin);
    await rows("update public.leads set archived_at=now() where id=$1", [archived]);
    const leaver = await lead(org);
    await system();
    await rows(
      "update public.memberships set active=false where org_id=$1 and user_id=$2",
      [org, rep],
    );
    await run(await morning(5));
    for (const id of [lost, archived, leaver])
      expect(await autoTasks(id)).toHaveLength(0);
  });
  it("waits until 8 am local time and respects a switched-off workspace", async () => {
    const org = await workspace();
    const id = await lead(org);
    await run(await morning(5, "6 hours"));
    expect(await autoTasks(id)).toHaveLength(0);
    await user(admin);
    await rows(
      "update public.organizations set follow_up_enabled=false where id=$1",
      [org],
    );
    await run(await morning(5));
    expect(await autoTasks(id)).toHaveLength(0);
    await rows(
      "update public.organizations set follow_up_enabled=true,follow_up_lead_days=10 where id=$1",
      [org],
    );
    await run(await morning(6));
    expect(await autoTasks(id)).toHaveLength(0);
    await run(await morning(11));
    expect(await autoTasks(id)).toHaveLength(1);
  });
  it("follows up on a proposal the client opened but has not answered", async () => {
    const org = await workspace(false);
    await user(admin);
    const contact = (
      await rows(
        "insert into public.contacts(org_id,owner_id,name) values($1,$2,'Buyer') returning id",
        [org, admin],
      )
    )[0].id;
    const pitch = (
      await rows(
        "insert into public.pitches(org_id,owner_id,name,contact_id) values($1,$2,'Big deal',$3) returning id",
        [org, admin, contact],
      )
    )[0].id;
    const hash = "c".repeat(64);
    const [b] = await rows(
      "select public.proposal_begin($1,'client@example.com','','Proposal','',$2) v",
      [pitch, hash],
    );
    await rows("select public.proposal_finish($1,true,'re_1')", [b.v.id]);
    await system();
    await rows("select public.proposal_open($1,'Desktop')", [hash]);
    await run(await morning(2));
    expect(await autoTasks(pitch)).toHaveLength(0);
    await run(await morning(4));
    const [task] = await autoTasks(pitch);
    expect(task).toMatchObject({
      auto_rule: "proposal_no_reply",
      priority: "High",
      contact_id: contact,
      owner_id: admin,
    });
    const [digest] = await outbox(org);
    expect(digest.payload.items[0].kind).toBe("proposal");
    // Once the client answers, no further follow-ups for this proposal.
    await user(admin);
    await rows("update public.tasks set status='Completed' where id=$1", [task.id]);
    await rows("update public.pitches set status='Accepted' where id=$1", [pitch]);
    await run(await morning(30));
    expect(await autoTasks(pitch)).toHaveLength(1);
  });
  it("still creates the task but skips the email for people with reminders off", async () => {
    const org = await workspace();
    await user(rep);
    await rows("update public.profiles set notifications=false where id=$1", [rep]);
    const id = await lead(org);
    await run(await morning(5));
    expect(await autoTasks(id)).toHaveLength(1);
    expect((await outbox(org)).filter((x) => x.user_id === rep)).toHaveLength(0);
    await user(rep);
    await rows("update public.profiles set notifications=true where id=$1", [rep]);
  });
  it("tells administrators once when a paid plan ends within 7 days", async () => {
    const org = await workspace();
    const at = await morning(1);
    await system();
    await rows(
      "update public.organization_subscriptions set paid_plan_code='starter',paid_until=$2::timestamptz+interval '3 days',cancel_at_period_end=true where org_id=$1",
      [org, at],
    );
    await run(at);
    let mail = (await outbox(org)).filter((x) => x.kind === "plan_ending");
    expect(mail).toHaveLength(1);
    expect(mail[0].user_id).toBe(admin);
    expect(mail[0].payload).toMatchObject({ plan: "Starter", cancelling: true });
    await run(await morning(2));
    mail = (await outbox(org)).filter((x) => x.kind === "plan_ending");
    expect(mail).toHaveLength(1);
    await rows(
      "update public.organization_subscriptions set paid_plan_code='free',paid_until=null,cancel_at_period_end=false where org_id=$1",
      [org],
    );
  });
  it("stops members from forging or detaching automatic follow-ups", async () => {
    const org = await workspace();
    const id = await lead(org);
    await run(await morning(5));
    const [task] = await autoTasks(id);
    await user(rep);
    await expect(
      rows(
        "insert into public.tasks(org_id,owner_id,name,due_date,auto_rule,auto_source) values($1,$2,'x',current_date,'lead_untouched',$3)",
        [org, rep, id],
      ),
    ).rejects.toThrow("managed by Align");
    await expect(
      rows("update public.tasks set auto_source=null,auto_rule=null where id=$1", [task.id]),
    ).rejects.toThrow("managed by Align");
    await rows("update public.tasks set status='Completed' where id=$1", [task.id]);
    expect((await autoTasks(id))[0].status).toBe("Completed");
  });
});

describe("notification sender queue", () => {
  it("hands out each email once, retries temporary failures and stops after five", async () => {
    const org = await workspace(false);
    await system();
    await rows("delete from private.notification_outbox");
    await rows(
      "insert into private.notification_outbox(org_id,user_id,kind,dedupe_key,payload) values($1,$2,'follow_up_digest','t1','{}'),($1,$2,'follow_up_digest','t2','{}')",
      [org, admin],
    );
    const claimed = (await rows("select public.notifications_claim(10) v"))[0].v;
    expect(claimed).toHaveLength(2);
    expect(claimed[0].email).toMatch(/^admin\d+@test\.invalid$/);
    expect(claimed[0].name).toBe("Admin Person");
    expect((await rows("select public.notifications_claim(10) v"))[0].v).toHaveLength(0);
    const [ok, retry] = claimed;
    await rows("select public.notifications_finish($1,true,'re_9')", [ok.id]);
    await rows("select public.notifications_finish($1,false,null,'Rate limited')", [retry.id]);
    const again = (await rows("select public.notifications_claim(10) v"))[0].v;
    expect(again.map((x: any) => x.id)).toEqual([retry.id]);
    for (let i = 0; i < 4; i++) {
      await rows("select public.notifications_finish($1,false,null,'Down')", [retry.id]);
      await rows("select public.notifications_claim(10)");
    }
    const final = await rows(
      "select dedupe_key,status,attempts,last_error from private.notification_outbox order by dedupe_key",
    );
    expect(final[0]).toMatchObject({ dedupe_key: "t1", status: "sent" });
    expect(final[1]).toMatchObject({ status: "failed", attempts: 5, last_error: "Down" });
  });
  it("fails permanently refused emails straight away", async () => {
    const org = await workspace(false);
    await system();
    await rows("delete from private.notification_outbox");
    await rows(
      "insert into private.notification_outbox(org_id,user_id,kind,dedupe_key) values($1,$2,'plan_ending','p1')",
      [org, admin],
    );
    const [item] = (await rows("select public.notifications_claim(5) v"))[0].v;
    await rows(
      "select public.notifications_finish($1,false,null,'Testing emails only to your own address',true)",
      [item.id],
    );
    expect(
      (await rows("select status from private.notification_outbox where id=$1", [item.id]))[0].status,
    ).toBe("failed");
  });
  it("keeps the queue and the job away from signed-in users", async () => {
    await user(admin);
    await expect(rows("select public.notifications_claim(5)")).rejects.toThrow("permission denied");
    await expect(
      rows("select public.notifications_validate_job_token($1)", ["x".repeat(64)]),
    ).rejects.toThrow("permission denied");
    await expect(rows("select private.run_follow_ups()")).rejects.toThrow("permission denied");
    await expect(rows("select * from private.notification_outbox")).rejects.toThrow();
    await system();
    // Without Vault (as in these tests) no credential is ever accepted.
    expect(
      (await rows("select public.notifications_validate_job_token($1) v", ["x".repeat(64)]))[0].v,
    ).toBe(false);
  });
  it("keeps proposal sending behind thin wrappers around private functions", async () => {
    await system();
    const fns = await rows(
      "select n.nspname schema,p.proname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('proposal_begin','proposal_finish','proposal_revoke') order by 1,2",
    );
    expect(fns.filter((f: any) => f.schema === "public").every((f: any) => !f.prosecdef)).toBe(true);
    expect(fns.filter((f: any) => f.schema === "private").every((f: any) => f.prosecdef)).toBe(true);
    expect(fns).toHaveLength(6);
  });
});
