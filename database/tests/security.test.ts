import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
const db = new PGlite();
let u: string,
  sid: string,
  second: string,
  outsider: string,
  otherSid: string,
  factor: string,
  org: string;
const query = async (sql: string, params: unknown[] = []) =>
  (await db.query<any>(sql, params)).rows;
async function owner() {
  await db.exec("reset role");
}
async function asUser(user = u, session = sid) {
  await owner();
  await query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ session_id: session })],
  );
  await db.exec("set role authenticated");
}
async function service(
  action: string,
  payload: unknown = {},
  session = sid,
  user = u,
) {
  await owner();
  await db.exec("set role service_role");
  return (
    await query("select public.security_service($1,$2,$3,$4) result", [
      action,
      user,
      session,
      payload,
    ])
  )[0].result;
}
async function enabled() {
  await service("pending", { factor_id: factor });
  await service("enable", { factor_id: factor, hashes: ["HASH_A", "HASH_B"] });
}
beforeAll(async () => {
  await db.exec(
    `create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key,email text);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  for (const file of readdirSync("database/supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`database/supabase/migrations/${file}`, "utf8"));
}, 30000);
beforeEach(async () => {
  [u, sid, second, outsider, otherSid, factor] = Array.from({ length: 6 }, () =>
    crypto.randomUUID(),
  );
  await owner();
  await query("insert into auth.users values($1,$2),($3,$4)", [
    u,
    u + "@test.invalid",
    outsider,
    outsider + "@test.invalid",
  ]);
  await query(
    "insert into auth.sessions(id,user_id,user_agent,ip) values($1,$2,'Browser A','192.0.2.1'),($3,$2,'Browser B','192.0.2.2'),($4,$5,'Other user','192.0.2.3')",
    [sid, u, second, otherSid, outsider],
  );
  await service("register");
  await service("register", {}, second);
  await service("register", {}, otherSid, outsider);
  await asUser();
  org = (
    await query("select public.create_workspace('Security test','Test') id")
  )[0].id;
});
afterAll(() => db.close());
describe("Account security enforced by PostgreSQL", () => {
  it("keeps ordinary login access and applies security to every public table", async () => {
    expect((await query("select public.security_session_ok() ok"))[0].ok).toBe(
      true,
    );
    await owner();
    const result = await query(
      "select tablename from pg_tables where schemaname='public' and rowsecurity and tablename not in (select tablename from pg_policies where schemaname='public' and policyname='account_security' and permissive='RESTRICTIVE')",
    );
    expect(result).toEqual([]);
  });
  it("blocks unverified sessions from records, definer RPCs and owner-only updates", async () => {
    await enabled();
    await asUser(u, second);
    expect((await query("select public.security_session_ok() ok"))[0].ok).toBe(
      false,
    );
    expect(await query("select * from public.organizations")).toEqual([]);
    expect(
      await query(
        "update public.profiles set name='Bypass' where id=$1 returning id",
        [u],
      ),
    ).toEqual([]);
    await expect(
      query("select public.create_workspace('Bypass','Bypass')"),
    ).rejects.toThrow("Verify your account");
    await expect(
      query("select public.billing_status($1)", [org]),
    ).rejects.toThrow();
  });
  it("does not allow a client to manufacture verification or inspect hashes", async () => {
    await expect(
      query("select public.security_service('verify',$1,$2,'{}')", [u, sid]),
    ).rejects.toThrow("permission denied");
    await expect(
      query("select * from private.security_accounts"),
    ).rejects.toThrow("permission denied");
    await expect(
      query("select public.security_rate_limit('bypass',100)"),
    ).rejects.toThrow("permission denied");
  });
  it("requires a matching factor and grants access only to the verified session", async () => {
    await enabled();
    await expect(
      service("verify", { factor_id: crypto.randomUUID() }, second),
    ).rejects.toThrow("Invalid factor");
    await service("verify", { factor_id: factor }, second);
    await asUser(u, second);
    expect((await query("select public.security_session_ok() ok"))[0].ok).toBe(
      true,
    );
  });
  it("consumes backup codes exactly once, including across sessions", async () => {
    await enabled();
    expect(await service("backup", { hash: "WRONG" }, second)).toEqual({
      valid: false,
    });
    expect(await service("backup", { hash: "HASH_A" }, second)).toEqual({
      valid: true,
    });
    expect(await service("backup", { hash: "HASH_A" })).toEqual({
      valid: false,
    });
    await owner();
    expect(
      (
        await query(
          "select backup_hashes from private.security_accounts where user_id=$1",
          [u],
        )
      )[0].backup_hashes,
    ).toEqual(["HASH_B"]);
  });
  it("replaces backup codes and rejects the previous set", async () => {
    await enabled();
    await service("codes", { factor_id: factor, hashes: ["NEW"] });
    expect(await service("backup", { hash: "HASH_A" }, second)).toEqual({
      valid: false,
    });
    expect(await service("backup", { hash: "NEW" }, second)).toEqual({
      valid: true,
    });
  });
  it("revokes selected sessions immediately without affecting another user", async () => {
    await service("revoke", { session_id: otherSid });
    expect(await service("status", {}, otherSid, outsider)).toMatchObject({
      needs_code: false,
    });
    await service("revoke", { session_id: second });
    await asUser(u, second);
    expect((await query("select public.security_session_ok() ok"))[0].ok).toBe(
      false,
    );
    await expect(service("register", {}, second)).rejects.toThrow(
      "Session expired",
    );
  });
  it("logs out all other sessions and retains the current session", async () => {
    await service("revoke_others");
    expect(await service("status")).toMatchObject({ session_id: sid });
    await expect(service("status", {}, second)).rejects.toThrow(
      "Session expired",
    );
  });
  it("rejects an expired idle session and does not revive it through registration or touch", async () => {
    await owner();
    await query(
      "update private.security_sessions set last_active=now()-interval '31 minutes' where session_id=$1",
      [sid],
    );
    await asUser();
    expect((await query("select public.security_session_ok() ok"))[0].ok).toBe(
      false,
    );
    for (const action of ["register", "touch", "verify"])
      await expect(service(action, { factor_id: factor })).rejects.toThrow(
        "Session expired",
      );
  });
  it("polling does not refresh activity, but explicit activity does", async () => {
    await owner();
    await query(
      "update private.security_sessions set last_active=now()-interval '10 minutes' where session_id=$1",
      [sid],
    );
    const before = (await service("status")).expires_at;
    expect((await service("status")).expires_at).toBe(before);
    await service("touch");
    expect(
      new Date((await service("status")).expires_at).getTime(),
    ).toBeGreaterThan(new Date(before).getTime());
  });
  it("rejects a session deleted or expired by native Auth", async () => {
    await owner();
    await query("delete from auth.sessions where id=$1", [sid]);
    await asUser();
    expect((await query("select public.security_session_ok() ok"))[0].ok).toBe(
      false,
    );
    await expect(service("register")).rejects.toThrow("Session expired");
  });
  it("lists only this user's active sessions with provider-recorded device and IP", async () => {
    const sessions = await service("sessions");
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s: any) => s.current)).toMatchObject({
      id: sid,
      device: "Browser A",
      ip: "192.0.2.1",
    });
  });
  it("disabling invalidates old backup codes and other sessions", async () => {
    await enabled();
    await service("disable", { factor_id: factor });
    expect(await service("status")).toMatchObject({ enabled: false });
    expect(await service("backup", { hash: "HASH_A" })).toEqual({
      valid: false,
    });
    await expect(service("status", {}, second)).rejects.toThrow(
      "Session expired",
    );
  });
  it("limits attempts across committed requests and resets after the time window", async () => {
    await owner();
    await db.exec("set role service_role");
    const b = "test:" + u;
    for (let i = 0; i < 10; i++)
      expect(
        (await query("select public.security_rate_limit($1,10) ok", [b]))[0].ok,
      ).toBe(true);
    expect(
      (await query("select public.security_rate_limit($1,10) ok", [b]))[0].ok,
    ).toBe(false);
    await owner();
    await query(
      "update private.security_attempts set started_at=now()-interval '16 minutes' where bucket=$1",
      [b],
    );
    expect(
      (await query("select public.security_rate_limit($1,10) ok", [b]))[0].ok,
    ).toBe(true);
  });
  it("enforces the Auth-only password hook, including direct-login lockout and reset", async () => {
    await asUser();
    await expect(
      query("select private.security_password_attempt($1)", [
        { user_id: u, valid: false },
      ]),
    ).rejects.toThrow("permission denied");
    const hook = async (valid: boolean) => {
      await owner();
      await db.exec("set role supabase_auth_admin");
      return (
        await query("select private.security_password_attempt($1) result", [
          { user_id: u, valid },
        ])
      )[0].result;
    };
    for (let i = 0; i < 5; i++)
      expect(await hook(false)).toEqual({ decision: "continue" });
    expect(await hook(true)).toEqual({ decision: "continue" });
    for (let i = 0; i < 10; i++)
      expect(await hook(false)).toEqual({ decision: "continue" });
    expect(await hook(false)).toMatchObject({ error: { http_code: 429 } });
    expect(await hook(true)).toMatchObject({ error: { http_code: 429 } });
    await owner();
    await query(
      "update private.security_attempts set started_at=now()-interval '16 minutes' where bucket=$1",
      ["native-login:" + u],
    );
    expect(await hook(true)).toEqual({ decision: "continue" });
  });
});
