// Real local Docker acceptance checks. Never accepts a hosted URL or project reference.
// Usage: node backend/tests/customization.local-e2e.mjs <unlinked-local-workdir>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";

const root = process.argv[2];
if (
  !root ||
  !readFileSync(root + "/supabase/config.toml", "utf8").includes(
    'project_id = "align-fields-local-test"',
  )
)
  throw new Error("Use the isolated local test project only");
const cli = spawnSync(
  "npx",
  ["--no-install", "supabase", "--workdir", root, "status", "-o", "json"],
  { encoding: "utf8" },
);
if (cli.status !== 0) throw new Error("Local status failed; output withheld");
const local = JSON.parse(cli.stdout);
const base = local.API_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw new Error("Non-local target refused");
const anon = local.ANON_KEY,
  service = local.SERVICE_ROLE_KEY;
const origin = "http://127.0.0.1:5175";
const results = [];
const ensure = (condition, label) => {
  if (!condition) throw new Error(label);
};
async function test(name, run) {
  try {
    await run();
    results.push({ name, result: "PASS" });
    console.log("PASS: " + name);
  } catch (error) {
    results.push({ name, result: "FAIL" });
    console.log(
      "FAIL: " +
        name +
        "; " +
        (error instanceof Error ? error.message : "assertion failed"),
    );
    throw new Error("Local acceptance stopped at: " + name);
  }
}
async function request(path, token, body, method = "POST", adminKey = false) {
  const response = await fetch(base + path, {
    method,
    headers: {
      apikey: adminKey ? service : anon,
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Origin: origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data };
}
const rest = (table, user, body, method = "GET", query = "") =>
  request("/rest/v1/" + table + query, user?.token, body, method);
async function security(user, action, payload = {}) {
  const response = await request(
    "/functions/v1/account-security",
    user?.token,
    { action, ...payload },
  );
  if (response.data?.session?.access_token && user)
    user.token = response.data.session.access_token;
  return response;
}
const billing = (user, org) =>
  request("/functions/v1/crm-billing", user?.token, {
    action: "configuration",
    org_id: org,
  });
async function rpc(name, user, body) {
  return request("/rest/v1/rpc/" + name, user.token, body);
}
async function user() {
  const email = randomUUID() + "@local-test.invalid",
    password = "Local-" + randomUUID() + "!";
  const created = await request(
    "/auth/v1/admin/users",
    service,
    { email, password, email_confirm: true },
    "POST",
    true,
  );
  ensure(created.ok, "Test user creation failed");
  const u = { id: created.data.id, email, password };
  return login(u);
}
async function login(user) {
  const response = await request("/auth/v1/token?grant_type=password", null, {
    email: user.email,
    password: user.password,
  });
  ensure(response.ok && response.data.access_token, "Native test login failed");
  const signed = { ...user, token: response.data.access_token };
  ensure(
    (await security(signed, "register")).ok,
    "Session registration failed",
  );
  return signed;
}
function sql(statement) {
  const response = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_align-fields-local-test",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: statement, encoding: "utf8" },
  );
  ensure(
    response.status === 0,
    "Local SQL assertion failed; database output withheld",
  );
  return response.stdout.trim();
}
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sid = (user) =>
  JSON.parse(Buffer.from(user.token.split(".")[1], "base64url")).session_id;
const hash = (value) => createHash("sha256").update(value).digest("hex");
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(
    (bits.match(/.{8}/g) || []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(
    6,
    "0",
  );
}
let usedTotp;
async function freshTotp(secret) {
  while (totp(secret) === usedTotp)
    await new Promise((resolve) => setTimeout(resolve, 500));
  usedTotp = totp(secret);
  return usedTotp;
}
const invalidTotp = (secret) =>
  totp(secret) === "000000" ? "111111" : "000000";
const configuration = (columns = ["name"], params = {}) => ({
  version: 1,
  columns,
  params,
});
let admin,
  representative,
  outsider,
  org,
  otherOrg,
  record,
  textField,
  numberField,
  boolField,
  shared,
  secret,
  codes;
try {
  await test("all nine migrations applied; password hook remains disabled", async () => {
    ensure(
      Number(
        sql("select count(*) from supabase_migrations.schema_migrations"),
      ) === 9,
      "Unexpected migration history",
    );
    const inspect = spawnSync(
      "docker",
      [
        "inspect",
        "supabase_auth_align-fields-local-test",
        "--format",
        "{{json .Config.Env}}",
      ],
      { encoding: "utf8" },
    );
    ensure(inspect.status === 0, "Auth container unavailable");
    ensure(
      !JSON.parse(inspect.stdout).some((v) =>
        /HOOK_PASSWORD_VERIFICATION.*ENABLED=true/i.test(v),
      ),
      "Password hook is unexpectedly enabled",
    );
    ensure(
      Number(
        sql(
          "select count(*) from pg_policies where schemaname='public' and tablename in ('custom_field_definitions','saved_views') and policyname='account_security' and permissive='RESTRICTIVE'",
        ),
      ) === 2,
      "Missing new-table session policies",
    );
  });
  await test("anonymous functions deny access; real users and workspaces work", async () => {
    ensure(
      (await security(null, "status")).status === 401,
      "Anonymous security access",
    );
    ensure(
      (await billing(null, randomUUID())).status === 401,
      "Anonymous billing access",
    );
    admin = await user();
    representative = await user();
    outsider = await user();
    const a = await rpc("create_workspace", admin, {
      n: "Local custom fields",
      person: "Local administrator",
    });
    ensure(a.ok, "Workspace A creation failed");
    org = a.data;
    const b = await rpc("create_workspace", outsider, {
      n: "Other local workspace",
      person: "Other administrator",
    });
    ensure(b.ok, "Workspace B creation failed");
    otherOrg = b.data;
    ensure(
      (
        await rpc("manage_member", admin, {
          o: org,
          email_address: representative.email,
          member_role: "Sales Representative",
        })
      ).ok,
      "Representative membership failed",
    );
  });
  await test("typed custom fields and normal CRUD through the real Data API", async () => {
    async function create(type, entity = "leads", options = []) {
      const response = await rest(
        "custom_field_definitions",
        admin,
        {
          org_id: org,
          entity,
          name: type + " " + entity,
          field_type: type,
          options,
        },
        "POST",
      );
      ensure(response.ok, "Field creation failed");
      return response.data[0];
    }
    textField = await create("text");
    numberField = await create("number");
    boolField = await create("boolean");
    const date = await create("date"),
      dropdown = await create("dropdown", "leads", ["Gold", "Silver"]),
      contact = await create("text", "contacts");
    const values = {
      [textField.id]: "100%_ target",
      [numberField.id]: 12,
      [boolField.id]: false,
      [date.id]: "2028-02-29",
      [dropdown.id]: "Gold",
    };
    const response = await rest(
      "leads",
      admin,
      {
        org_id: org,
        owner_id: admin.id,
        name: "Typed lead",
        custom_values: values,
      },
      "POST",
    );
    ensure(response.ok, "Typed lead creation failed");
    record = response.data[0];
    ensure(
      record.custom_values[numberField.id] === 12 &&
        record.custom_values[boolField.id] === false,
      "Typed values changed",
    );
    ensure(
      (
        await rest(
          "contacts",
          admin,
          {
            org_id: org,
            owner_id: admin.id,
            name: "Typed contact",
            custom_values: { [contact.id]: "Contact value" },
          },
          "POST",
        )
      ).ok,
      "Contact custom value failed",
    );
    for (const values of [
      { [numberField.id]: "12" },
      { [boolField.id]: "false" },
      { [date.id]: "2026-02-31" },
      { [dropdown.id]: "Unknown" },
      { [contact.id]: "Wrong entity" },
      { [randomUUID()]: "Forged" },
    ])
      ensure(
        !(
          await rest(
            "leads",
            admin,
            {
              org_id: org,
              owner_id: admin.id,
              name: "Invalid",
              custom_values: values,
            },
            "POST",
          )
        ).ok,
        "Invalid value was accepted",
      );
  });
  await test("JSON numeric filters/sorting and literal text filters work over PostgREST", async () => {
    ensure(
      (
        await rest(
          "leads",
          admin,
          {
            org_id: org,
            owner_id: admin.id,
            name: "Small number",
            custom_values: { [numberField.id]: 2 },
          },
          "POST",
        )
      ).ok,
      "Second numeric record failed",
    );
    const params = new URLSearchParams({
      select: "name,custom_values",
      org_id: "eq." + org,
      ["custom_values->" + numberField.id]: "gte.10",
      order: "custom_values->" + numberField.id + ".asc",
    });
    const response = await rest("leads", admin, undefined, "GET", "?" + params);
    ensure(
      response.ok &&
        response.data.length === 1 &&
        response.data[0].name === "Typed lead",
      "Numeric filter failed",
    );
    params.set("custom_values->" + numberField.id, "gte.0");
    const sorted = await rest("leads", admin, undefined, "GET", "?" + params);
    ensure(
      sorted.ok && sorted.data[0].custom_values[numberField.id] === 2,
      "Numeric sort is lexical",
    );
    const text = new URLSearchParams({
      select: "id",
      ["custom_values->>" + textField.id]: "ilike.%100\\%\\_%",
    });
    const found = await rest("leads", admin, undefined, "GET", "?" + text);
    ensure(
      found.ok && found.data.length === 1,
      "Literal contains filter failed",
    );
  });
  await test("cross-workspace metadata, custom values and view access denied", async () => {
    for (const table of ["custom_field_definitions", "leads", "saved_views"]) {
      const r = await rest(
        table,
        outsider,
        undefined,
        "GET",
        "?org_id=eq." + org,
      );
      ensure(r.ok && r.data.length === 0, "Cross-workspace read allowed");
    }
    const update = await rest(
      "leads",
      outsider,
      { custom_values: {} },
      "PATCH",
      "?id=eq." + record.id,
    );
    ensure(
      !update.ok || update.data.length === 0,
      "Cross-workspace write allowed",
    );
    ensure(
      !(
        await rest(
          "custom_field_definitions",
          outsider,
          { org_id: org, entity: "leads", name: "Forged", field_type: "text" },
          "POST",
        )
      ).ok,
      "Cross-workspace field accepted",
    );
    ensure(
      !(
        await rest(
          "saved_views",
          outsider,
          {
            org_id: otherOrg,
            entity: "leads",
            name: "Forged reference",
            configuration: configuration(["name", "cf:" + textField.id]),
          },
          "POST",
        )
      ).ok,
      "Foreign field in a view accepted",
    );
  });
  await test("non-admin definition/shared-view management and record-owner edits denied", async () => {
    ensure(
      !(
        await rest(
          "custom_field_definitions",
          representative,
          {
            org_id: org,
            entity: "leads",
            name: "Forbidden",
            field_type: "text",
          },
          "POST",
        )
      ).ok,
      "Representative field creation accepted",
    );
    const edit = await rest(
      "custom_field_definitions",
      representative,
      { name: "Forbidden" },
      "PATCH",
      "?id=eq." + textField.id,
    );
    ensure(
      !edit.ok || edit.data.length === 0,
      "Representative field edit accepted",
    );
    ensure(
      !(
        await rest(
          "saved_views",
          representative,
          {
            org_id: org,
            entity: "leads",
            name: "Forbidden shared",
            visibility: "shared",
            configuration: configuration(),
          },
          "POST",
        )
      ).ok,
      "Representative shared view accepted",
    );
    const forbidden = await rest(
      "leads",
      representative,
      { custom_values: { [textField.id]: "Forbidden" } },
      "PATCH",
      "?id=eq." + record.id,
    );
    ensure(
      !forbidden.ok || forbidden.data.length === 0,
      "Representative edited another owner's values",
    );
    const own = await rest(
      "leads",
      representative,
      { org_id: org, owner_id: representative.id, name: "Own lead" },
      "POST",
    );
    ensure(own.ok, "Own lead creation failed");
    ensure(
      (
        await rest(
          "leads",
          representative,
          { custom_values: { [boolField.id]: true } },
          "PATCH",
          "?id=eq." + own.data[0].id,
        )
      ).data?.length === 1,
      "Own values not editable",
    );
  });
  await test("personal/shared views persist configuration and preserve archived references", async () => {
    const personal = await rest(
      "saved_views",
      admin,
      {
        org_id: org,
        entity: "leads",
        name: "Private",
        configuration: configuration(),
      },
      "POST",
    );
    ensure(personal.ok, "Personal save failed");
    const cfg = configuration(["name", "cf:" + textField.id], {
      sort: "cf:" + numberField.id,
      direction: "asc",
      cf: JSON.stringify([
        { field: textField.id, op: "contains", value: "target" },
      ]),
    });
    const r = await rest(
      "saved_views",
      admin,
      {
        org_id: org,
        entity: "leads",
        name: "Shared",
        visibility: "shared",
        configuration: cfg,
      },
      "POST",
    );
    ensure(r.ok, "Shared save failed");
    shared = r.data[0];
    const seen = await rest("saved_views", representative);
    ensure(
      seen.ok &&
        seen.data.some((v) => v.id === shared.id) &&
        !seen.data.some((v) => v.id === personal.data[0].id),
      "Personal privacy failed",
    );
    const denial = await rest(
      "saved_views",
      representative,
      { name: "Forbidden" },
      "PATCH",
      "?id=eq." + shared.id,
    );
    ensure(!denial.ok || denial.data.length === 0, "Shared view edit allowed");
    ensure(
      (
        await rest(
          "custom_field_definitions",
          admin,
          { name: "Renamed field", archived_at: new Date().toISOString() },
          "PATCH",
          "?id=eq." + textField.id,
        )
      ).ok,
      "Archive failed",
    );
    const value = await rest(
      "leads",
      admin,
      undefined,
      "GET",
      "?id=eq." + record.id,
    );
    ensure(
      value.data[0].custom_values[textField.id] === "100%_ target",
      "Archive lost value",
    );
    ensure(
      !(
        await rest(
          "leads",
          admin,
          { custom_values: {} },
          "PATCH",
          "?id=eq." + record.id,
        )
      ).ok,
      "Archived value was erased",
    );
    ensure(
      (
        await rest(
          "leads",
          admin,
          { name: "Normal edit" },
          "PATCH",
          "?id=eq." + record.id,
        )
      ).ok,
      "Normal edit blocked by archive",
    );
    const saved = await rest(
      "saved_views",
      admin,
      undefined,
      "GET",
      "?id=eq." + shared.id,
    );
    ensure(
      JSON.stringify(saved.data[0].configuration) ===
        JSON.stringify(shared.configuration),
      "Archived view changed",
    );
  });
  await test("billing accepts a normal administrator and denies a representative", async () => {
    const a = await billing(admin, org);
    ensure(
      a.status === 200 && a.data.configured === false,
      "Administrator billing authorization failed",
    );
    ensure(
      (await billing(representative, org)).status === 403,
      "Representative billing access accepted",
    );
  });
  await test("real billing quotas and preserved-record restrictions cover custom values and exports", async () => {
    const count = Number(
      sql("select count(*) from public.leads where org_id=" + literal(org)),
    );
    const newest = sql(
      "select id from public.leads where org_id=" +
        literal(org) +
        " order by created_at desc,billing_order desc,id desc limit 1",
    );
    try {
      sql(
        "update public.subscription_plans set limits=jsonb_set(limits,'{leads}'," +
          literal(String(count - 1)) +
          "::jsonb) where code='free'; update public.organization_subscriptions set limits_reduced_at=now() where org_id=" +
          literal(org),
      );
      const read = await rest(
        "leads",
        admin,
        undefined,
        "GET",
        "?id=eq." + newest,
      );
      ensure(
        read.ok && read.data.length === 1,
        "Preserved record is not readable in its viewing period",
      );
      ensure(
        !(
          await rest(
            "leads",
            admin,
            { custom_values: { [boolField.id]: false } },
            "PATCH",
            "?id=eq." + newest,
          )
        ).ok,
        "Preserved custom value was edited",
      );
      ensure(
        !(await rpc("billing_assert_export", admin, { o: org, kind: "leads" }))
          .ok,
        "Preserved records exported",
      );
      ensure(
        !(
          await rest(
            "leads",
            admin,
            { org_id: org, owner_id: admin.id, name: "Over limit" },
            "POST",
          )
        ).ok,
        "Quota bypass accepted",
      );
    } finally {
      sql(
        "update public.subscription_plans set limits=jsonb_set(limits,'{leads}','200') where code='free'; update public.organization_subscriptions set limits_reduced_at=null where org_id=" +
          literal(org),
      );
    }
  });
  await test("real TOTP enrollment, wrong code rejection and ten hashed backup codes", async () => {
    const enrollment = await security(admin, "enroll");
    ensure(
      enrollment.ok && enrollment.data.qr_code && enrollment.data.secret,
      "Enrollment did not return QR/secret",
    );
    secret = enrollment.data.secret;
    ensure(
      !(await security(admin, "enable", { code: invalidTotp(secret) })).ok,
      "Wrong enrollment code accepted",
    );
    const enabled = await security(admin, "enable", {
      code: await freshTotp(secret),
    });
    ensure(
      enabled.ok && enabled.data.codes?.length === 10,
      "Correct TOTP enable failed",
    );
    codes = enabled.data.codes;
    const stored = JSON.parse(
      sql(
        "select to_json(backup_hashes) from private.security_accounts where user_id=" +
          literal(admin.id),
      ),
    );
    ensure(
      stored.length === 10 &&
        codes.every((code) =>
          stored.includes(hash(admin.id + ":" + code.replaceAll("-", ""))),
        ) &&
        codes.every((code) => !stored.includes(code)),
      "Backup hashes did not match",
    );
  });
  let second, third;
  await test("pre-MFA sessions cannot read new tables/CRM or billing; correct TOTP restores access", async () => {
    second = await login(admin);
    for (const table of ["custom_field_definitions", "saved_views", "leads"]) {
      const r = await rest(table, second);
      ensure(r.ok && r.data.length === 0, "Pre-MFA table access accepted");
    }
    ensure(
      (await billing(second, org)).status === 401,
      "Pre-MFA billing accepted",
    );
    ensure(
      !(await security(second, "verify", { code: invalidTotp(secret) })).ok,
      "Wrong verification code accepted",
    );
    ensure(
      (await security(second, "verify", { code: await freshTotp(secret) })).ok,
      "Correct native TOTP rejected",
    );
    ensure(
      (await rest("custom_field_definitions", second)).data?.length > 0,
      "Verified new-table access failed",
    );
  });
  await test("backup codes work once and cross-user security data remains inaccessible", async () => {
    third = await login(admin);
    ensure(
      (await security(third, "verify", { code: codes[0] })).ok,
      "Backup code rejected",
    );
    ensure(
      !(await security(admin, "verify", { code: codes[0] })).ok,
      "Reused backup accepted",
    );
    const privateRead = await rest("security_accounts", representative);
    ensure(!privateRead.ok, "Private security data exposed");
    const outsideStatus = await security(outsider, "status");
    await security(admin, "revoke", {
      session_id: outsideStatus.data.session_id,
    });
    ensure(
      (await security(outsider, "status")).ok,
      "Cross-user session was revoked",
    );
    const forged = await rpc("security_service", representative, {
      action: "verify",
      u: admin.id,
      sid: sid(admin),
      payload: {},
    });
    ensure(!forged.ok, "Service-only RPC accepted");
  });
  await test("session listing and revocation deny API, metadata and billing access", async () => {
    const sessions = await security(admin, "sessions");
    ensure(
      sessions.ok && sessions.data.length >= 2,
      "Active sessions not listed",
    );
    ensure(
      (await security(admin, "revoke", { session_id: sid(second) })).ok,
      "Session revoke failed",
    );
    ensure(
      (await security(second, "status")).status === 401,
      "Revoked session status accepted",
    );
    ensure(
      (await security(second, "register")).status === 401,
      "Revoked session revived",
    );
    ensure(
      (await rest("saved_views", second)).data?.length === 0,
      "Revoked metadata access accepted",
    );
    ensure(
      (await billing(second, org)).status === 401,
      "Revoked billing accepted",
    );
  });
  await test("disable requires both correct password and code; other sessions are revoked", async () => {
    ensure(
      !(
        await security(admin, "disable", {
          password: "Wrong-" + randomUUID(),
          code: totp(secret),
        })
      ).ok,
      "Wrong disable password accepted",
    );
    ensure(
      !(
        await security(admin, "disable", {
          password: admin.password,
          code: invalidTotp(secret),
        })
      ).ok,
      "Wrong disable code accepted",
    );
    ensure(
      (
        await security(admin, "disable", {
          password: admin.password,
          code: await freshTotp(secret),
        })
      ).ok,
      "Correct disable rejected",
    );
    ensure(
      (await security(admin, "status")).data.enabled === false,
      "2FA remained enabled",
    );
    ensure(
      (await security(third, "status")).status === 401,
      "Other session survived disable",
    );
    ensure(
      sql(
        "select cardinality(backup_hashes) from private.security_accounts where user_id=" +
          literal(admin.id),
      ) === "0",
      "Backup hashes not cleared",
    );
  });
  await test("login preflight and code attempts rate-limit without enabling the password hook", async () => {
    for (let i = 0; i < 10; i++)
      ensure(
        !(await security(representative, "verify", { code: "123456" })).ok,
        "Invalid code accepted",
      );
    ensure(
      (await security(representative, "verify", { code: "123456" })).status ===
        429,
      "Code limit missing",
    );
    const email = randomUUID() + "@local-test.invalid";
    for (let i = 0; i < 10; i++)
      ensure(
        (await security(null, "login_check", { email })).ok,
        "Preflight limited too early",
      );
    ensure(
      (await security(null, "login_check", { email })).status === 429,
      "Login preflight limit missing",
    );
  });
  await test("30-minute idle expiry blocks metadata, CRM and billing and cannot be revived", async () => {
    sql(
      "update private.security_sessions set last_active=now()-interval '31 minutes' where session_id=" +
        literal(sid(admin)),
    );
    for (const table of ["custom_field_definitions", "saved_views", "leads"])
      ensure(
        (await rest(table, admin)).data?.length === 0,
        "Expired table access accepted",
      );
    ensure(
      (await security(admin, "status")).status === 401,
      "Expired security session accepted",
    );
    ensure(
      (await security(admin, "register")).status === 401,
      "Expired session revived",
    );
    ensure(
      (await billing(admin, org)).status === 401,
      "Expired billing accepted",
    );
  });
  console.log(
    "Local acceptance: " +
      results.length +
      " checks passed. No hosted project or payment-provider endpoint was called.",
  );
} catch {
  console.log(
    "Local acceptance stopped; sensitive response bodies and credentials withheld.",
  );
  process.exitCode = 1;
}
