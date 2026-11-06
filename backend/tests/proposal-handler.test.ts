import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mock.rpc, auth: { getUser: mock.getUser } }),
}));
import { createProposalHandler } from "../supabase/functions/proposal-email/handler";
import {
  deviceLabel,
  digest,
  displayName,
  escapeHtml,
  newToken,
  proposalEmail,
  tokenPattern,
} from "../supabase/functions/proposal-email/core";

const app = "https://app.test.invalid";
const uid = crypto.randomUUID(),
  sendId = crypto.randomUUID(),
  pitchId = crypto.randomUUID();
const env: Record<string, string> = {
  SUPABASE_URL: "https://test.invalid",
  SUPABASE_ANON_KEY: "public-test",
  SUPABASE_SERVICE_ROLE_KEY: "server-test",
  SECURITY_ALLOWED_ORIGINS: app,
  RESEND_API_KEY: "re_test_key",
};
const handler = () => createProposalHandler((k) => env[k] || "");
const call = (
  body: unknown,
  { origin = app, token = "member-jwt", ua = "Mozilla/5.0 (iPhone)" } = {},
) =>
  handler()(
    new Request("https://test.invalid/functions/v1/proposal-email", {
      method: "POST",
      headers: {
        ...(origin ? { Origin: origin } : {}),
        Authorization: `Bearer ${token}`,
        "User-Agent": ua,
        "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
      },
      body: JSON.stringify(body),
    }),
  );
const started = {
  id: sendId,
  org_name: "Acme <Studio>",
  sender: 'Asha "A" Rao',
  reply_to: "asha@example.com",
  expires_at: "2026-12-06T10:00:00Z",
  to_email: "client@example.com",
  to_name: "<b>Client</b>",
  subject: "Proposal: Website",
  message: "Hello <script>alert(1)</script>\n\nSecond paragraph",
};
const sendBody = {
  action: "send",
  pitch_id: pitchId,
  to_email: "client@example.com",
  to_name: "Client",
  subject: "Proposal: Website",
  message: "Hello",
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  env.RESEND_API_KEY = "re_test_key";
  mock.getUser.mockResolvedValue({ data: { user: { id: uid } }, error: null });
  mock.rpc.mockImplementation(async (name: string) => ({
    data:
      name === "security_rate_limit"
        ? true
        : name === "proposal_begin"
          ? started
          : name === "proposal_open"
            ? { content: { pitch: { name: "Website" } }, internal: false }
            : null,
    error: null,
  }));
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "re_123" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
const rpcCall = (name: string) =>
  mock.rpc.mock.calls.find(([n]) => n === name)?.[1];

describe("proposal email helpers", () => {
  it("makes unguessable, URL-safe link tokens", () => {
    const a = newToken(),
      b = newToken();
    expect(tokenPattern.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });
  it("escapes everything a sender types before it goes into HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    const mail = proposalEmail({
      toName: "<b>Client</b>",
      message: "Hi <script>x</script>\n\nNext",
      link: "https://app/proposal#abc",
      sender: "Asha",
      org: "Acme",
      expiresAt: "2026-12-06T10:00:00Z",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Client</b>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain('href="https://app/proposal#abc"');
    expect(mail.text).toContain("View proposal: https://app/proposal#abc");
  });
  it("keeps sender names from breaking out of the email header", () => {
    expect(displayName('Eve" <evil@x.com>\r\nBcc: a@b.c')).toBe(
      "Eve evil@x.comBcc: a@b.c",
    );
    expect(displayName("  ")).toBe("Align");
  });
  it("records only a rough device type", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17)")).toBe("Mobile");
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17)")).toBe("Tablet");
    expect(deviceLabel("Mozilla/5.0 (Macintosh)")).toBe("Desktop");
    expect(deviceLabel("")).toBe("Unknown");
  });
});

describe("sending a proposal", () => {
  it("emails a private link and marks the send delivered", async () => {
    const res = await call(sendBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: sendId, status: "sent" });
    const begin = rpcCall("proposal_begin");
    expect(begin.link_hash).toMatch(/^[a-f0-9]{64}$/);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["Idempotency-Key"]).toBe(sendId);
    const email = JSON.parse(init.body);
    expect(email.to).toEqual(["client@example.com"]);
    expect(email.reply_to).toBe("asha@example.com");
    expect(email.from).toBe('"Asha A Rao via Align" <onboarding@resend.dev>');
    expect(email.html).not.toContain("<script>");
    // The link carries the token whose hash was stored, after a "#".
    const token = email.text.match(/proposal#([A-Za-z0-9_-]{43})/)[1];
    expect(email.text).toContain(`${app}/proposal#${token}`);
    expect(await digest(token)).toBe(begin.link_hash);
    expect(rpcCall("proposal_finish")).toEqual({
      send: sendId,
      delivered: true,
      provider: "re_123",
      failure: null,
    });
  });
  it("reports the provider's reason when the email is refused", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "You can only send testing emails to your own email address",
        }),
        { status: 403 },
      ),
    );
    const res = await call(sendBody);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("your own email address");
    expect(rpcCall("proposal_finish")).toMatchObject({
      delivered: false,
      provider: null,
    });
  });
  it("records a timeout as a failed send", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await call(sendBody);
    expect(res.status).toBe(502);
    expect(rpcCall("proposal_finish")).toMatchObject({
      delivered: false,
      failure: "Email provider did not respond",
    });
  });
  it("explains missing setup without starting a send", async () => {
    env.RESEND_API_KEY = "";
    const res = await call(sendBody);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("RESEND_API_KEY");
    expect(rpcCall("proposal_begin")).toBeUndefined();
  });
  it("requires a signed-in member and the app's own origin", async () => {
    mock.getUser.mockResolvedValue({ data: { user: null }, error: {} });
    expect((await call(sendBody)).status).toBe(401);
    mock.getUser.mockResolvedValue({ data: { user: { id: uid } }, error: null });
    expect((await call(sendBody, { origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect((await call(sendBody, { origin: "" })).status).toBe(400);
  });
  it("passes on rules from the database but hides unexpected errors", async () => {
    mock.rpc.mockImplementation(async (name: string) =>
      name === "security_rate_limit"
        ? { data: true, error: null }
        : {
            data: null,
            error: { message: "Only the proposal owner or a manager can send it" },
          },
    );
    let res = await call(sendBody);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Only the proposal owner");
    mock.rpc.mockImplementation(async (name: string) =>
      name === "security_rate_limit"
        ? { data: true, error: null }
        : { data: null, error: { message: 'relation "x" does not exist' } },
    );
    res = await call(sendBody);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("relation");
  });
  it("stops a member who sends too often", async () => {
    mock.rpc.mockResolvedValue({ data: false, error: null });
    expect((await call(sendBody)).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("opening a proposal link", () => {
  it("looks the link up by hash and records only a device type", async () => {
    const token = newToken();
    const res = await call({ action: "open", token }, { token: "public-test" });
    expect(res.status).toBe(200);
    expect(rpcCall("proposal_open")).toEqual({
      link_hash: await digest(token),
      device: "Mobile",
      viewer: null,
    });
    expect(mock.getUser).not.toHaveBeenCalled();
    // The rate-limit bucket holds a hash of the address, not the address itself.
    const bucket = rpcCall("security_rate_limit").b;
    expect(bucket).toBe("proposal-open:" + (await digest("203.0.113.9")));
  });
  it("tells the database who is looking when a member opens the link", async () => {
    await call({ action: "open", token: newToken() });
    expect(rpcCall("proposal_open").viewer).toBe(uid);
  });
  it("rejects malformed tokens without touching the database", async () => {
    const res = await call({ action: "open", token: "short" });
    expect(res.status).toBe(404);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("uses 410 for withdrawn or expired links", async () => {
    mock.rpc.mockImplementation(async (name: string) =>
      name === "security_rate_limit"
        ? { data: true, error: null }
        : {
            data: null,
            error: { message: "This proposal link has expired" },
          },
    );
    const res = await call({ action: "open", token: newToken() });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("This proposal link has expired");
  });
});
