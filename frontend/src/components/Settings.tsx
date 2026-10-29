import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Check,
  Plus,
  Trash2,
  Download,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "../lib/client";
import { useAuth } from "../lib/auth";
import type { Stage } from "../lib/auth";
import { entities } from "../lib/model";
import { exportRecords } from "../lib/data";
import { PageTitle, Section, ErrorMessage } from "./ui";
import Security from "./Security";
import Billing from "./Billing";
import { assertExportAllowed } from "../lib/billing";
export default function Settings() {
  const { org, profile, role, memberships, setOrgId, refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "workspace";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<Stage[]>(org!.pipeline_stages);
  const admin = role === "Administrator";
  async function saveOrg(payload: Record<string, any>) {
    setBusy(true);
    setError("");
    try {
      const { error } = await supabase
        .from("organizations")
        .update(payload)
        .eq("id", org!.id)
        .select("id")
        .single();
      if (error) throw error;
      await refresh();
      toast.success("Settings saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      await assertExportAllowed(org!.id);
      const exportData: Record<string, any> = {
        exported_at: new Date().toISOString(),
        organization: org,
      };
      for (const e of Object.values(entities)) {
        exportData[e.table] = await exportRecords(
          e,
          org!.id,
          new URLSearchParams(),
          org!.timezone,
        );
        exportData[e.table + "_archived"] = await exportRecords(
          e,
          org!.id,
          new URLSearchParams("archived=1"),
          org!.timezone,
        );
      }
      for (const table of [
        "memberships",
        "pitch_sections",
        "deal_stage_history",
        "pitch_status_history",
      ]) {
        let start = 0;
        exportData[table] = [];
        while (true) {
          const { data, error } = await supabase
            .from(table)
            .select("*")
            .eq("org_id", org!.id)
            .order("id")
            .range(start, start + 499);
          if (error) throw error;
          exportData[table].push(...data);
          if (data.length < 500) break;
          start += 500;
        }
      }
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exportData, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "align-workspace-export.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Workspace data exported");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        title="Settings"
        description="A workspace that works the way you do."
      />
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            ["workspace", "Workspace"],
            ["profile", "Your profile"],
            ["security", "Security & sessions"],
            ["pipeline", "Sales pipeline"],
            ["sources", "Lead sources"],
            ["integrations", "Integrations & payments"],
            ["data", "Data & export"],
            ["billing", "Plans & billing"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={key === tab ? "selected" : ""}
              onClick={() => {
                setParams({ tab: key });
                setError("");
              }}
            >
              {label}
            </button>
          ))}
          <Link to="/team">
            Team & permissions
            <ExternalLink size={12} />
          </Link>
          <Link to="/targets">
            Sales targets
            <ExternalLink size={12} />
          </Link>
        </nav>
        <div className="settings-main">
          {tab === "security" ? (
            <Security />
          ) : tab === "billing" ? (
            <Billing />
          ) : tab === "workspace" ? (
            <Section
              title="Workspace profile"
              description="Your company details, currency, and time zone."
            >
              <form
                key={org!.id + org!.name}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  saveOrg({
                    name: String(f.get("name")).trim(),
                    website: f.get("website"),
                    currency: f.get("currency"),
                    timezone: f.get("timezone"),
                  });
                }}
              >
                <fieldset disabled={!admin || busy}>
                  <div className="form-grid">
                    <label className="span-2">
                      Workspace name
                      <input
                        name="name"
                        required
                        maxLength={120}
                        defaultValue={org!.name}
                      />
                    </label>
                    <label className="span-2">
                      Website
                      <input
                        name="website"
                        type="url"
                        defaultValue={org!.website || ""}
                        placeholder="https://yourcompany.com"
                      />
                    </label>
                    <label>
                      Currency
                      <select name="currency" defaultValue={org!.currency}>
                        {["USD", "INR", "EUR", "GBP", "CAD", "AUD", "SGD"].map(
                          (c) => (
                            <option key={c}>{c}</option>
                          ),
                        )}
                      </select>
                      <small>
                        Locked once monetary records exist, to prevent mixed
                        totals.
                      </small>
                    </label>
                    <label>
                      Time zone
                      <select name="timezone" defaultValue={org!.timezone}>
                        {Intl.supportedValuesOf("timeZone").map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                        {!Intl.supportedValuesOf("timeZone").includes(
                          org!.timezone,
                        ) && <option>{org!.timezone}</option>}
                      </select>
                    </label>
                  </div>
                  <div className="form-actions">
                    <button className="button primary">
                      <Check size={15} />
                      Save workspace
                    </button>
                  </div>
                </fieldset>
                {!admin && (
                  <p className="fine-print">
                    Only administrators can change workspace configuration.
                  </p>
                )}
              </form>
              {memberships.length > 1 && (
                <div className="workspace-selector">
                  <label>
                    Switch workspace
                    <select
                      value={org!.id}
                      onChange={(e) => setOrgId(e.target.value)}
                    >
                      {memberships.map((m) => (
                        <option key={m.org_id} value={m.org_id}>
                          {m.organizations.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </Section>
          ) : tab === "profile" ? (
            <Section
              title="Your profile"
              description="The details your teammates see."
            >
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError("");
                  const f = new FormData(e.currentTarget);
                  const { error } = await supabase
                    .from("profiles")
                    .update({
                      name: String(f.get("name")).trim(),
                      notifications: f.get("notifications") === "on",
                    })
                    .eq("id", profile.id)
                    .select("id")
                    .single();
                  setBusy(false);
                  if (error) setError(error.message);
                  else {
                    await refresh();
                    toast.success("Profile saved");
                  }
                }}
              >
                <div className="form-grid">
                  <label className="span-2">
                    Full name
                    <input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={profile?.name || ""}
                    />
                  </label>
                  <label className="span-2">
                    Account email
                    <input type="email" value={profile?.email || ""} readOnly />
                    <small>
                      Email changes are managed through Supabase Auth.
                    </small>
                  </label>
                  <label className="checkbox-label span-2">
                    <input
                      type="checkbox"
                      name="notifications"
                      defaultChecked={profile?.notifications !== false}
                    />
                    Show in-app task reminders
                  </label>
                </div>
                <div className="form-actions">
                  <button className="button primary" disabled={busy}>
                    Save profile
                  </button>
                </div>
              </form>
            </Section>
          ) : tab === "pipeline" ? (
            <Section
              title="Sales pipeline"
              description="Set stages and their default probabilities. Stages in use cannot be removed or have their outcome changed."
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  saveOrg({ pipeline_stages: stages });
                }}
              >
                <fieldset disabled={!admin || busy}>
                  <div className="stage-editor-header">
                    <span>Stage name</span>
                    <span>Probability</span>
                    <span>Outcome</span>
                    <span />
                  </div>
                  {stages.map((s, i) => (
                    <div className="stage-editor-row" key={i}>
                      <input
                        aria-label={`Stage ${i + 1} name`}
                        required
                        value={s.name}
                        onChange={(e) =>
                          setStages((a) =>
                            a.map((v, j) =>
                              j === i ? { ...v, name: e.target.value } : v,
                            ),
                          )
                        }
                      />
                      <div className="percent-input">
                        <input
                          aria-label={`${s.name} probability`}
                          type="number"
                          min="0"
                          max="100"
                          required
                          value={s.probability}
                          onChange={(e) =>
                            setStages((a) =>
                              a.map((v, j) =>
                                j === i
                                  ? {
                                      ...v,
                                      probability: Number(e.target.value),
                                    }
                                  : v,
                              ),
                            )
                          }
                        />
                        <span>%</span>
                      </div>
                      <select
                        aria-label={`${s.name} outcome`}
                        value={s.outcome}
                        onChange={(e) =>
                          setStages((a) =>
                            a.map((v, j) =>
                              j === i
                                ? {
                                    ...v,
                                    outcome: e.target.value as Stage["outcome"],
                                  }
                                : v,
                            ),
                          )
                        }
                      >
                        <option value="open">Open</option>
                        <option value="won">Won</option>
                        <option value="lost">Lost</option>
                      </select>
                      <div className="stage-order">
                        <button
                          className="icon-button"
                          type="button"
                          disabled={i === 0}
                          aria-label="Move stage up"
                          onClick={() =>
                            setStages((a) => {
                              const n = [...a];
                              [n[i - 1], n[i]] = [n[i], n[i - 1]];
                              return n;
                            })
                          }
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          disabled={i === stages.length - 1}
                          aria-label="Move stage down"
                          onClick={() =>
                            setStages((a) => {
                              const n = [...a];
                              [n[i], n[i + 1]] = [n[i + 1], n[i]];
                              return n;
                            })
                          }
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          className="icon-button text-danger"
                          type="button"
                          aria-label="Remove stage"
                          onClick={() =>
                            setStages((a) => a.filter((_, j) => j !== i))
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="button"
                    type="button"
                    onClick={() =>
                      setStages((a) => [
                        ...a,
                        { name: "New stage", probability: 10, outcome: "open" },
                      ])
                    }
                  >
                    <Plus size={14} />
                    Add stage
                  </button>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => setStages(org!.pipeline_stages)}
                    >
                      Reset changes
                    </button>
                    <button className="button primary">Save pipeline</button>
                  </div>
                </fieldset>
              </form>
            </Section>
          ) : tab === "sources" ? (
            <Section
              title="Lead sources"
              description="One source per line. Existing lead records retain their previous source."
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  saveOrg({
                    lead_sources: [
                      ...new Set(
                        String(f.get("sources"))
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      ),
                    ],
                  });
                }}
              >
                <fieldset disabled={!admin || busy}>
                  <label>
                    Available sources
                    <textarea
                      rows={8}
                      name="sources"
                      required
                      defaultValue={org!.lead_sources.join("\n")}
                    />
                  </label>
                  <div className="form-actions">
                    <button className="button primary">Save sources</button>
                  </div>
                </fieldset>
              </form>
            </Section>
          ) : tab === "integrations" ? (
            <>
              <Section
                title="Connection status"
                description="External actions are only available when a real service is configured."
              >
                <div className="integration-row">
                  <span className="integration-icon">
                    <ShieldCheck />
                  </span>
                  <div>
                    <strong>Supabase</strong>
                    <p>PostgreSQL database and account authentication</p>
                  </div>
                  <span className="badge good">
                    <span />
                    Connected
                  </span>
                </div>
                {[
                  [
                    "Customer email delivery",
                    "No email provider configured. Sent statuses are recorded manually.",
                  ],
                  [
                    "Customer proposal view tracking",
                    "Not configured. Viewed status cannot be set manually.",
                  ],
                  [
                    "Calendar synchronization",
                    "Not configured. Meetings can be logged manually.",
                  ],
                  [
                    "Payment provider synchronization",
                    "Not configured. No payment collection is performed.",
                  ],
                ].map(([title, description]) => (
                  <div className="integration-row" key={title}>
                    <div>
                      <strong>{title}</strong>
                      <p>{description}</p>
                    </div>
                    <span className="badge neutral">Unconfigured</span>
                  </div>
                ))}
              </Section>
              <Section
                title="Manual payment records"
                description="Record payments you received elsewhere. These remain separate from closed-won deal value."
              >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    saveOrg({
                      payment_tracking: f.get("payment_tracking") === "on",
                    });
                  }}
                >
                  <fieldset disabled={!admin || busy}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name="payment_tracking"
                        defaultChecked={org!.payment_tracking}
                      />
                      Enable manual payment tracking
                    </label>
                    <div className="form-actions">
                      <button className="button primary">
                        Save preferences
                      </button>
                    </div>
                  </fieldset>
                </form>
                {org!.payment_tracking && (
                  <Link className="text-link" to="/payments">
                    Manage payment records
                    <ExternalLink size={13} />
                  </Link>
                )}
              </Section>
            </>
          ) : (
            <Section
              title="Your data, in your hands"
              description="Download the workspace records you have permission to read."
            >
              <p className="detail-text">
                The JSON export includes active and archived records, proposal
                sections, history, membership, and workspace configuration. It
                contains customer information and should be stored carefully.
                Individual list pages offer filtered CSV exports.
              </p>
              <button className="button" onClick={download} disabled={busy}>
                <Download size={16} />
                {busy ? "Preparing export…" : "Export workspace as JSON"}
              </button>
            </Section>
          )}
          {error && <ErrorMessage error={error} />}
        </div>
      </div>
    </>
  );
}
