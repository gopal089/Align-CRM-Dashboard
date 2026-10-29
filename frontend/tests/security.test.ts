import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../src/lib/client", () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    auth: { setSession: mocks.setSession, signOut: mocks.signOut },
  },
}));
import { security, logout } from "../src/lib/security";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", new EventTarget());
  mocks.setSession.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});
describe("Security client integration", () => {
  it("installs rotated MFA tokens before returning success", async () => {
    const session = { access_token: "verified", refresh_token: "rotated" };
    mocks.invoke.mockResolvedValue({ data: { session }, error: null });
    await security("verify", { code: "123456" });
    expect(mocks.setSession).toHaveBeenCalledWith(session);
  });
  it("expires the app on a revoked session, but not on an incorrect code", async () => {
    const expired = vi.fn();
    window.addEventListener("align-session-expired", expired);
    mocks.invoke.mockResolvedValueOnce({
      error: {
        context: new Response(JSON.stringify({ error: "Invalid code" }), {
          status: 400,
        }),
      },
    });
    await expect(security("verify")).rejects.toThrow("Invalid code");
    expect(expired).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValueOnce({
      error: {
        context: new Response(JSON.stringify({ error: "Session expired" }), {
          status: 401,
        }),
      },
    });
    await expect(security("status")).rejects.toThrow("Session expired");
    expect(expired).toHaveBeenCalledOnce();
  });
  it("logs out locally even when the security service is unavailable", async () => {
    mocks.invoke.mockResolvedValue({ error: new Error("Offline") });
    await expect(logout()).rejects.toThrow("Security service unavailable");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("revokes only the current session before native logout", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ data: { session_id: "current" } })
      .mockResolvedValueOnce({ data: { ok: true } });
    await logout();
    expect(mocks.invoke).toHaveBeenLastCalledWith("account-security", {
      body: { action: "revoke", session_id: "current" },
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
