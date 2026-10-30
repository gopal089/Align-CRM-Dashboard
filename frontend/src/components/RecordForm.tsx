import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "../lib/client";
import { useAuth } from "../lib/auth";
import { defaults } from "../lib/data";
import type { Entity, Field, Row } from "../lib/model";
import { cleanSearch } from "../lib/utils";
import { Modal, ErrorMessage } from "./ui";
import {
  serializeCustomValues,
  supportsCustomization,
  useCustomFields,
} from "../lib/customization";
import { CustomValueInput } from "./CustomFields";
export function RelationField({
  field,
  value,
  onChange,
  disabled = false,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { org, members } = useAuth();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(cleanSearch(search)), 200);
    return () => clearTimeout(t);
  }, [search]);
  const table = field.relation!;
  const options = useQuery({
    queryKey: ["options", table, org!.id, q],
    enabled: table !== "memberships",
    queryFn: async () => {
      let query = supabase
        .from(table)
        .select("id,name")
        .eq("org_id", org!.id)
        .is("archived_at", null)
        .order("name")
        .limit(50);
      if (q) query = query.ilike("name", `%${q}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
  const chosen = useQuery({
    queryKey: ["option", table, org!.id, value],
    enabled: !!value && table !== "memberships",
    queryFn: async () => {
      const { data, error } = await supabase
        .from(table)
        .select("id,name")
        .eq("org_id", org!.id)
        .eq("id", value)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const list =
    table === "memberships"
      ? members
          .filter((m) => m.active || m.user_id === value)
          .map((m) => ({ id: m.user_id, name: m.profiles.name }))
      : options.data || [];
  const merged =
    chosen.data && !list.some((x) => x.id === chosen.data!.id)
      ? [chosen.data, ...list]
      : list;
  return (
    <div className="relation-field">
      {table !== "memberships" && !disabled && (
        <input
          aria-label={`Search ${field.label}`}
          placeholder={`Find ${field.label.toLowerCase()}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <select
        aria-label={field.label}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        required={field.required}
        disabled={disabled}
      >
        <option value="">
          {field.required ? "Select" : "None"}
          {options.isLoading ? " — loading…" : ""}
        </option>
        {merged.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      {options.error && (
        <small className="text-danger">
          Could not load options. {(options.error as Error).message}
        </small>
      )}
      {table !== "memberships" && list.length === 50 && (
        <small>Showing 50 matches. Search to narrow the list.</small>
      )}
    </div>
  );
}
type Section = { title: string; content: string };
export default function RecordForm({
  entity,
  record,
  onClose,
  onSaved,
  initial = {},
}: {
  entity: Entity;
  record?: Row;
  onClose: () => void;
  onSaved: (id: string) => void;
  initial?: Record<string, any>;
}) {
  const { org, session, role } = useAuth();
  const customFields = useCustomFields(entity.table);
  const cache = useQueryClient();
  const [values, setValues] = useState<Record<string, any>>(() => ({
    ...defaults(entity, session!.user.id, org),
    ...initial,
    ...record,
  }));
  const [sections, setSections] = useState<Section[]>(record?.sections || []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isPitch = entity.table === "pitches",
    isTemplate = entity.table === "pitch_templates";
  const showSections = isPitch || isTemplate;
  const sectionQuery = useQuery({
    queryKey: ["sections", record?.id],
    enabled: isPitch && !!record,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pitch_sections")
        .select("*")
        .eq("pitch_id", record!.id)
        .eq("org_id", org!.id)
        .order("position");
      if (error) throw error;
      return data as Section[];
    },
  });
  useEffect(() => {
    if (sectionQuery.data) setSections(sectionQuery.data);
  }, [sectionQuery.data]);
  async function update(key: string, value: any) {
    setValues((v) => ({
      ...v,
      [key]: value,
      ...(key === "stage"
        ? {
            probability:
              org!.pipeline_stages.find((s) => s.name === value)?.probability ||
              0,
          }
        : {}),
    }));
    if (key === "template_id" && value && !record) {
      const { data, error } = await supabase
        .from("pitch_templates")
        .select("*")
        .eq("org_id", org!.id)
        .eq("id", value)
        .single();
      if (error) {
        toast.error(error.message);
        return;
      }
      setSections(data.sections || []);
      setValues((v) => ({ ...v, terms: data.terms || "" }));
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload: Record<string, any> = { org_id: org!.id };
      if (supportsCustomization(entity.table)) {
        if (!customFields.data || customFields.error)
          throw new Error(
            "Custom fields could not be loaded. Retry before saving.",
          );
        payload.custom_values = serializeCustomValues(
          values.custom_values || {},
          customFields.data,
        );
      }
      for (const f of entity.fields) {
        let v = values[f.key];
        if (f.key === "name") v = String(v || "").trim();
        if (f.required && !String(v ?? "").trim() && f.type !== "checkbox")
          throw new Error(`${f.label} is required.`);
        if (f.type === "number") {
          v = Number(v);
          if (
            !Number.isFinite(v) ||
            v < (f.min ?? 0) ||
            (f.max !== undefined && v > f.max)
          )
            throw new Error(`Check ${f.label.toLowerCase()}.`);
        }
        if (f.type === "relation") v = v || null;
        if (f.type === "tags")
          v = Array.isArray(v)
            ? v
            : String(v || "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
        if (f.type === "datetime-local") v = new Date(v).toISOString();
        if (f.type === "date") v = v || null;
        payload[f.key] = v;
      }
      if (payload.website && !/^https?:\/\//.test(payload.website))
        throw new Error("Website must start with https:// or http://.");
      if (
        entity.table === "sales_targets" &&
        payload.period_end < payload.period_start
      )
        throw new Error("End date must be after the start date.");
      if (showSections && sections.some((s) => !s.title.trim()))
        throw new Error("Give every proposal section a title.");
      let id: string;
      if (isPitch) {
        const { data, error } = await supabase.rpc("save_pitch", {
          payload,
          sections,
          record_id: record?.id || null,
        });
        if (error) throw error;
        id = data;
      } else {
        if (isTemplate) payload.sections = sections;
        const query = record
          ? supabase
              .from(entity.table)
              .update(payload)
              .eq("id", record.id)
              .eq("org_id", org!.id)
          : supabase.from(entity.table).insert(payload);
        const { data, error } = await query.select("id").single();
        if (error) throw error;
        id = data.id;
      }
      await cache.invalidateQueries();
      toast.success(
        `${entity.singular[0].toUpperCase() + entity.singular.slice(1)} ${record ? "updated" : "created"}`,
      );
      onSaved(id);
    } catch (e) {
      const err = e as { message: string; code?: string };
      setError(
        err.code === "23505"
          ? "A record with this email or company name already exists. Check archived records too."
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={`${record ? "Edit" : "New"} ${entity.singular}`}
      description={
        isPitch
          ? "Build a clear proposal. Save a draft and continue whenever you’re ready."
          : `Add the details your team needs to move this ${entity.singular} forward.`
      }
      wide
    >
      <form onSubmit={save}>
        <div className="form-scroll">
          <div className="form-grid">
            {entity.fields.map((f) => {
              const opts =
                f.key === "status" && record?.status === "Converted"
                  ? ["Converted"]
                  : f.key === "source"
                    ? org!.lead_sources
                    : f.key === "stage"
                      ? org!.pipeline_stages.map((s) => s.name)
                      : f.options;
              const value = values[f.key] ?? "";
              const disabled =
                (f.key === "owner_id" && role === "Sales Representative") ||
                (f.key === "status" && record?.status === "Converted");
              return (
                <label
                  className={`${f.type === "textarea" ? "span-2" : ""} ${f.type === "checkbox" ? "checkbox-label" : ""}`}
                  key={f.key}
                >
                  <span>
                    {f.label}
                    {f.required && <b className="required">*</b>}
                    {f.type === "number" && f.key === "amount" && (
                      <small> · {org!.currency}</small>
                    )}
                  </span>
                  {f.type === "relation" ? (
                    <RelationField
                      field={f}
                      value={value}
                      onChange={(v) => update(f.key, v)}
                      disabled={disabled}
                    />
                  ) : f.type === "select" ? (
                    <select
                      value={value}
                      disabled={disabled}
                      required={f.required}
                      onChange={(e) => update(f.key, e.target.value)}
                    >
                      {!f.required && <option value="">Select…</option>}
                      {opts?.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : f.type === "textarea" ? (
                    <textarea
                      rows={3}
                      value={value}
                      onChange={(e) => update(f.key, e.target.value)}
                      maxLength={20000}
                    />
                  ) : f.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      checked={!!value}
                      onChange={(e) => update(f.key, e.target.checked)}
                    />
                  ) : (
                    <input
                      type={f.type === "tags" ? "text" : f.type || "text"}
                      value={
                        f.type === "tags" && Array.isArray(value)
                          ? value.join(", ")
                          : f.type === "datetime-local" && value.includes("Z")
                            ? new Date(
                                new Date(value).getTime() -
                                  new Date(value).getTimezoneOffset() * 60000,
                              )
                                .toISOString()
                                .slice(0, 16)
                            : value
                      }
                      required={f.required}
                      min={f.min}
                      max={f.max}
                      step={f.type === "number" ? "0.01" : undefined}
                      maxLength={f.type === "number" ? undefined : 500}
                      onChange={(e) => update(f.key, e.target.value)}
                    />
                  )}
                  {f.hint && <small>{f.hint}</small>}
                  {f.type === "datetime-local" && (
                    <small>
                      Enter the time in your device time zone. Saved timestamps
                      display in the workspace time zone.
                    </small>
                  )}
                </label>
              );
            })}
          </div>
          {supportsCustomization(entity.table) && (
            <div className="section-editor">
              <h3>Custom fields</h3>
              {customFields.isPending && <p>Loading custom fields…</p>}
              {customFields.error && (
                <ErrorMessage
                  error={(customFields.error as Error).message}
                  retry={() => customFields.refetch()}
                />
              )}
              <div className="form-grid">
                {customFields.data
                  ?.filter((field) => !field.archived_at)
                  .map((field) => (
                    <label key={field.id}>
                      <span>{field.name}</span>
                      <CustomValueInput
                        field={field}
                        value={values.custom_values?.[field.id]}
                        onChange={(value) =>
                          setValues((current) => ({
                            ...current,
                            custom_values: {
                              ...current.custom_values,
                              [field.id]: value,
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
              </div>
              {customFields.data?.some(
                (field) =>
                  field.archived_at && values.custom_values?.[field.id] != null,
              ) && (
                <p className="fine-print">
                  Archived field values are retained unchanged. Restore a field
                  in Settings to edit its value.
                </p>
              )}
            </div>
          )}
          {isPitch && (
            <div className="notice">
              Sent means you manually recorded an external send. This app does
              not send customer emails or track proposal views.
            </div>
          )}
          {showSections && (
            <div className="section-editor">
              <div className="section-editor-heading">
                <div>
                  <h3>Proposal sections</h3>
                  <p>
                    Use placeholders such as {"{{customer}}"}, {"{{solution}}"},{" "}
                    {"{{pricing}}"}, and {"{{terms}}"} in templates.
                  </p>
                </div>
                <button
                  className="button"
                  type="button"
                  disabled={sections.length >= 30}
                  onClick={() =>
                    setSections((s) => [...s, { title: "", content: "" }])
                  }
                >
                  <Plus size={15} />
                  Add section
                </button>
              </div>
              {sectionQuery.isLoading && <p>Loading sections…</p>}
              {sectionQuery.error && (
                <ErrorMessage error={(sectionQuery.error as Error).message} />
              )}
              {sections.map((s, i) => (
                <div className="editable-section" key={i}>
                  <div>
                    <span className="section-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <input
                      aria-label={`Section ${i + 1} title`}
                      placeholder="Section title"
                      required
                      value={s.title}
                      onChange={(e) =>
                        setSections((items) =>
                          items.map((x, j) =>
                            i === j ? { ...x, title: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      disabled={i === 0}
                      aria-label="Move section up"
                      onClick={() =>
                        setSections((items) => {
                          const a = [...items];
                          [a[i - 1], a[i]] = [a[i], a[i - 1]];
                          return a;
                        })
                      }
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={i === sections.length - 1}
                      aria-label="Move section down"
                      onClick={() =>
                        setSections((items) => {
                          const a = [...items];
                          [a[i], a[i + 1]] = [a[i + 1], a[i]];
                          return a;
                        })
                      }
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      className="icon-button text-danger"
                      type="button"
                      aria-label="Remove section"
                      onClick={() =>
                        setSections((items) => items.filter((_, j) => i !== j))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <textarea
                    aria-label={`Section ${i + 1} content`}
                    rows={4}
                    value={s.content}
                    onChange={(e) =>
                      setSections((items) =>
                        items.map((x, j) =>
                          i === j ? { ...x, content: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
              ))}
            </div>
          )}
          {error && <ErrorMessage error={error} />}
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              sectionQuery.isLoading ||
              !!sectionQuery.error ||
              (supportsCustomization(entity.table) &&
                (customFields.isPending || !!customFields.error))
            }
          >
            {busy && <LoaderCircle size={16} className="spin" />}
            {record ? "Save changes" : `Create ${entity.singular}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
