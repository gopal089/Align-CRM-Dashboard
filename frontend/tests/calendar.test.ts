import { describe, expect, it } from "vitest";
import { feedUrl, googleOutcome } from "../src/lib/calendar";

describe("calendar settings helpers", () => {
  it("builds the subscribe link on the project's function address", () => {
    expect(feedUrl("a".repeat(64), "https://proj.supabase.co/")).toBe(
      `https://proj.supabase.co/functions/v1/calendar-feed?token=${"a".repeat(64)}`,
    );
  });
  it("explains every result Google can send people back with", () => {
    for (const key of ["connected", "denied", "missing_permission", "failed"])
      expect(googleOutcome[key].message.length).toBeGreaterThan(10);
    expect(googleOutcome.connected.ok).toBe(true);
    expect(googleOutcome.denied.ok).toBe(false);
  });
});
