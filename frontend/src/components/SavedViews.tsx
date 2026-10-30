import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import type { Entity } from "../lib/model";
import { titleCase } from "../lib/model";
import {
  archivedViewFields,
  customLabel,
  parseCustomFilters,
  viewConfiguration,
  type CustomField,
  type CustomFilter,
  type SavedView,
} from "../lib/customization";
import { Confirm, ErrorMessage, Modal } from "./ui";

export default function SavedViews({
  entity,
  fields,
  columns,
  params,
  setParams,
}: {
  entity: Entity;
  fields: CustomField[];
  columns: string[];
  params: URLSearchParams;
  setParams: (params: URLSearchParams) => void;
}) {
  const { org, role, session } = useAuth();
  const cache = useQueryClient();
  const views = useQuery({
    queryKey: ["saved-views", org!.id, entity.table],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("saved_views")
        .select("*")
        .eq("org_id", org!.id)
        .eq("entity", entity.table)
        .order("name");
      if (error) throw error;
      return data as SavedView[];
    },
  });
  const [dialog, setDialog] = useState<"new" | "update" | "columns" | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = views.data?.find((v) => v.id === params.get("saved_view"));
  const editable =
    !!selected &&
    (selected.visibility === "shared"
      ? role === "Administrator"
      : selected.owner_id === session!.user.id);
  let archived: CustomField[] = [];
  try {
    archived = archivedViewFields(viewConfiguration(params, columns), fields);
  } catch {
    /* The records query displays invalid URL filter errors. */
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(e.currentTarget);
      const payload = {
        name: String(form.get("name") || "").trim(),
        visibility: String(form.get("visibility") || "personal"),
        configuration: viewConfiguration(params, columns),
      };
      const query =
        dialog === "update" && selected
          ? supabase
              .from("saved_views")
              .update(payload)
              .eq("id", selected.id)
              .eq("org_id", org!.id)
          : supabase.from("saved_views").insert({
              ...payload,
              org_id: org!.id,
              entity: entity.table,
              owner_id: session!.user.id,
            });
      const { data, error } = await query.select("id").single();
      if (error) throw error;
      await cache.invalidateQueries({ queryKey: ["saved-views"] });
      const next = new URLSearchParams(params);
      next.set("saved_view", data.id);
      setParams(next);
      setDialog(null);
      toast.success("View saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const apply = (id: string) => {
    const view = views.data?.find((v) => v.id === id);
    if (!view) {
      setParams(new URLSearchParams());
      return;
    }
    const next = new URLSearchParams(view.configuration.params);
    next.set("columns", view.configuration.columns.join(","));
    next.set("saved_view", view.id);
    setParams(next);
  };
  return (
    <div className="saved-views">
      <div className="customization-toolbar">
        <label>
          Saved view
          <select
            value={selected?.id || ""}
            onChange={(e) => apply(e.target.value)}
            disabled={views.isPending || !!views.error}
          >
            <option value="">Current / default view</option>
            {views.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.visibility}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button small"
          onClick={() => {
            setDialog("new");
            setError("");
          }}
        >
          Save new view
        </button>
        {editable && (
          <>
            <button
              className="button small"
              onClick={() => {
                setDialog("update");
                setError("");
              }}
            >
              Update view
            </button>
            <button className="button small" onClick={() => setDeleting(true)}>
              Delete view
            </button>
          </>
        )}
        <button className="button small" onClick={() => setDialog("columns")}>
          Fields & columns
        </button>
      </div>
      {selected && (
        <p className="fine-print">
          Changes to filters, sorting or columns are temporary until you update
          the view.
        </p>
      )}
      {!!archived.length && (
        <div className="notice" role="status">
          This view references archived fields:{" "}
          {archived.map((f) => f.name).join(", ")}. Their values, filters and
          sorting are retained. Restore the fields in Settings or remove their
          references and update the view.
        </div>
      )}
      {views.error && (
        <ErrorMessage
          error={(views.error as Error).message}
          retry={() => views.refetch()}
        />
      )}
      {(dialog === "new" || dialog === "update") && (
        <Modal
          open
          onClose={() => !busy && setDialog(null)}
          title={dialog === "new" ? "Save view" : "Update view"}
        >
          <form onSubmit={save} className="saved-view-form">
            <label>
              View name
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={dialog === "update" ? selected?.name : ""}
              />
            </label>
            <label>
              Visibility
              <select
                name="visibility"
                defaultValue={
                  dialog === "update" ? selected?.visibility : "personal"
                }
              >
                {(dialog === "new" ||
                  selected?.owner_id === session!.user.id) && (
                  <option value="personal">Personal — only you</option>
                )}
                {role === "Administrator" && (
                  <option value="shared">Shared — workspace members</option>
                )}
              </select>
            </label>
            {error && <ErrorMessage error={error} />}
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                {busy ? "Saving…" : "Save view"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "columns" && (
        <ColumnsAndFilters
          entity={entity}
          fields={fields}
          columns={columns}
          params={params}
          apply={(next) => {
            setParams(next);
            setDialog(null);
          }}
          close={() => setDialog(null)}
        />
      )}
      <Confirm
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete saved view?"
        description="Only this saved configuration is removed. Customer records and custom field values are not changed."
        onConfirm={async () => {
          const { error } = await supabase
            .from("saved_views")
            .delete()
            .eq("id", selected!.id)
            .eq("org_id", org!.id)
            .select("id")
            .single();
          if (error) throw error;
          await cache.invalidateQueries({ queryKey: ["saved-views"] });
          const next = new URLSearchParams(params);
          next.delete("saved_view");
          setParams(next);
          setDeleting(false);
        }}
      />
    </div>
  );
}
function ColumnsAndFilters({
  entity,
  fields,
  columns,
  params,
  apply,
  close,
}: {
  entity: Entity;
  fields: CustomField[];
  columns: string[];
  params: URLSearchParams;
  apply: (params: URLSearchParams) => void;
  close: () => void;
}) {
  const [chosen, setChosen] = useState(columns);
  const [filters, setFilters] = useState<CustomFilter[]>(() => {
    try {
      return parseCustomFilters(params.get("cf"));
    } catch {
      return [];
    }
  });
  const allColumns = [
    ...new Set([
      ...entity.columns,
      ...entity.fields.filter((f) => f.type !== "textarea").map((f) => f.key),
      "created_at",
      "updated_at",
      ...fields.map((f) => `cf:${f.id}`),
    ]),
  ];
  const [error, setError] = useState("");
  return (
    <Modal open onClose={close} title="Custom filters & visible columns" wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            for (const filter of filters) {
              const field = fields.find((f) => f.id === filter.field);
              if (!field) throw new Error("Choose a field for each filter.");
              if (
                !["empty", "not_empty"].includes(filter.op) &&
                !filter.value.trim()
              )
                throw new Error("Enter a value for each filter.");
              if (
                field.field_type === "number" &&
                !["empty", "not_empty"].includes(filter.op) &&
                !Number.isFinite(Number(filter.value))
              )
                throw new Error("Enter a valid number.");
            }
            const next = new URLSearchParams(params);
            next.set("columns", chosen.join(","));
            if (filters.length) next.set("cf", JSON.stringify(filters));
            else next.delete("cf");
            next.delete("page");
            apply(next);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <h3>Visible columns</h3>
        <div className="custom-columns">
          {allColumns.map((column) => (
            <label className="checkbox-label" key={column}>
              <input
                type="checkbox"
                checked={chosen.includes(column)}
                disabled={column === "name"}
                onChange={(e) =>
                  setChosen((items) =>
                    e.target.checked
                      ? [...items, column]
                      : items.filter((v) => v !== column),
                  )
                }
              />
              {column.startsWith("cf:")
                ? customLabel(column, fields)
                : titleCase(column)}
            </label>
          ))}
        </div>
        <h3>Custom field filters</h3>
        <p className="fine-print">
          All custom filters must match. Empty includes both unset and
          explicitly cleared values.
        </p>
        {filters.map((filter, index) => {
          const field = fields.find((f) => f.id === filter.field);
          const change = (value: Partial<CustomFilter>) =>
            setFilters((items) =>
              items.map((v, i) => (i === index ? { ...v, ...value } : v)),
            );
          return (
            <div className="custom-filter-row" key={index}>
              <select
                aria-label={`Filter ${index + 1} field`}
                value={filter.field}
                onChange={(e) =>
                  change({ field: e.target.value, op: "eq", value: "" })
                }
              >
                <option value="">Choose field</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.archived_at ? " (archived)" : ""}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Filter ${index + 1} operator`}
                value={filter.op}
                onChange={(e) =>
                  change({ op: e.target.value as CustomFilter["op"] })
                }
              >
                <option value="eq">Equals</option>
                {field?.field_type === "text" && (
                  <option value="contains">Contains</option>
                )}
                {["number", "date"].includes(field?.field_type || "") && (
                  <>
                    <option value="gte">At least / on or after</option>
                    <option value="lte">At most / on or before</option>
                  </>
                )}
                <option value="empty">Is empty</option>
                <option value="not_empty">Is not empty</option>
              </select>
              {!["empty", "not_empty"].includes(filter.op) &&
                (field?.field_type === "boolean" ||
                field?.field_type === "dropdown" ? (
                  <select
                    aria-label={`Filter ${index + 1} value`}
                    value={filter.value}
                    onChange={(e) => change({ value: e.target.value })}
                  >
                    <option value="">Choose value</option>
                    {(field.field_type === "boolean"
                      ? ["true", "false"]
                      : field.options
                    ).map((v) => (
                      <option key={v} value={v}>
                        {field.field_type === "boolean"
                          ? v === "true"
                            ? "Yes"
                            : "No"
                          : v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={`Filter ${index + 1} value`}
                    type={
                      field?.field_type === "number" ||
                      field?.field_type === "date"
                        ? field.field_type
                        : "text"
                    }
                    step="any"
                    maxLength={2000}
                    value={filter.value}
                    onChange={(e) => change({ value: e.target.value })}
                  />
                ))}
              <button
                className="button small"
                type="button"
                onClick={() =>
                  setFilters((items) => items.filter((_, i) => i !== index))
                }
              >
                Remove
              </button>
            </div>
          );
        })}
        <button
          className="button small"
          type="button"
          disabled={filters.length >= 20 || !fields.length}
          onClick={() =>
            setFilters((items) => [
              ...items,
              { field: "", op: "eq", value: "" },
            ])
          }
        >
          Add custom filter
        </button>
        {error && <ErrorMessage error={error} />}
        <div className="form-actions">
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary">Apply</button>
        </div>
      </form>
    </Modal>
  );
}
