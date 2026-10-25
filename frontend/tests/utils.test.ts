import { describe, it, expect } from "vitest";
import {
  money,
  percent,
  period,
  zonedBoundary,
  cleanSearch,
  addDays,
} from "../src/lib/utils";
describe("currency, date boundaries, and search safety", () => {
  it("keeps monetary formatting consistent", () => {
    expect(money(1200.5, "USD")).toBe("$1,200.50");
    expect(percent(0, 0)).toBe("0%");
    expect(percent(1, 4)).toBe("25.0%");
  });
  it("uses actual time-zone boundaries including daylight saving", () => {
    expect(zonedBoundary("2026-10-24", "Asia/Kolkata")).toBe(
      "2026-10-23T18:30:00.000Z",
    );
    expect(zonedBoundary("2026-07-01", "America/New_York")).toBe(
      "2026-07-01T04:00:00.000Z",
    );
    expect(zonedBoundary("2026-12-01", "America/New_York")).toBe(
      "2026-12-01T05:00:00.000Z",
    );
  });
  it("uses inclusive calendar days and exclusive UTC end boundaries", () => {
    const p = period("custom", "Asia/Kolkata", "2026-10-01", "2026-10-24");
    expect(p.start).toBe("2026-09-30T18:30:00.000Z");
    expect(p.end).toBe("2026-10-24T18:30:00.000Z");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("removes PostgREST expression delimiters from text search", () => {
    expect(cleanSearch("Alice,or(id.eq.1)")).toBe("Aliceorid.eq.1");
  });
});
