import { describe, expect, it } from "vitest";
import {
  placeholderFiller,
  sendState,
  type ProposalContent,
} from "../src/lib/proposal";
import { money } from "../src/lib/utils";

const content = (over: Partial<ProposalContent["pitch"]> = {}): ProposalContent => ({
  org: { name: "Acme", website: "", currency: "INR", timezone: "Asia/Kolkata" },
  pitch: {
    name: "Website",
    objective: "",
    problem: "",
    solution: "A new site",
    scope: "",
    pricing: "",
    amount: 50000,
    terms: "Net 30",
    created_at: "2026-11-06T00:00:00Z",
    ...over,
  },
  sections: [],
  customer: "Globex",
  sender: "Asha",
});

describe("proposal placeholders", () => {
  it("fills every supported placeholder from the snapshot", () => {
    const fill = placeholderFiller(content(), money);
    expect(fill("For {{customer}}: {{solution}}, {{terms}}")).toBe(
      "For Globex: A new site, Net 30",
    );
  });
  it("falls back to the formatted amount when pricing text is empty", () => {
    const fill = placeholderFiller(content(), money);
    expect(fill("{{pricing}}")).toBe(money(50000, "INR"));
    expect(placeholderFiller(content({ pricing: "Fixed fee" }), money)("{{pricing}}")).toBe(
      "Fixed fee",
    );
  });
  it("leaves unknown placeholders alone", () => {
    expect(placeholderFiller(content(), money)("{{secret}}")).toBe("{{secret}}");
  });
});

describe("send status labels", () => {
  const base = {
    status: "sent",
    revoked_at: null,
    expires_at: "2026-12-06T00:00:00Z",
    view_count: 0,
  };
  const now = new Date("2026-11-10T00:00:00Z").getTime();
  it("shows the most important state first", () => {
    expect(sendState({ ...base, status: "failed" }, now)).toBe("Failed");
    expect(sendState({ ...base, status: "sending" }, now)).toBe("Sending");
    expect(sendState({ ...base, revoked_at: "2026-11-09T00:00:00Z", view_count: 2 }, now)).toBe(
      "Withdrawn",
    );
    expect(sendState({ ...base, expires_at: "2026-11-01T00:00:00Z" }, now)).toBe(
      "Expired",
    );
    expect(sendState({ ...base, view_count: 3 }, now)).toBe("Opened");
    expect(sendState(base, now)).toBe("Not opened yet");
  });
});
