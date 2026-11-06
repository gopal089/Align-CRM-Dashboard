import type { Entity, Field, Row } from "./model";

// One request should never carry a whole selection: the database is asked in
// bounded batches so a slow or rejected batch cannot stall the rest.
export const bulkLimit = 200;
export const bulkChunk = 50;

export type BulkOption = { value: string; label: string };
export type MemberLike = {
  user_id: string;
  active: boolean;
  profiles: { name: string; email: string };
};

export function chunk<T>(items: T[], size = bulkChunk): T[][] {
  if (size < 1) throw new Error("Batch size must be at least 1");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    batches.push(items.slice(i, i + size));
  return batches;
}

// Some choice fields keep their options in workspace settings rather than in
// the model: deal stages and lead sources. Callers pass those in by field key.
export type RuntimeOptions = Record<string, string[]>;

// Fields a whole selection can be set at once: the owner, plus any field whose
// values come from a fixed list. Free text, numbers and dates are left out on
// purpose, because setting those in bulk would overwrite per-record detail.
export function bulkFields(
  entity: Entity,
  runtime: RuntimeOptions = {},
): Field[] {
  return entity.fields.filter((field) => {
    if (field.key === "owner_id") return true;
    if (field.type !== "select") return false;
    if (field.options?.length) return true;
    return (runtime[field.key]?.length || 0) > 0;
  });
}

export function bulkValues(
  entity: Entity,
  field: Field,
  runtime: RuntimeOptions,
  members: MemberLike[],
): BulkOption[] {
  if (field.key === "owner_id")
    return members
      .filter((member) => member.active)
      .map((member) => ({
        value: member.user_id,
        label: member.profiles.name || member.profiles.email,
      }));
  const options = field.options?.length
    ? field.options
    : runtime[field.key] || [];
  return (
    options
      // Converting a lead creates a company, contact and deal, so it stays a
      // single-record action with its own confirmation.
      .filter((option) => !(entity.key === "leads" && option === "Converted"))
      .map((option) => ({ value: option, label: option }))
  );
}

export type BulkPlan = {
  ids: string[];
  preserved: number;
  archived: number;
  active: number;
  overLimit: boolean;
};

// Splits a selection into what can actually be acted on and what billing has
// frozen, so the screen never promises more than the database will allow.
export function planBulk(rows: Row[], selected: Set<string>): BulkPlan {
  const chosen = rows.filter((row) => selected.has(row.id));
  const actionable = chosen.filter((row) => !row.__preserved);
  return {
    ids: actionable.map((row) => row.id),
    preserved: chosen.length - actionable.length,
    archived: actionable.filter((row) => row.archived_at).length,
    active: actionable.filter((row) => !row.archived_at).length,
    overLimit: actionable.length > bulkLimit,
  };
}

// Mirrors the managed_delete row-level policy: deletion is for Administrators
// and Sales Managers, so Representatives are not offered a button that fails.
export function canBulkDelete(role: string): boolean {
  return role === "Administrator" || role === "Sales Manager";
}

export function bulkOutcome(label: string, done: number, asked: number) {
  const noun = done === 1 ? "record" : "records";
  return done >= asked
    ? { tone: "success" as const, message: `${label} ${done} ${noun}.` }
    : {
        tone: "warning" as const,
        message: `${label} ${done} of ${asked}. The rest were refused; you can only change records you own.`,
      };
}
