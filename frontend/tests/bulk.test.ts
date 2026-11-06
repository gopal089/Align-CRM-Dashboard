import { describe, expect, it } from "vitest";
import {
  bulkFields,
  bulkLimit,
  bulkOutcome,
  bulkValues,
  canBulkDelete,
  chunk,
  planBulk,
  type MemberLike,
} from "../src/lib/bulk";
import { entities } from "../src/lib/model";
import type { Row } from "../src/lib/model";

const stages = ["Discovery", "Proposal", "Won"];
const runtime = { stage: stages, source: ["Referral", "Website"] };
const members: MemberLike[] = [
  {
    user_id: "u1",
    active: true,
    profiles: { name: "Asha", email: "asha@example.com" },
  },
  {
    user_id: "u2",
    active: true,
    profiles: { name: "", email: "ravi@example.com" },
  },
  {
    user_id: "u3",
    active: false,
    profiles: { name: "Gone", email: "gone@example.com" },
  },
];

const row = (id: string, extra: Partial<Row> = {}): Row =>
  ({
    id,
    org_id: "org",
    name: `Record ${id}`,
    owner_id: "u1",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    archived_at: null,
    ...extra,
  }) as Row;

describe("chunk", () => {
  it("splits ids into bounded batches and keeps order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns nothing for an empty selection", () => {
    expect(chunk([], 10)).toEqual([]);
  });
  it("refuses a batch size that would never finish", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("bulkFields", () => {
  it("offers owner plus fixed-choice fields on leads", () => {
    const keys = bulkFields(entities.leads, runtime).map((f) => f.key);
    expect(keys).toContain("owner_id");
    expect(keys).toContain("status");
    expect(keys).toContain("priority");
    // Source options come from workspace settings, so they only appear
    // once the workspace actually has lead sources configured.
    expect(keys).toContain("source");
    expect(
      bulkFields(entities.leads, { stage: stages }).map((f) => f.key),
    ).not.toContain("source");
  });
  it("never offers free text, numbers or dates", () => {
    for (const entity of Object.values(entities))
      for (const field of bulkFields(entity, runtime))
        expect(field.key === "owner_id" || field.type === "select").toBe(true);
  });
  it("offers the deals stage only once the workspace has stages", () => {
    expect(bulkFields(entities.deals, runtime).map((f) => f.key)).toContain(
      "stage",
    );
    expect(bulkFields(entities.deals, {}).map((f) => f.key)).not.toContain(
      "stage",
    );
  });
  it("gives every module at least the owner action", () => {
    for (const entity of Object.values(entities))
      expect(bulkFields(entity, runtime).length).toBeGreaterThan(0);
  });
});

describe("bulkValues", () => {
  it("lists active members by name, falling back to email", () => {
    const owner = bulkFields(entities.contacts, runtime).find(
      (f) => f.key === "owner_id",
    )!;
    const values = bulkValues(entities.contacts, owner, runtime, members);
    expect(values).toEqual([
      { value: "u1", label: "Asha" },
      { value: "u2", label: "ravi@example.com" },
    ]);
  });
  it("fills deal stages from the workspace pipeline", () => {
    const stage = bulkFields(entities.deals, runtime).find(
      (f) => f.key === "stage",
    )!;
    expect(
      bulkValues(entities.deals, stage, runtime, members).map((v) => v.value),
    ).toEqual(stages);
  });
  it("keeps lead conversion out of bulk changes", () => {
    const status = bulkFields(entities.leads, runtime).find(
      (f) => f.key === "status",
    )!;
    const values = bulkValues(entities.leads, status, runtime, members).map(
      (v) => v.value,
    );
    expect(values).toContain("Qualified");
    expect(values).not.toContain("Converted");
  });
});

describe("planBulk", () => {
  it("counts only the ticked rows", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(planBulk(rows, new Set(["a", "c"])).ids).toEqual(["a", "c"]);
  });
  it("leaves billing-preserved rows out of the action", () => {
    const rows = [row("a"), row("b", { __preserved: true })];
    const plan = planBulk(rows, new Set(["a", "b"]));
    expect(plan.ids).toEqual(["a"]);
    expect(plan.preserved).toBe(1);
  });
  it("separates archived from active so the right buttons show", () => {
    const rows = [row("a"), row("b", { archived_at: "2026-01-02" })];
    const plan = planBulk(rows, new Set(["a", "b"]));
    expect(plan.active).toBe(1);
    expect(plan.archived).toBe(1);
  });
  it("flags a selection larger than one safe batch run", () => {
    const rows = Array.from({ length: bulkLimit + 1 }, (_, i) =>
      row(String(i)),
    );
    const plan = planBulk(rows, new Set(rows.map((r) => r.id)));
    expect(plan.overLimit).toBe(true);
    expect(planBulk(rows.slice(0, bulkLimit), new Set(rows.map((r) => r.id))).overLimit).toBe(false);
  });
});

describe("canBulkDelete", () => {
  it("matches the managed_delete database policy", () => {
    expect(canBulkDelete("Administrator")).toBe(true);
    expect(canBulkDelete("Sales Manager")).toBe(true);
    expect(canBulkDelete("Sales Representative")).toBe(false);
    expect(canBulkDelete("")).toBe(false);
  });
});

describe("bulkOutcome", () => {
  it("confirms a complete run", () => {
    expect(bulkOutcome("Archived", 3, 3)).toEqual({
      tone: "success",
      message: "Archived 3 records.",
    });
  });
  it("warns when the database refused some rows", () => {
    const outcome = bulkOutcome("Deleted", 1, 4);
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toContain("1 of 4");
  });
  it("uses the singular for one record", () => {
    expect(bulkOutcome("Deleted", 1, 1).message).toBe("Deleted 1 record.");
  });
});
