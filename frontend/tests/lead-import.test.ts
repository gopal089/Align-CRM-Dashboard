import { describe, expect, it } from "vitest";
import {
  contactTargets,
  importTargets,
  leadTargets,
  mappedRows,
  suggestedMapping,
} from "../src/lib/contactImport";

describe("leads import mapping", () => {
  it("offers lead fields for leads and contact fields for contacts", () => {
    expect(importTargets("leads")).toBe(leadTargets);
    expect(importTargets("contacts")).toBe(contactTargets);
    expect(leadTargets).toContain("source");
    expect(leadTargets).not.toContain("job_title");
  });
  it("suggests lead columns from common header names", () => {
    expect(
      suggestedMapping(["Full name", "Company", "E-mail", "Source", "Status", "Job title"], [], leadTargets),
    ).toEqual(["name", "company_name", "", "source", "status", ""]);
  });
  it("refuses a contact-only field in a leads import", () => {
    const sheet = { name: "CSV", rows: [["Name", "Job title"], ["Ann", "CTO"]] };
    expect(() => mappedRows(sheet, ["name", "job_title"], [], leadTargets)).toThrow(
      "no longer available",
    );
    const [row] = mappedRows(sheet, ["name", ""], [], leadTargets);
    expect(row.payload).toEqual({ name: "Ann" });
  });
});
