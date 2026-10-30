import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import { useCustomFields, type CustomField } from "../lib/customization";
import { Confirm, ErrorMessage, Loading, Modal, Section } from "./ui";

export function CustomValueInput({
  field,
  value,
  onChange,
}: {
  field: CustomField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.field_type === "boolean")
    return (
      <select
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : e.target.value === "true")
        }
      >
        <option value="">Not set</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  if (field.field_type === "dropdown")
    return (
      <select
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Not set</option>
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  return (
    <input
      type={field.field_type}
      value={String(value ?? "")}
      maxLength={field.field_type === "text" ? 2000 : undefined}
      step={field.field_type === "number" ? "any" : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function CustomFieldsSettings() {
  const { org, role } = useAuth();
  const cache = useQueryClient();
  const [entity, setEntity] = useState("leads");
  const fields = useCustomFields(entity);
  const [editing, setEditing] = useState<CustomField | "new" | null>(null);
  const [archiving, setArchiving] = useState<CustomField | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = role === "Administrator";
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget);
      const name = String(form.get("name") || "").trim();
      const type =
        editing && editing !== "new"
          ? editing.field_type
          : String(form.get("type"));
      const options =
        type === "dropdown"
          ? String(form.get("options") || "")
              .split(/\r?\n/)
              .map((v) => v.trim())
              .filter(Boolean)
          : [];
      const query =
        editing && editing !== "new"
          ? supabase
              .from("custom_field_definitions")
              .update({ name, options })
              .eq("id", editing.id)
              .eq("org_id", org!.id)
          : supabase
              .from("custom_field_definitions")
              .insert({
                org_id: org!.id,
                entity,
                name,
                field_type: type,
                options,
              });
      const { error } = await query.select("id").single();
      if (error) throw error;
      await cache.invalidateQueries();
      setEditing(null);
      toast.success("Custom field saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive(field: CustomField, archived: boolean) {
    const { error } = await supabase
      .from("custom_field_definitions")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", field.id)
      .eq("org_id", org!.id)
      .select("id")
      .single();
    if (error) throw error;
    await cache.invalidateQueries();
    toast.success(
      archived ? "Field archived; values retained" : "Field restored",
    );
  }
  return (
    <Section
      title="Custom fields"
      description="Workspace fields for Leads and Contacts. Archiving retains every stored value."
    >
      <div className="customization-toolbar">
        <label>
          Record type
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="leads">Leads</option>
            <option value="contacts">Contacts</option>
          </select>
        </label>
        {admin && (
          <button
            className="button primary"
            onClick={() => {
              setEditing("new");
              setError("");
            }}
          >
            <Plus size={15} />
            Add field
          </button>
        )}
      </div>
      {!admin && (
        <p className="fine-print">
          Only administrators can create, rename, archive or restore fields.
        </p>
      )}
      {fields.isPending ? (
        <Loading />
      ) : fields.error ? (
        <ErrorMessage error={(fields.error as Error).message} />
      ) : (
        <div className="custom-field-list">
          {!fields.data?.length && (
            <p className="muted">No custom fields yet.</p>
          )}
          {fields.data?.map((field) => (
            <div className="custom-field-row" key={field.id}>
              <div>
                <strong>{field.name}</strong>
                <small>
                  {field.field_type === "boolean" ? "Yes/no" : field.field_type}
                  {field.archived_at ? " · Archived · values retained" : ""}
                </small>
              </div>
              {admin && (
                <div className="customization-toolbar">
                  <button
                    className="button small"
                    onClick={() => {
                      setEditing(field);
                      setError("");
                    }}
                  >
                    Rename / options
                  </button>
                  <button
                    className="button small"
                    onClick={() => {
                      if (!field.archived_at) setArchiving(field);
                      else
                        archive(field, false).catch((e) =>
                          toast.error(e.message),
                        );
                    }}
                  >
                    {field.archived_at ? "Restore" : "Archive"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <Modal
          open
          onClose={() => !busy && setEditing(null)}
          title={editing === "new" ? "New custom field" : "Edit custom field"}
        >
          <CustomFieldEditor
            key={editing === "new" ? "new" : editing.id}
            field={editing === "new" ? null : editing}
            save={save}
            busy={busy}
            error={error}
          />
        </Modal>
      )}
      <Confirm
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title="Archive custom field?"
        description="This hides the field from entry forms. Stored values remain on records, and saved views keep their references with an archived-field warning. You can restore the field later."
        onConfirm={async () => {
          await archive(archiving!, true);
          setArchiving(null);
        }}
      />
    </Section>
  );
}
function CustomFieldEditor({
  field,
  save,
  busy,
  error,
}: {
  field: CustomField | null;
  save: (e: React.FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  error: string;
}) {
  const [type, setType] = useState(field?.field_type || "text");
  return (
    <form onSubmit={save}>
      <div className="form-grid">
        <label>
          Field name
          <input
            name="name"
            required
            maxLength={80}
            defaultValue={field?.name}
          />
        </label>
        <label>
          Type
          <select
            name="type"
            value={type}
            disabled={!!field}
            onChange={(e) =>
              setType(e.target.value as CustomField["field_type"])
            }
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="dropdown">Dropdown</option>
            <option value="boolean">Yes/no</option>
          </select>
        </label>
        {type === "dropdown" && (
          <label className="span-2">
            Options, one per line
            <textarea
              name="options"
              required
              rows={5}
              maxLength={4050}
              defaultValue={field?.options.join("\n")}
            />
            <small>
              Existing options must remain. New options can be appended.
            </small>
          </label>
        )}
      </div>
      <p className="fine-print">
        Field identity and type stay fixed to protect existing data. Up to 50
        active fields per record type.
      </p>
      {error && <ErrorMessage error={error} />}
      <div className="form-actions">
        <button className="button primary" disabled={busy}>
          {busy ? "Saving…" : "Save field"}
        </button>
      </div>
    </form>
  );
}
