import { describe, expect, it } from "vitest";
import {
  backupCodes,
  digest,
  normalCode,
  sessionId,
  text,
  uuid,
} from "../supabase/functions/account-security/core";
describe("Security input and backup-code handling", () => {
  it("generates ten independent 128-bit codes and stores only user-bound hashes", async () => {
    const result = await backupCodes("user-a");
    expect(new Set(result.codes).size).toBe(10);
    expect(result.hashes).toHaveLength(10);
    for (let i = 0; i < result.codes.length; i++) {
      const code = normalCode(result.codes[i]);
      expect(code).toMatch(/^[A-F0-9]{32}$/);
      expect(result.hashes[i]).toBe(await digest("user-a:" + code));
      expect(result.hashes[i]).not.toBe(await digest("user-b:" + code));
      expect(result.hashes[i]).not.toContain(code);
    }
  });
  it("validates inputs without coercion or truncation", () => {
    for (const bad of [null, {}, 123456, "", "1".repeat(65)])
      expect(() => normalCode(bad)).toThrow();
    expect(normalCode("001234")).toBe("001234");
    expect(() => text("a".repeat(20), 10)).toThrow();
    expect(() => uuid("anything")).toThrow();
    const id = crypto.randomUUID();
    expect(
      sessionId(
        "header." + btoa(JSON.stringify({ session_id: id })) + ".signature",
      ),
    ).toBe(id);
  });
});
