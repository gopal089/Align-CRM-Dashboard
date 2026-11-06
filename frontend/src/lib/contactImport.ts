import type { CustomField } from "./customization";

export const importLimits = {
  fileBytes: 5 * 1024 * 1024,
  rows: 10000,
  columns: 100,
  cellLength: 2000,
  unzippedBytes: 20 * 1024 * 1024,
  cells: 250000,
  batchRows: 25,
  batchBytes: 90 * 1024,
};
export type ImportSheet = { name: string; rows: string[][] };
export type ImportBook = { sheets: ImportSheet[] };
export type ImportInput = {
  row_no: number;
  payload: Record<string, unknown>;
  source: string[];
  client_error: string;
};
export const contactTargets = [
  "name",
  "email",
  "phone",
  "job_title",
  "tags",
  "notes",
];
// Leads use the same import, with their own fields. Choice fields (source,
// status, priority) are checked by the server against workspace settings.
export const leadTargets = [
  "name",
  "company_name",
  "email",
  "phone",
  "source",
  "status",
  "priority",
  "notes",
];
export type ImportEntity = "contacts" | "leads";
export const importTargets = (entity: ImportEntity) =>
  entity === "leads" ? leadTargets : contactTargets;
export function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}
export function normalizedPhone(value: string) {
  let digits = value.replace(/[^0-9]/g, "");
  if (value.trim().startsWith("00")) digits = digits.slice(2);
  return digits;
}
export function unsafeFormula(value: string) {
  const text = value.trim();
  return (
    /^[=@]/.test(text) ||
    (/^[+-]/.test(text) &&
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) &&
      !/^[+-][0-9() .-]+$/.test(text))
  );
}
export function validateMatrix(rows: string[][]) {
  if (!rows.length || rows.length < 2)
    throw new Error("Add a header row and at least one data row.");
  if (rows.length > importLimits.rows + 1)
    throw new Error("A file can contain at most 10,000 data rows.");
  for (const row of rows) {
    if (row.length > importLimits.columns)
      throw new Error("Use at most 100 columns.");
    for (const cell of row)
      if (cell.length > importLimits.cellLength)
        throw new Error("Each cell must contain at most 2,000 characters.");
  }
}
export function suggestedMapping(
  headers: string[],
  fields: CustomField[],
  targets: string[] = contactTargets,
) {
  const used = new Set<string>();
  return headers.map((header) => {
    const label = header.trim().toLowerCase().replace(/[_-]/g, " ");
    const base = targets.find(
      (t) =>
        t.replace(/_/g, " ") === label ||
        (t === "name" && label === "full name") ||
        (t === "company_name" && label === "company"),
    );
    const custom = fields.find(
      (f) => !f.archived_at && f.name.toLowerCase() === label,
    );
    const target = base || (custom ? `cf:${custom.id}` : "");
    if (!target || used.has(target)) return "";
    used.add(target);
    return target;
  });
}
export function mappedRows(
  sheet: ImportSheet,
  mapping: string[],
  fields: CustomField[],
  targets: string[] = contactTargets,
): ImportInput[] {
  validateMatrix(sheet.rows);
  const selected = mapping.filter(Boolean);
  if (!selected.includes("name")) throw new Error("Map a column to Name.");
  if (new Set(selected).size !== selected.length)
    throw new Error("Map each target field only once.");
  for (const target of selected)
    if (
      !targets.includes(target) &&
      !fields.some((f) => !f.archived_at && `cf:${f.id}` === target)
    )
      throw new Error("A mapped field is no longer available.");
  return sheet.rows.slice(1).map((source, index) => {
    const payload: Record<string, unknown> = {},
      custom: Record<string, unknown> = {};
    const errors: string[] = [];
    if (source.some(unsafeFormula))
      errors.push("Formula-like cell: replace it with a plain value.");
    mapping.forEach((target, col) => {
      if (!target) return;
      const value = (source[col] || "").trim();
      if (!value) return; // Empty mapped cells never erase existing values.
      if (target.startsWith("cf:")) {
        const field = fields.find((f) => `cf:${f.id}` === target)!;
        let typed: unknown = value;
        if (field.field_type === "number") {
          typed = Number(value);
          if (!Number.isFinite(typed) || Math.abs(typed as number) > 1e15)
            errors.push(`Invalid number: ${field.name}.`);
        } else if (field.field_type === "boolean") {
          if (/^(yes|true|1)$/i.test(value)) typed = true;
          else if (/^(no|false|0)$/i.test(value)) typed = false;
          else errors.push(`Choose Yes or No: ${field.name}.`);
        } else if (
          field.field_type === "date" &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 10) !== value)
        )
          errors.push(`Use YYYY-MM-DD: ${field.name}.`);
        else if (
          field.field_type === "dropdown" &&
          !field.options.includes(value)
        )
          errors.push(`Unknown option: ${field.name}.`);
        custom[field.id] = typed;
      } else
        payload[target] =
          target === "email"
            ? normalizedEmail(value)
            : target === "phone"
              ? normalizedPhone(value)
              : target === "tags"
                ? value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean)
                : value;
      if (
        target === "phone" &&
        (!/^[+\d() .-]+$/.test(value) ||
          !/^\d{7,15}$/.test(normalizedPhone(value)))
      )
        errors.push(
          "Phone must have 7–15 digits; include a country code when known.",
        );
    });
    if (!String(payload.name || "").trim() || String(payload.name).length > 200)
      errors.push("Name is required, up to 200 characters.");
    if (
      payload.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email))
    )
      errors.push("Invalid email.");
    if (Object.keys(custom).length) payload.custom_values = custom;
    return {
      row_no: index + 2,
      payload,
      source,
      client_error: errors.join(" ").slice(0, 1000),
    };
  });
}
export function inputBatches(rows: ImportInput[]) {
  const result: ImportInput[][] = [];
  let batch: ImportInput[] = [];
  for (const row of rows) {
    if (
      new TextEncoder().encode(JSON.stringify(row)).length >
      importLimits.batchBytes - 1024
    )
      throw new Error("A mapped row is too large; select fewer columns.");
    if (
      batch.length &&
      (batch.length >= importLimits.batchRows ||
        new TextEncoder().encode(JSON.stringify([...batch, row])).length >
          importLimits.batchBytes)
    ) {
      result.push(batch);
      batch = [];
    }
    batch.push(row);
  }
  if (batch.length) result.push(batch);
  return result;
}

export function errorCsvData(
  headers: string[],
  entries: { row_no: number; error: string; source: string[] }[],
) {
  const protect = (text: string) =>
    /^[\s\x00-\x1f]*[=+@-]/.test(text) ? "'" + text : text;
  return {
    columns: ["row", "error", ...headers.map((_, i) => "column_" + i)],
    labels: Object.fromEntries(
      headers.map((h, i) => ["column_" + i, protect(h)]),
    ),
    rows: entries.map((r) =>
      Object.fromEntries([
        ["row", r.row_no],
        ["error", protect(r.error)],
        ...r.source.map((v, i) => ["column_" + i, protect(v)]),
      ]),
    ),
  };
}
