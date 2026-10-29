import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  deleteFactor: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: mock.rpc,
    auth: {
      getUser: mock.getUser,
      admin: { mfa: { deleteFactor: mock.deleteFactor } },
    },
  }),
}));
import { createSecurityHandler } from "../supabase/functions/account-security/handler";
const uid = crypto.randomUUID(),
  sid = crypto.randomUUID(),
  factor = crypto.randomUUID();
const jwt =
  "header." + btoa(JSON.stringify({ session_id: sid })) + ".signature";
const env: Record<string, string> = {
  SUPABASE_URL: "https://test.invalid",
  SUPABASE_ANON_KEY: "public-test",
  SUPABASE_SERVICE_ROLE_KEY: "server-test",
  SECURITY_ALLOWED_ORIGINS: "https://app.test.invalid",
};
const handle = createSecurityHandler((k) => env[k] || "");
const request = (body: unknown, origin = "https://app.test.invalid") =>
  handle(
    new Request("https://test.invalid/functions/v1/account-security", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Origin: origin },
      body: JSON.stringify(body),
    }),
  );
let state: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  state = {
    enabled: true,
    needs_code: false,
    factor_id: factor,
    session_id: sid,
  };
  mock.getUser.mockResolvedValue({
    data: { user: { id: uid, email: "test@test.invalid" } },
    error: null,
  });
  mock.rpc.mockImplementation(async (name: string, args: any) => ({
    data:
      name === "security_rate_limit"
        ? true
        : args.action === "status"
          ? state
          : { ok: true },
    error: null,
  }));
  mock.deleteFactor.mockResolvedValue({ error: null });
  vi.stubGlobal("fetch", vi.fn());
});
describe("Security endpoint authorization and failure paths", () => {
  it("rejects untrusted browser origins before touching auth", async () => {
    expect(
      (await request({ action: "status" }, "https://evil.invalid")).status,
    ).toBe(403);
    expect(mock.getUser).not.toHaveBeenCalled();
  });
  it("rejects unverifiable access tokens before using their claims", async () => {
    mock.getUser.mockResolvedValue({ data: { user: null }, error: {} });
    expect((await request({ action: "sessions" })).status).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("uses the verified identity and token session, ignoring supplied user/session impersonation", async () => {
    await request({
      action: "sessions",
      user_id: crypto.randomUUID(),
      sid: crypto.randomUUID(),
    });
    expect(mock.rpc).toHaveBeenCalledWith("security_service", {
      action: "sessions",
      u: uid,
      sid,
      payload: {},
    });
  });
  it("does not allow an unverified MFA session to revoke sessions or disable MFA", async () => {
    state.needs_code = true;
    expect((await request({ action: "revoke_others" })).status).toBe(403);
    expect(
      (
        await request({
          action: "disable",
          password: "password",
          code: "123456",
        })
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mock.deleteFactor).not.toHaveBeenCalled();
  });
  it("limits login attempts without receiving a password", async () => {
    mock.rpc.mockResolvedValue({ data: false, error: null });
    expect(
      (await request({ action: "login_check", email: "test@test.invalid" }))
        .status,
    ).toBe(429);
    expect(mock.getUser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("limits code attempts before calling the native MFA API", async () => {
    mock.rpc.mockImplementation(async (name: string) => ({
      data: name === "security_rate_limit" ? false : state,
      error: null,
    }));
    expect((await request({ action: "verify", code: "123456" })).status).toBe(
      429,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not disable MFA if the password is wrong", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 400 }));
    expect(
      (await request({ action: "disable", password: "wrong", code: "123456" }))
        .status,
    ).toBe(400);
    expect(mock.deleteFactor).not.toHaveBeenCalled();
    expect(mock.rpc.mock.calls.some((c) => c[1]?.action === "disable")).toBe(
      false,
    );
  });
  it("does not disable MFA if the code is wrong and cleans up password-check sessions", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "temporary" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "challenge" })))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}"));
    expect(
      (
        await request({
          action: "disable",
          password: "correct",
          code: "123456",
        })
      ).status,
    ).toBe(400);
    expect(mock.deleteFactor).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenLastCalledWith(
      "https://test.invalid/auth/v1/logout?scope=local",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer temporary" }),
      }),
    );
  });
  it("requires both password and valid code before deleting the factor and disabling", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "temporary" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "challenge" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: jwt, refresh_token: "rotated" }),
        ),
      )
      .mockResolvedValueOnce(new Response("{}"));
    const response = await request({
      action: "disable",
      password: "correct",
      code: "123456",
    });
    expect(response.status).toBe(200);
    expect(mock.deleteFactor).toHaveBeenCalledWith({ userId: uid, id: factor });
    expect(mock.rpc).toHaveBeenCalledWith("security_service", {
      action: "disable",
      u: uid,
      sid,
      payload: { factor_id: factor },
    });
  });
  it("keeps the account locked if native factor deletion fails", async () => {
    mock.rpc.mockImplementation(async (name: string, args: any) => ({
      data:
        name === "security_rate_limit"
          ? true
          : args.action === "status"
            ? state
            : { valid: true },
      error: null,
    }));
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: "temporary" })),
    );
    mock.deleteFactor.mockResolvedValue({ error: { status: 500 } });
    expect(
      (
        await request({
          action: "disable",
          password: "correct",
          code: "A".repeat(32),
        })
      ).status,
    ).toBe(400);
    expect(mock.rpc.mock.calls.some((c) => c[1]?.action === "disable")).toBe(
      false,
    );
  });
});
