import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mock.rpc }),
}));
import { createNotificationsHandler } from "../supabase/functions/align-notifications/handler";
import {
  appUrl,
  digestEmail,
  planEndingEmail,
} from "../supabase/functions/align-notifications/core";

const env: Record<string, string> = {
  SUPABASE_URL: "https://test.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "server-test",
  RESEND_API_KEY: "re_test_key",
  SECURITY_ALLOWED_ORIGINS: "http://127.0.0.1:5173,https://app.test.invalid",
};
const digest = {
  id: crypto.randomUUID(),
  kind: "follow_up_digest",
  email: "rep@example.com",
  name: "Ravi",
  payload: {
    org_name: "Acme",
    items: [{ task: "t-1", name: "Follow up: <b>Globex</b>", kind: "lead" }],
  },
};
const plan = {
  id: crypto.randomUUID(),
  kind: "plan_ending",
  email: "owner@example.com",
  name: "Asha",
  payload: {
    org_name: "Acme",
    plan: "Starter",
    paid_until: "2026-11-12T10:00:00Z",
    timezone: "Asia/Kolkata",
    cancelling: true,
  },
};
let queue: any[];
let fetchMock: ReturnType<typeof vi.fn>;
const call = (token = "x".repeat(64)) =>
  createNotificationsHandler((k) => env[k] || "", async () => {})(
    new Request("https://test.invalid/functions/v1/align-notifications", {
      method: "POST",
      headers: { "x-align-notifications-job": token },
      body: "{}",
    }),
  );
const finishes = () =>
  mock.rpc.mock.calls.filter(([n]) => n === "notifications_finish").map(([, a]) => a);
beforeEach(() => {
  vi.resetAllMocks();
  env.RESEND_API_KEY = "re_test_key";
  queue = [digest, plan];
  mock.rpc.mockImplementation(async (name: string, args: any) => ({
    data:
      name === "notifications_validate_job_token"
        ? args.token === "x".repeat(64)
        : name === "notifications_claim"
          ? queue
          : null,
    error: null,
  }));
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "re_ok" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("Align notification emails", () => {
  it("lists follow-ups with links and escapes their names", () => {
    const mail = digestEmail({
      name: "Ravi",
      org: "Acme",
      items: digest.payload.items,
      url: "https://app.test.invalid",
    });
    expect(mail.subject).toBe("1 follow-up for today · Acme");
    expect(mail.html).not.toContain("<b>Globex</b>");
    expect(mail.html).toContain("&lt;b&gt;Globex&lt;/b&gt;");
    expect(mail.html).toContain('href="https://app.test.invalid/tasks/t-1"');
    expect(mail.text).toContain("Nothing logged on this lead recently");
  });
  it("words a scheduled cancellation differently from a renewal", () => {
    const base = { name: "Asha", org: "Acme", plan: "Starter", paidUntil: "2026-11-12T10:00:00Z", timezone: "Asia/Kolkata", url: "" };
    expect(planEndingEmail({ ...base, cancelling: true }).subject).toBe(
      "Your Starter plan for Acme ends on 12 Nov 2026",
    );
    const renewing = planEndingEmail({ ...base, cancelling: false });
    expect(renewing.subject).toContain("renews on 12 Nov 2026");
    expect(renewing.text).toContain("no grace period");
    expect(renewing.html).not.toContain("Review billing");
  });
  it("picks the app address from APP_URL or the first trusted https origin", () => {
    expect(appUrl("", env.SECURITY_ALLOWED_ORIGINS)).toBe("https://app.test.invalid");
    expect(appUrl("https://staging.test/path", "")).toBe("https://staging.test");
    expect(appUrl("javascript:alert(1)", "")).toBe("");
  });
});

describe("notification sender", () => {
  it("refuses callers without the scheduler credential", async () => {
    const res = await call("wrong");
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.rpc.mock.calls.map(([n]) => n)).toEqual([
      "notifications_validate_job_token",
    ]);
  });
  it("leaves the queue alone until email is set up", async () => {
    env.RESEND_API_KEY = "";
    expect((await call()).status).toBe(503);
    expect(mock.rpc.mock.calls.map(([n]) => n)).not.toContain("notifications_claim");
  });
  it("sends each queued email once and records the result", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ processed: 2, sent: 2, failed: 0, retry: 0 });
    const [first] = fetchMock.mock.calls;
    expect(first[1].headers["Idempotency-Key"]).toBe(digest.id);
    const body = JSON.parse(first[1].body);
    expect(body.to).toEqual(["rep@example.com"]);
    expect(body.from).toBe('"Align" <onboarding@resend.dev>');
    expect(finishes()).toEqual([
      { item: digest.id, delivered: true, provider: "re_ok" },
      { item: plan.id, delivered: true, provider: "re_ok" },
    ]);
  });
  it("gives up on refused emails but retries rate limits and outages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "You can only send testing emails to your own email address" }), { status: 403 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const res = await call();
    expect(await res.json()).toMatchObject({ failed: 1, retry: 1 });
    expect(finishes()[0]).toMatchObject({ permanent: true, delivered: false });
    expect(finishes()[0].failure).toContain("your own email address");
    expect(finishes()[1]).toMatchObject({ permanent: false, delivered: false });
  });
  it("treats a timeout as temporary and a missing address as permanent", async () => {
    queue = [{ ...digest, email: null }, plan];
    fetchMock.mockRejectedValue(new Error("timeout"));
    await call();
    expect(finishes()[0]).toMatchObject({ permanent: true, failure: "Recipient has no email address" });
    expect(finishes()[1]).toMatchObject({ delivered: false, failure: "Email provider did not respond" });
    expect(finishes()[1].permanent).toBeUndefined();
  });
});
