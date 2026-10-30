import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./auth";
import { supabase } from "./client";
import type { Entity, Row } from "./model";

export type CustomField = {
  id: string;
  org_id: string;
  entity: "leads" | "contacts";
  name: string;
  field_type: "text" | "number" | "date" | "dropdown" | "boolean";
  options: string[];
  archived_at: string | null;
};
export type CustomFilter = {
  field: string;
  op: "eq" | "contains" | "gte" | "lte" | "empty" | "not_empty";
  value: string;
};
export type ViewConfiguration = {
  version: 1;
  params: Record<string, string>;
  columns: string[];
};
export type SavedView = {
  id: string;
  owner_id: string;
  name: string;
  visibility: "personal" | "shared";
  configuration: ViewConfiguration;
};
export const supportsCustomization = (entity: string) =>
  entity === "leads" || entity === "contacts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const savedParameters = new Set([
  "q",
  "archived",
  "status",
  "owner_id",
  "source",
  "priority",
  "company_id",
  "qualified",
  "tag",
  "month",
  "since",
  "until",
  "sort",
  "direction",
  "cf",
]);
export function parseCustomFilters(value: string | null): CustomFilter[] {
  if (!value) return [];
  const filters = JSON.parse(value);
  if (!Array.isArray(filters) || filters.length > 20)
    throw new Error("Use at most 20 custom field filters.");
  for (const filter of filters) {
    if (
      !filter ||
      !uuid.test(filter.field) ||
      !["eq", "contains", "gte", "lte", "empty", "not_empty"].includes(
        filter.op,
      ) ||
      typeof filter.value !== "string" ||
      filter.value.length > 2000
    )
      throw new Error(
        "A custom field filter is invalid. Clear it and try again.",
      );
  }
  return filters;
}
export function applyCustomFilters(
  query: any,
  params: URLSearchParams,
  fields: CustomField[],
) {
  for (const filter of parseCustomFilters(params.get("cf"))) {
    const field = fields.find((f) => f.id === filter.field);
    if (!field)
      throw new Error("A filter field is unavailable in this workspace.");
    const path = `custom_values->${filter.field}`;
    // Text extraction maps both missing keys and JSON null to SQL NULL, without
    // adding a second OR group that could conflict with the ordinary search.
    if (filter.op === "empty")
      query = query.is(`custom_values->>${filter.field}`, null);
    else if (filter.op === "not_empty")
      query = query.not(`custom_values->>${filter.field}`, "is", null);
    else if (filter.op === "contains")
      query = query.ilike(
        `custom_values->>${filter.field}`,
        `%${filter.value.replace(/[\\%_]/g, "\\$&")}%`,
      );
    else {
      // Values retain their database JSON type: numeric sorting must not be lexical.
      const type = field.field_type;
      const value =
        type === "number"
          ? Number(filter.value)
          : type === "boolean"
            ? filter.value === "true"
            : filter.value;
      if (
        type === "number" &&
        (!Number.isFinite(value) || filter.value.trim() === "")
      )
        throw new Error("Enter a valid custom number filter.");
      query = query.filter(path, filter.op, JSON.stringify(value));
    }
  }
  return query;
}
export function viewConfiguration(
  params: URLSearchParams,
  columns: string[],
): ViewConfiguration {
  return {
    version: 1,
    params: Object.fromEntries(
      [...params].filter(([key]) => savedParameters.has(key)),
    ),
    columns: [...columns],
  };
}
export function customValue(row: Row, column: string) {
  return column.startsWith("cf:")
    ? row.custom_values?.[column.slice(3)]
    : row[column];
}
export function serializeCustomValues(
  values: Record<string, unknown>,
  fields: CustomField[],
) {
  const result = { ...values };
  for (const field of fields.filter((f) => !f.archived_at)) {
    const value = result[field.id];
    if (value === "" || value === null || value === undefined) {
      delete result[field.id];
      continue;
    }
    if (field.field_type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number) || Math.abs(number) > 1e15)
        throw new Error(
          `Check ${field.name}: enter a number between -1e15 and 1e15.`,
        );
      result[field.id] = number;
    } else if (field.field_type === "boolean" && typeof value !== "boolean")
      throw new Error(`Check ${field.name}: choose Yes or No.`);
    else if (
      field.field_type === "text" &&
      (typeof value !== "string" || value.length > 2000)
    )
      throw new Error(`Check ${field.name}: use at most 2000 characters.`);
    else if (
      field.field_type === "dropdown" &&
      !field.options.includes(String(value))
    )
      throw new Error(`Check ${field.name}: choose an available option.`);
    else if (field.field_type === "date") {
      const date = String(value);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      )
        throw new Error(`Check ${field.name}: enter a valid date.`);
    }
  }
  return result;
}
export function customLabel(column: string, fields: CustomField[]) {
  const field = fields.find((f) => `cf:${f.id}` === column);
  return field
    ? `${field.name}${field.archived_at ? " (archived)" : ""}`
    : column;
}
export function archivedViewFields(
  config: ViewConfiguration,
  fields: CustomField[],
) {
  const refs = new Set(config.columns);
  if (config.params.sort) refs.add(config.params.sort);
  for (const filter of parseCustomFilters(config.params.cf || null))
    refs.add(`cf:${filter.field}`);
  return fields.filter((f) => f.archived_at && refs.has(`cf:${f.id}`));
}
export function visibleColumns(
  entity: Entity,
  params: URLSearchParams,
  fields: CustomField[],
) {
  const available = new Set([
    ...entity.columns,
    ...entity.fields.filter((f) => f.type !== "textarea").map((f) => f.key),
    "created_at",
    "updated_at",
    ...fields.map((f) => `cf:${f.id}`),
  ]);
  const selected = params.get("columns")?.split(",") || [
    ...entity.columns,
    ...fields.filter((f) => !f.archived_at).map((f) => `cf:${f.id}`),
  ];
  return [
    "name",
    ...new Set(selected.filter((c) => c !== "name" && available.has(c))),
  ];
}
export function useCustomFields(entity: string) {
  const { org } = useAuth();
  return useQuery({
    queryKey: ["custom-fields", org?.id, entity],
    enabled: !!org && supportsCustomization(entity),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_field_definitions")
        .select("*")
        .eq("org_id", org!.id)
        .eq("entity", entity)
        .order("created_at")
        .order("id");
      if (error) throw error;
      return data as CustomField[];
    },
  });
}
