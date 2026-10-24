import { useQuery } from "@tanstack/react-query";
import { supabase } from "./client";
import { useAuth } from "./auth";
import type { Entity, Row } from "./model";
import { cleanSearch, period, today, zonedBoundary } from "./utils";
import { assertExportAllowed } from "./billing";
export const pageSize = 12;
export function listQuery(
  entity: Entity,
  org: string,
  params: URLSearchParams,
  select = "*",
  count = false,
  zone = "Asia/Kolkata",
) {
  let query = supabase
    .from(entity.table)
    .select(select, count ? { count: "exact" } : undefined)
    .eq("org_id", org);
  query =
    params.get("archived") === "1"
      ? query.not("archived_at", "is", null)
      : query.is("archived_at", null);
  const q = cleanSearch(params.get("q") || "");
  if (q)
    query = query.or(entity.search.map((k) => `${k}.ilike.%${q}%`).join(","));
  for (const f of [
    "status",
    "owner_id",
    "source",
    "priority",
    "stage",
    "company_id",
    "contact_id",
    "lead_id",
    "deal_id",
    "pitch_id",
    "outcome",
    "template_id",
  ]) {
    const value = params.get(f);
    if (value) query = query.eq(f, value);
  }
  if (params.get("qualified") === "1")
    query = query.in("status", ["Qualified", "Converted"]);
  if (params.get("tag")) query = query.contains("tags", [params.get("tag")]);
  const dateKey =
    entity.table === "activities"
      ? "occurred_at"
      : params.get("outcome") === "won" || params.get("outcome") === "lost"
        ? "closed_at"
        : "created_at";
  if (params.get("month") && /^\d{4}-\d{2}$/.test(params.get("month")!)) {
    const m = params.get("month")!;
    const next = new Date(m + "-01T12:00:00Z");
    next.setUTCMonth(next.getUTCMonth() + 1);
    query = query
      .gte(dateKey, zonedBoundary(m + "-01", zone))
      .lt(dateKey, zonedBoundary(next.toISOString().slice(0, 10), zone));
  }
  if (params.get("since")) query = query.gte(dateKey, params.get("since")!);
  if (params.get("until")) query = query.lt(dateKey, params.get("until")!);
  if (params.get("close_from"))
    query = query.gte("expected_close_date", params.get("close_from")!);
  if (params.get("close_until"))
    query = query.lte("expected_close_date", params.get("close_until")!);
  if (params.get("min")) query = query.gte("amount", params.get("min")!);
  if (params.get("max")) query = query.lte("amount", params.get("max")!);
  if (params.get("due_before"))
    query = query
      .lte("due_date", params.get("due_before")!)
      .neq("status", "Completed");
  if (params.get("due_on"))
    query = query
      .eq("due_date", params.get("due_on")!)
      .neq("status", "Completed");
  if (params.get("due_after"))
    query = query
      .gt("due_date", params.get("due_after")!)
      .neq("status", "Completed");
  const sort = params.get("sort") || "created_at";
  const allowed = [...entity.columns, "created_at", "updated_at"];
  query = query
    .order(allowed.includes(sort) ? sort : "created_at", {
      ascending: params.get("direction") === "asc",
    })
    .order("id");
  return query.returns<Row[]>();
}
export function useRecords(entity: Entity, params: URLSearchParams) {
  const { org } = useAuth();
  const page = Math.max(1, Number(params.get("page")) || 1);
  return useQuery({
    queryKey: ["records", entity.table, org!.id, params.toString()],
    queryFn: async () => {
      const { data, error, count } = await listQuery(
        entity,
        org!.id,
        params,
        "*",
        true,
        org!.timezone,
      ).range((page - 1) * pageSize, page * pageSize - 1);
      if (error) throw error;
      return { rows: data as Row[], count: count || 0 };
    },
  });
}
export async function exportRecords(
  entity: Entity,
  org: string,
  params: URLSearchParams,
  zone = "Asia/Kolkata",
) {
  const rows: Row[] = [];
  await assertExportAllowed(org, entity.table);
  let start = 0;
  while (true) {
    const { data, error } = await listQuery(
      entity,
      org,
      params,
      "*",
      false,
      zone,
    ).range(start, start + 499);
    if (error) throw error;
    rows.push(...(data as Row[]));
    if (data.length < 500) break;
    start += 500;
  }
  return rows;
}
export function useSummary(range: string, from?: string, to?: string) {
  const { org } = useAuth();
  const p = period(range, org?.timezone || "Asia/Kolkata", from, to);
  return useQuery({
    queryKey: ["summary", org?.id, p.start, p.end],
    enabled: !!org,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("crm_summary", {
        o: org!.id,
        start_at: p.start,
        end_at: p.end,
      });
      if (error) throw error;
      return data as any;
    },
  });
}
export function useRecord(entity: Entity, id: string | undefined) {
  const { org } = useAuth();
  return useQuery({
    queryKey: ["record", entity.table, org!.id, id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from(entity.table)
        .select("*")
        .eq("org_id", org!.id)
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
  });
}
export const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function defaults(entity: Entity, owner: string, org: any) {
  const result: Record<string, any> = { owner_id: owner };
  for (const f of entity.fields) {
    result[f.key] =
      f.key === "owner_id"
        ? owner
        : f.key === "source"
          ? org.lead_sources[0]
          : f.key === "stage"
            ? org.pipeline_stages.find((s: any) => s.outcome === "open").name
            : f.key === "probability"
              ? org.pipeline_stages.find((s: any) => s.outcome === "open")
                  .probability
              : f.key === "priority"
                ? "Medium"
                : f.type === "select"
                  ? f.options?.[0] || ""
                  : f.type === "number"
                    ? 0
                    : f.type === "checkbox"
                      ? false
                      : f.key === "due_date"
                        ? today(org.timezone)
                        : f.type === "datetime-local"
                          ? localNow()
                          : "";
  }
  return result;
}
