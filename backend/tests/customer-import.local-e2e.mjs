// Local-only import acceptance. The imported regression runner validates the isolated
// Docker project identity and loopback API before obtaining any local credentials.
import {
  test,
  ensure,
  user,
  rest,
  rpc,
  sql,
  request,
} from "./customization.local-e2e.mjs";
import { randomUUID } from "node:crypto";
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
let admin, rep, outside, org, other;
const invoke = (u, operation, j = null, p = {}, o = org) =>
  rpc("contact_import", u, { o, operation, j, p });
const input = (
  name = "Import person",
  email = randomUUID() + "@example.invalid",
  extra = {},
) => ({
  row_no: 2,
  payload: { name, email, ...extra },
  source: [name, email],
  client_error: "",
});
async function stage(inputs, policy = "skip", u = admin) {
  const c = await invoke(u, "create", null, {
    file_name: "local-test.csv",
    headers: ["Name", "Email"],
    rows: inputs.length,
    policy,
    file_meta: {
      sha256: "c".repeat(64),
      mapping: ["name", "email"],
      sheet: "CSV",
    },
  });
  ensure(c.ok, "Create import rejected");
  const j = c.data.id;
  for (let i = 0; i < inputs.length; i += 25)
    ensure(
      (
        await invoke(u, "append", j, {
          rows: inputs
            .slice(i, i + 25)
            .map((r, k) => ({ ...r, row_no: i + k + 2 })),
        })
      ).ok,
      "Append rejected",
    );
  ensure((await invoke(u, "seal", j)).ok, "Seal rejected");
  let r = await invoke(u, "review", j);
  ensure(r.ok, "Review rejected");
  while (r.data.job.state === "reviewing") {
    r = await invoke(u, "review", j);
    ensure(r.ok, "Bounded review rejected");
  }
  return r.data;
}
async function finish(p, u = admin) {
  const j = p.job.id;
  ensure(
    (await invoke(u, "confirm", j, { confirmation: p.job.confirmation })).ok,
    "Confirmation rejected",
  );
  let r = await invoke(u, "status", j, { filter: "pending" });
  ensure(r.ok, "Progress read rejected");
  while (r.data.rows.length) {
    ensure(
      (
        await invoke(u, "batch", j, {
          rows: r.data.rows.map((x) => ({
            retry_id: x.retry_id,
            target_id: x.target_id,
          })),
        })
      ).ok,
      "Commit rejected",
    );
    r = await invoke(u, "status", j, { filter: "pending" });
    ensure(r.ok, "Progress read rejected");
  }
  return r.data;
}
const clear = () =>
  sql("delete from private.contact_import_jobs where org_id=" + quote(org));
try {
  await test("import: real users/workspaces and ten migrations including isolated cleanup job", async () => {
    admin = await user();
    rep = await user();
    outside = await user();
    let r = await rpc("create_workspace", admin, {
      n: "Local import A",
      person: "Import administrator",
    });
    ensure(r.ok, "Workspace failed");
    org = r.data;
    r = await rpc("create_workspace", outside, {
      n: "Local import B",
      person: "Outside administrator",
    });
    ensure(r.ok, "Other workspace failed");
    other = r.data;
    ensure(
      (
        await rpc("manage_member", admin, {
          o: org,
          email_address: rep.email,
          member_role: "Sales Representative",
        })
      ).ok,
      "Representative setup failed",
    );
    ensure(
      sql(
        "select count(*) from cron.job where jobname='align-contact-import-cleanup'",
      ) === "1",
      "Separate cleanup job is missing",
    );
    ensure(
      sql(
        "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('contact_import_jobs','contact_import_rows') and c.relrowsecurity",
      ) === "2",
      "Private staging RLS missing",
    );
  });
  await test("import: duplicate preview precedes writes; skip checks email, phone and in-file duplicates", async () => {
    clear();
    const email = randomUUID() + "@example.invalid";
    ensure(
      (
        await rest(
          "contacts",
          admin,
          {
            org_id: org,
            owner_id: admin.id,
            name: "Existing",
            email,
            phone: "+91 (999) 123-4567",
          },
          "POST",
        )
      ).ok,
      "Existing contact failed",
    );
    const same = randomUUID() + "@example.invalid";
    const p = await stage([
      input("Email match", email.toUpperCase()),
      input("Phone match", undefined, { phone: "919991234567" }),
      input("First", same),
      input("Second", same),
    ]);
    ensure(p.counts.duplicates === 3, "Duplicate preview is incorrect");
    ensure(
      sql("select count(*) from public.contacts where org_id=" + quote(org)) ===
        "1",
      "Preview wrote contacts",
    );
    const f = await finish(p);
    ensure(
      f.counts.imported === 1 &&
        f.counts.skipped === 3 &&
        f.counts.failed === 0,
      "Skip summary incorrect",
    );
  });
  await test("import: explicit update targets, half-finished resume and replay are idempotent", async () => {
    clear();
    const same = randomUUID() + "@example.invalid";
    const p = await stage(
      [input("First", same), input("Updated", same)],
      "update",
    );
    ensure(
      p.rows[0].target_id === p.rows[1].target_id,
      "Planned target mismatch",
    );
    ensure(
      (
        await invoke(admin, "confirm", p.job.id, {
          confirmation: p.job.confirmation,
        })
      ).ok,
      "Confirm failed",
    );
    const first = {
      rows: [{ retry_id: p.rows[0].retry_id, target_id: p.rows[0].target_id }],
    };
    ensure(
      (await invoke(admin, "batch", p.job.id, first)).ok,
      "First partial commit failed",
    );
    ensure(
      (await invoke(admin, "batch", p.job.id, first)).ok,
      "Lost-response replay failed",
    );
    let pending = await invoke(admin, "status", p.job.id, {
      filter: "pending",
    });
    ensure(pending.data.rows.length === 1, "Resume progress wrong");
    ensure(
      (
        await invoke(admin, "batch", p.job.id, {
          rows: pending.data.rows.map((x) => ({
            retry_id: x.retry_id,
            target_id: x.target_id,
          })),
        })
      ).ok,
      "Resume commit failed",
    );
    ensure(
      sql(
        "select count(*) from public.contacts where org_id=" +
          quote(org) +
          " and email=" +
          quote(same),
      ) === "1",
      "Retry duplicated a contact",
    );
    const final = await invoke(admin, "status", p.job.id);
    ensure(
      final.data.counts.imported === 2 && final.data.counts.updated === 1,
      "Update report incorrect",
    );
  });
  await test("import: cross-workspace/user access and anonymous/private-table access denied", async () => {
    clear();
    const p = await stage([input()]);
    ensure(
      !(await invoke(outside, "status", p.job.id)).ok,
      "Other workspace read accepted",
    );
    ensure(
      !(await invoke(outside, "status", p.job.id, {}, other)).ok,
      "Forged workspace read accepted",
    );
    ensure(
      !(await invoke(rep, "status", p.job.id)).ok,
      "Other user read accepted",
    );
    ensure(
      !(
        await request("/rest/v1/rpc/contact_import", null, {
          o: org,
          operation: "list",
          j: null,
          p: {},
        })
      ).ok,
      "Anonymous import accepted",
    );
    ensure(
      !(await rest("contact_import_rows", admin)).ok,
      "Private staging exposed through Data API",
    );
    ensure(
      !(
        await invoke(admin, "batch", p.job.id, {
          rows: [{ retry_id: p.rows[0].retry_id, target_id: randomUUID() }],
        })
      ).ok,
      "Unconfirmed forged target accepted",
    );
  });
  await test("import: representative cannot edit another owner; permission is rechecked after preview", async () => {
    clear();
    const email = randomUUID() + "@example.invalid";
    const c = await rest(
      "contacts",
      admin,
      { org_id: org, owner_id: admin.id, name: "Admin owns", email },
      "POST",
    );
    ensure(c.ok, "Owned contact failed");
    const p = await stage([input("Forbidden update", email)], "update", rep);
    ensure(p.counts.errors === 1, "Owner denial missing from preview");
    ensure(
      (await finish(p, rep)).counts.failed === 1,
      "Forbidden row committed",
    );
    clear();
    const e = randomUUID() + "@example.invalid";
    const own = await rest(
      "contacts",
      rep,
      { org_id: org, owner_id: rep.id, name: "Representative owns", email: e },
      "POST",
    );
    ensure(own.ok, "Own contact failed");
    const q = await stage([input("Ownership changed", e)], "update", rep);
    ensure(q.counts.errors === 0, "Own contact unexpectedly denied");
    ensure(
      (
        await rest(
          "contacts",
          admin,
          { owner_id: admin.id },
          "PATCH",
          "?id=eq." + own.data[0].id,
        )
      ).ok,
      "Ownership change failed",
    );
    ensure(
      (await finish(q, rep)).counts.failed === 1,
      "Ownership change bypassed",
    );
  });
  await test("import: quota failures roll back each row while preserving completed rows", async () => {
    clear();
    const n = Number(
      sql("select count(*) from public.contacts where org_id=" + quote(org)),
    );
    try {
      sql(
        "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}'," +
          quote(String(n + 1)) +
          "::jsonb) where code='free'",
      );
      const p = await stage([input(), input()]);
      const f = await finish(p);
      ensure(
        f.counts.imported === 1 && f.counts.failed === 1,
        "Quota not enforced",
      );
    } finally {
      sql(
        "update public.subscription_plans set limits=jsonb_set(limits,'{contacts}','200') where code='free'",
      );
    }
  });
  await test("import: current custom fields validate on commit and preserve zero/No and archived data", async () => {
    clear();
    const field = await rest(
      "custom_field_definitions",
      admin,
      { org_id: org, entity: "contacts", name: "Score", field_type: "number" },
      "POST",
    );
    ensure(field.ok, "Custom field failed");
    const id = field.data[0].id;
    const p = await stage([
      input("Zero value", undefined, { custom_values: { [id]: 0 } }),
    ]);
    ensure((await finish(p)).counts.imported === 1, "Typed import failed");
    const c = await rest(
      "contacts",
      admin,
      undefined,
      "GET",
      "?id=eq." + p.rows[0].target_id,
    );
    ensure(c.data[0].custom_values[id] === 0, "Zero lost");
    clear();
    const q = await stage([
      input("Archived after preview", undefined, {
        custom_values: { [id]: 2 },
      }),
    ]);
    ensure(
      (
        await rest(
          "custom_field_definitions",
          admin,
          { archived_at: new Date().toISOString() },
          "PATCH",
          "?id=eq." + id,
        )
      ).ok,
      "Archive failed",
    );
    ensure(
      (await finish(q)).counts.failed === 1,
      "Archived field changed after preview",
    );
  });
  await test("import: server rejects formula rows, invalid metadata and oversized batches", async () => {
    clear();
    const p = await stage([
      { ...input(), source: [' =HYPERLINK("bad")', "x"] },
    ]);
    ensure(p.counts.errors === 1, "Formula preview accepted");
    ensure((await finish(p)).counts.failed === 1, "Formula committed");
    ensure(
      !(
        await invoke(admin, "create", null, {
          file_name: "x.csv",
          headers: ["Name"],
          rows: 10001,
          policy: "skip",
          file_meta: {
            sha256: "a".repeat(64),
            mapping: ["name"],
            sheet: "CSV",
          },
        })
      ).ok,
      "Excess rows accepted",
    );
    const c = await invoke(admin, "create", null, {
      file_name: "x.csv",
      headers: ["Name"],
      rows: 1,
      policy: "skip",
      file_meta: { sha256: "a".repeat(64), mapping: ["name"], sheet: "CSV" },
    });
    ensure(c.ok, "Boundary job failed");
    ensure(
      !(
        await invoke(admin, "append", c.data.id, {
          rows: Array.from({ length: 26 }, (_, i) => ({
            ...input(),
            row_no: i + 2,
          })),
        })
      ).ok,
      "Excess batch accepted",
    );
    ensure(
      !(
        await invoke(admin, "append", c.data.id, {
          rows: [{ ...input(), source: ["x".repeat(100000)] }],
        })
      ).ok,
      "Excess payload accepted",
    );
  });
  await test("import: duplicate-heavy input is reviewed in bounded batches", async () => {
    clear();
    const same = randomUUID() + "@example.invalid";
    const p = await stage(
      Array.from({ length: 1000 }, () => input("Repeated", same)),
    );
    ensure(
      p.counts.reviewed === 1000 &&
        p.counts.duplicates === 999 &&
        p.counts.errors === 0,
      "Heavy duplicate review incorrect",
    );
    const f = await finish(p);
    ensure(
      f.counts.imported === 1 && f.counts.skipped === 999,
      "Heavy duplicate commit incorrect",
    );
  });
  await test("import: idle/MFA/session guards, expiry and cleanup apply to the new endpoint", async () => {
    clear();
    const p = await stage([input()]);
    sql(
      "update private.security_sessions set last_active=now()-interval '31 minutes' where user_id=" +
        quote(admin.id),
    );
    ensure(
      !(await invoke(admin, "status", p.job.id)).ok,
      "Idle session read import",
    );
    sql(
      "update private.security_sessions set last_active=now() where user_id=" +
        quote(admin.id),
    );
    sql(
      "insert into private.security_accounts(user_id,enabled_at) values(" +
        quote(admin.id) +
        ",now()) on conflict(user_id) do update set enabled_at=now()",
    );
    ensure(
      !(await invoke(admin, "status", p.job.id)).ok,
      "Unverified MFA read import",
    );
    sql(
      "delete from private.security_accounts where user_id=" + quote(admin.id),
    );
    sql(
      "update private.security_sessions set revoked_at=now() where user_id=" +
        quote(admin.id),
    );
    ensure(
      !(await invoke(admin, "status", p.job.id)).ok,
      "Revoked session read import",
    );
    sql(
      "update private.security_sessions set revoked_at=null where user_id=" +
        quote(admin.id),
    );
    sql(
      "update private.contact_import_jobs set expires_at=now()-interval '1 second' where id=" +
        quote(p.job.id),
    );
    ensure(
      !(await invoke(admin, "status", p.job.id)).ok,
      "Expired job read accepted",
    );
    sql("select private.cleanup_contact_imports()");
    ensure(
      sql(
        "select count(*) from private.contact_import_jobs where id=" +
          quote(p.job.id),
      ) === "0",
      "Cleanup did not delete job",
    );
    ensure(
      sql(
        "select count(*) from private.contact_import_rows where job_id=" +
          quote(p.job.id),
      ) === "0",
      "Cleanup did not cascade private rows",
    );
  });
  console.log(
    "Import local acceptance: 10 grouped checks passed after the existing security/billing/custom-fields regression checks. Local Docker only.",
  );
} catch {
  console.log(
    "Import local acceptance stopped; sensitive response bodies withheld.",
  );
  process.exitCode = 1;
}
