import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const [admin, rep, outside] = Array.from({ length: 3 }, () =>
  crypto.randomUUID(),
);
const sessions = new Map(
  [admin, rep, outside].map((u) => [u, crypto.randomUUID()]),
);
let org: string, other: string;
const rows = async (sql: string, args: unknown[] = []) =>
  (await db.query<any>(sql, args)).rows;
async function user(u = admin) {
  await db.exec("reset role");
  await rows(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [u, JSON.stringify({ session_id: sessions.get(u) })],
  );
  await db.exec("set role authenticated");
}
async function rpc(
  operation: string,
  j: string | null = null,
  p: any = {},
  o = org,
) {
  return (
    await rows("select public.contact_import($1,$2,$3,$4) value", [
      o,
      operation,
      j,
      p,
    ])
  )[0].value;
}
const input = (
  name = "Alice",
  email = crypto.randomUUID() + "@example.invalid",
  extra: any = {},
) => ({
  row_no: 2,
  payload: { name, email, ...extra },
  source: [name, email],
  client_error: "",
});
async function stage(inputs: any[], policy = "skip") {
  const job = await rpc("create", null, {
    file_name: "test.csv",
    headers: ["Name", "Email"],
    rows: inputs.length,
    policy,
    file_meta: {
      sha256: "a".repeat(64),
      mapping: ["name", "email"],
      sheet: "CSV",
    },
  });
  const id = job.id;
  for (let i = 0; i < inputs.length; i += 25)
    await rpc("append", id, {
      rows: inputs
        .slice(i, i + 25)
        .map((r, k) => ({ ...r, row_no: i + k + 2 })),
    });
  await rpc("seal", id);
  let preview = await rpc("review", id);
  while (preview.job.state === "reviewing") preview = await rpc("review", id);
  return preview;
}
async function finish(preview: any) {
  const id = preview.job.id;
  await rpc("confirm", id, { confirmation: preview.job.confirmation });
  let s = await rpc("status", id, { filter: "pending" });
  while (s.rows.length) {
    await rpc("batch", id, {
      rows: s.rows.map((r: any) => ({
        retry_id: r.retry_id,
        target_id: r.target_id,
      })),
    });
    s = await rpc("status", id, { filter: "pending" });
  }
  return s;
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  for (const file of readdirSync("database/supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync("database/supabase/migrations/" + file, "utf8"));
  for (const u of sessions.keys()) {
    await rows("insert into auth.users values($1,$2)", [
      u,
      u + "@test.invalid",
    ]);
    await rows("insert into auth.sessions(id,user_id) values($1,$2)", [
      sessions.get(u),
      u,
    ]);
    await rows(
      "insert into private.security_sessions(session_id,user_id) values($1,$2)",
      [sessions.get(u), u],
    );
  }
  await user();
  org = (await rows("select public.create_workspace('Import A','Admin') id"))[0]
    .id;
  await rows("select public.manage_member($1,$2,'Sales Representative')", [
    org,
    rep + "@test.invalid",
  ]);
  await user(outside);
  other = (
    await rows("select public.create_workspace('Import B','Outside') id")
  )[0].id;
}, 30000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec("reset role");
  await db.exec("delete from private.contact_import_jobs");
  await rows(
    "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}','200') where code='free'",
  );
  await rows(
    "update private.security_sessions set last_active=now(),revoked_at=null,verified_at=now()",
  );
  await rows("delete from private.security_accounts");
  await user();
});
describe("transactional, private contact import", () => {
  it("normalizes email/phone and skips duplicates against existing records and inside a file", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email,phone) values($1,$2,'Existing',$3,'+91 (999) 123-4567')",
      [org, admin, email],
    );
    const p = await stage([
      input("Duplicate", email.toUpperCase()),
      input("Phone", "unique@example.invalid", { phone: "919991234567" }),
      input("New"),
      input("Again", "same@example.invalid"),
      input("Same", "same@example.invalid"),
    ]);
    expect(p.counts.duplicates).toBe(3);
    const final = await finish(p);
    expect(final.counts).toMatchObject({ imported: 2, skipped: 3, failed: 0 });
  });
  it("updates an explicit existing target and keeps owner, empty fields, and company links", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    const c = (
      await rows(
        "insert into public.contacts(org_id,owner_id,name,email,notes) values($1,$2,'Before',$3,'Keep') returning id",
        [org, admin, email],
      )
    )[0];
    const p = await stage([input("After", email)], "update");
    expect(p.rows[0].target_id).toBe(c.id);
    expect((await finish(p)).counts.updated).toBe(1);
    expect(
      (
        await rows(
          "select name,notes,owner_id from public.contacts where id=$1",
          [c.id],
        )
      )[0],
    ).toEqual({ name: "After", notes: "Keep", owner_id: admin });
  });
  it("uses planned IDs for duplicates inside a file and retries a completed batch without a second write", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    const p = await stage(
      [input("First", email), input("Second", email)],
      "update",
    );
    expect(p.rows[1].target_id).toBe(p.rows[0].target_id);
    const request = {
      rows: p.rows.map((r: any) => ({
        retry_id: r.retry_id,
        target_id: r.target_id,
      })),
    };
    await rpc("confirm", p.job.id, { confirmation: p.job.confirmation });
    await rpc("batch", p.job.id, request);
    await rpc("batch", p.job.id, request);
    expect(
      await rows(
        "select name from public.contacts where org_id=$1 and email=$2",
        [org, email],
      ),
    ).toEqual([{ name: "Second" }]);
  });
  it("keeps staging upload retries idempotent and rejects a changed retry", async () => {
    const j = await rpc("create", null, {
      file_name: "x.csv",
      headers: ["Name", "Email"],
      rows: 1,
      policy: "skip",
      file_meta: {
        sha256: "b".repeat(64),
        mapping: ["name", "email"],
        sheet: "CSV",
      },
    });
    const row = input();
    await rpc("append", j.id, { rows: [row] });
    await rpc("append", j.id, { rows: [row] });
    expect((await rpc("status", j.id)).counts.staged).toBe(1);
    await expect(
      rpc("append", j.id, {
        rows: [{ ...row, payload: { ...row.payload, name: "changed" } }],
      }),
    ).rejects.toThrow("differs");
    await expect(
      rpc("confirm", j.id, { confirmation: crypto.randomUUID() }),
    ).rejects.toThrow("Review");
  });
  it("denies forged targets, another user in the same workspace, and another workspace", async () => {
    const p = await stage([input()]);
    await rpc("confirm", p.job.id, { confirmation: p.job.confirmation });
    await expect(
      rpc("batch", p.job.id, {
        rows: [
          { retry_id: p.rows[0].retry_id, target_id: crypto.randomUUID() },
        ],
      }),
    ).rejects.toThrow("target");
    await user(rep);
    await expect(rpc("status", p.job.id)).rejects.toThrow("unavailable");
    await user(outside);
    await expect(rpc("status", p.job.id, {}, org)).rejects.toThrow("Workspace");
    await expect(rpc("status", p.job.id, {}, other)).rejects.toThrow(
      "unavailable",
    );
    await expect(
      rows("select * from private.contact_import_rows"),
    ).rejects.toThrow("permission");
  });
  it("rejects representative updates to someone else’s records in preview and after ownership changes", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Owner',$3)",
      [org, admin, email],
    );
    await user(rep);
    const p = await stage([input("No", email)], "update");
    expect(p.counts.errors).toBe(1);
    expect((await finish(p)).counts.failed).toBe(1);
    const ownEmail = crypto.randomUUID() + "@example.invalid";
    const own = (
      await rows(
        "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Own',$3) returning id",
        [org, rep, ownEmail],
      )
    )[0];
    const q = await stage([input("Changed", ownEmail)], "update");
    await user();
    await rows("update public.contacts set owner_id=$1 where id=$2", [
      admin,
      own.id,
    ]);
    await user(rep);
    expect((await finish(q)).counts.failed).toBe(1);
  });
  it("enforces plan quotas during each row transaction without partial duplicate effects", async () => {
    await db.exec("reset role");
    const n = (
      await rows(
        "select count(*)::int n from public.contacts where org_id=$1",
        [org],
      )
    )[0].n;
    await rows(
      "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}',$1::jsonb) where code='free'",
      [String(n + 1)],
    );
    await user();
    const p = await stage([input(), input()]);
    const f = await finish(p);
    expect(f.counts).toMatchObject({ imported: 1, failed: 1 });
  });
  it("rechecks preservation after preview and leaves retained contacts unchanged", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    const created = (
      await rows(
        "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Preserve me',$3) returning id",
        [org, admin, email],
      )
    )[0];
    const p = await stage([input("Should not change", email)], "update");
    expect(p.counts.errors).toBe(0);
    await db.exec("reset role");
    const n = (
      await rows(
        "select count(*)::int n from public.contacts where org_id=$1",
        [org],
      )
    )[0].n;
    await rows(
      "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}',$1::jsonb) where code='free'",
      [String(n - 1)],
    );
    await rows(
      "update public.organization_subscriptions set limits_reduced_at=now() where org_id=$1",
      [org],
    );
    await user();
    const result = await finish(p);
    expect(result.counts.failed).toBe(1);
    expect(
      (
        await rows("select name from public.contacts where id=$1", [created.id])
      )[0].name,
    ).toBe("Preserve me");
    await db.exec("reset role");
    await rows(
      "update public.organization_subscriptions set limits_reduced_at=null where org_id=$1",
      [org],
    );
  });
  it("fails safely when duplicates change between preview and commit", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    const p = await stage([input("Preview", email)]);
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email) values($1,$2,'Concurrent',$3)",
      [org, admin, email],
    );
    const f = await finish(p);
    expect(f.counts.failed).toBe(1);
    expect(f.rows).toHaveLength(0);
    expect((await rpc("status", p.job.id)).rows[0].error).toContain(
      "Duplicates changed",
    );
  });
  it("validates mapped custom fields on the server and preserves zero/No", async () => {
    const a = (
      await rows(
        "insert into public.custom_field_definitions(org_id,entity,name,field_type) values($1,'contacts',$2,'number') returning id",
        [org, "Score " + crypto.randomUUID()],
      )
    )[0].id;
    const b = (
      await rows(
        "insert into public.custom_field_definitions(org_id,entity,name,field_type) values($1,'contacts',$2,'boolean') returning id",
        [org, "VIP " + crypto.randomUUID()],
      )
    )[0].id;
    const p = await stage([
      input("Typed", undefined, { custom_values: { [a]: 0, [b]: false } }),
    ]);
    await finish(p);
    expect(
      (
        await rows("select custom_values from public.contacts where id=$1", [
          p.rows[0].target_id,
        ])
      )[0].custom_values,
    ).toEqual({ [a]: 0, [b]: false });
    const q = await stage([
      input("Bad", undefined, { custom_values: { [a]: "not a number" } }),
    ]);
    expect(q.counts.errors).toBe(1);
  });
  it("rejects formula cells and ambiguous duplicates before writes", async () => {
    const p = await stage([
      { ...input(), source: [' =HYPERLINK("bad")', "email"] },
    ]);
    expect(p.counts.errors).toBe(1);
    expect((await finish(p)).counts.failed).toBe(1);
    const email = crypto.randomUUID() + "@example.invalid";
    await rows(
      "insert into public.contacts(org_id,owner_id,name,email,phone) values($1,$2,'A',$3,''),($1,$2,'B',$4,'12125550199')",
      [org, admin, email, crypto.randomUUID() + "@example.invalid"],
    );
    const q = await stage(
      [input("Ambiguous", email, { phone: "12125550199" })],
      "update",
    );
    expect(q.counts.errors).toBe(1);
  });
  it("checks idle expiry, revocation and the MFA latch on every request", async () => {
    const p = await stage([input()]);
    await db.exec("reset role");
    await rows(
      "update private.security_sessions set last_active=now()-interval '31 minutes' where user_id=$1",
      [admin],
    );
    await user();
    await expect(rpc("status", p.job.id)).rejects.toThrow("Verify");
    await db.exec("reset role");
    await rows(
      "update private.security_sessions set last_active=now(),revoked_at=now() where user_id=$1",
      [admin],
    );
    await user();
    await expect(rpc("status", p.job.id)).rejects.toThrow("Verify");
    await db.exec("reset role");
    await rows(
      "update private.security_sessions set revoked_at=null,verified_at=null where user_id=$1",
      [admin],
    );
    await rows(
      "insert into private.security_accounts(user_id,enabled_at) values($1,now())",
      [admin],
    );
    await user();
    await expect(rpc("status", p.job.id)).rejects.toThrow("Verify");
  });
  it("expires and cleans private rows; cancellation cannot undo contacts already committed", async () => {
    const p = await stage([input()]);
    await finish(p);
    await rpc("cancel", p.job.id);
    expect((await rpc("status", p.job.id)).counts.staged).toBe(0);
    expect(
      await rows("select id from public.contacts where id=$1", [
        p.rows[0].target_id,
      ]),
    ).toHaveLength(1);
    const q = await stage([input()]);
    await db.exec("reset role");
    await rows(
      "update private.contact_import_jobs set expires_at=now()-interval '1 second' where id=$1",
      [q.job.id],
    );
    await user();
    await expect(rpc("status", q.job.id)).rejects.toThrow("expired");
    await expect(
      rows("select private.cleanup_contact_imports()"),
    ).rejects.toThrow("permission");
    await db.exec("reset role");
    expect(
      (await rows("select private.cleanup_contact_imports() n"))[0].n,
    ).toBe(1);
  });
  it("handles a duplicate-heavy file in bounded reviews", async () => {
    const email = crypto.randomUUID() + "@example.invalid";
    const p = await stage(
      Array.from({ length: 300 }, () => input("Repeated", email)),
    );
    expect(p.counts).toMatchObject({
      reviewed: 300,
      duplicates: 299,
      errors: 0,
    });
  }, 15000);
  it("denies anonymous RPCs and direct staging DML and keeps both private tables under RLS", async () => {
    await db.exec("reset role;set role anon");
    await expect(rpc("list")).rejects.toThrow("permission");
    await user();
    await expect(
      rows(
        "insert into private.contact_import_jobs(org_id,owner_id,file_name,headers,file_meta,expected_rows,duplicate_policy) values($1,$2,'bad','[]','{}',1,'skip')",
        [org, admin],
      ),
    ).rejects.toThrow("permission");
    await db.exec("reset role");
    const t = await rows(
      "select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and relname in ('contact_import_jobs','contact_import_rows')",
    );
    expect(t).toHaveLength(2);
    expect(t.every((x) => x.relrowsecurity)).toBe(true);
  });
});
