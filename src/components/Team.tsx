import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Target, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "../lib/client";
import { useAuth } from "../lib/auth";
import { useSummary } from "../lib/data";
import { initials, money, percent, period } from "../lib/utils";
import { Badge, Modal, PageTitle, Section, ErrorMessage, Empty } from "./ui";
export default function Team() {
  const { org, members, role, refresh, session } = useAuth();
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState<{ email: string; role: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const summary = useSummary("month");
  const admin = role === "Administrator";
  const reporting = period("month", org!.timezone);
  return (
    <>
      <PageTitle
        title="Your team"
        description="Shared context. Clear ownership. Better work, together."
      >
        <Link className="button" to="/targets">
          <Target size={15} />
          Sales targets
        </Link>
        {admin && (
          <button
            className="button primary"
            onClick={() => {
              setMember(null);
              setError("");
              setOpen(true);
            }}
          >
            <Plus size={16} />
            Add member
          </button>
        )}
      </PageTitle>
      <Section
        title="Workspace members"
        description={`${members.filter((m) => m.active).length} active members in ${org!.name}. Inactive accounts keep their history and do not use a seat.`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Team member</th>
                <th>Role</th>
                <th>Closed-won · this month</th>
                <th>Personal target</th>
                <th>Achievement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const performance = summary.data?.reps?.find(
                  (r: any) => r.user_id === m.user_id,
                );
                return (
                  <tr key={m.id}>
                    <td>
                      <div className="record-title-link">
                        <span className="avatar">
                          {initials(m.profiles.name)}
                        </span>
                        <span>
                          <strong>
                            {m.profiles.name}
                            {m.user_id === session!.user.id ? " (you)" : ""}
                            {!m.active ? " · Inactive" : ""}
                          </strong>
                          <small>{m.profiles.email}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <Badge value={m.role} />
                    </td>
                    <td>
                      <Link
                        className="table-relation"
                        to={`/deals?owner_id=${m.user_id}&outcome=won&since=${encodeURIComponent(reporting.start)}&until=${encodeURIComponent(reporting.end)}`}
                      >
                        {money(performance?.value || 0, org!.currency)}
                      </Link>
                    </td>
                    <td>{money(performance?.target || 0, org!.currency)}</td>
                    <td>
                      {percent(
                        performance?.value || 0,
                        performance?.target || 0,
                      )}
                    </td>
                    <td>
                      {admin && (
                        <button
                          className="button small"
                          disabled={busy}
                          onClick={async () => {
                            if (
                              !m.active ||
                              window.confirm(
                                `Deactivate ${m.profiles.name}? They will lose workspace access. Their records and login account will be kept.`,
                              )
                            ) {
                              setBusy(true);
                              const { error } = await supabase.rpc(
                                "set_member_active",
                                {
                                  o: org!.id,
                                  member_id: m.id,
                                  enabled: !m.active,
                                },
                              );
                              setBusy(false);
                              if (error) toast.error(error.message);
                              else {
                                await refresh();
                                toast.success(
                                  m.active
                                    ? "Member deactivated"
                                    : "Member activated",
                                );
                              }
                            }
                          }}
                        >
                          {m.active ? "Deactivate" : "Activate"}
                        </button>
                      )}
                      {admin && (
                        <button
                          className="button small"
                          onClick={() => {
                            setMember({
                              email: m.profiles.email,
                              role: m.role,
                            });
                            setError("");
                            setOpen(true);
                          }}
                        >
                          Change role
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <Section
        title="Clear responsibilities"
        description="Roles are enforced by database policies."
      >
        <div className="role-grid">
          {[
            [
              "Administrator",
              "Manage workspace settings, membership, all records, and sales targets.",
            ],
            [
              "Sales Manager",
              "Manage all sales records and targets; cannot change membership or workspace configuration.",
            ],
            [
              "Sales Representative",
              "View the shared workspace; create and update assigned records. Cannot delete records or manage targets.",
            ],
          ].map(([name, description]) => (
            <div key={name}>
              <ShieldCheck size={20} />
              <h3>{name}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
      </Section>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={member ? "Change member role" : "Add a workspace member"}
        description="Add someone who already has an account in this CRM. No invitation email is sent."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            const { error } = await supabase.rpc("manage_member", {
              o: org!.id,
              email_address: f.get("email"),
              member_role: f.get("role"),
            });
            setBusy(false);
            if (error) setError(error.message);
            else {
              await refresh();
              setOpen(false);
              toast.success(member ? "Role updated" : "Member added");
            }
          }}
        >
          <div className="form-grid">
            <label className="span-2">
              Account email
              <input
                type="email"
                name="email"
                required
                defaultValue={member?.email || ""}
                readOnly={!!member}
              />
            </label>
            <label className="span-2">
              Role
              <select
                name="role"
                defaultValue={member?.role || "Sales Representative"}
              >
                {["Sales Representative", "Sales Manager", "Administrator"].map(
                  (r) => (
                    <option key={r}>{r}</option>
                  ),
                )}
              </select>
            </label>
          </div>
          <div className="notice">
            The person must sign up first. After being added, they can switch to
            this workspace in Settings.
          </div>
          {error && <ErrorMessage error={error} />}
          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button disabled={busy} className="button primary">
              {busy ? "Saving…" : member ? "Save role" : "Add member"}
            </button>
          </div>
        </form>
      </Modal>
      {!members.length && (
        <Empty
          title="No team members loaded"
          description="Refresh the page to retry loading your team."
        />
      )}
    </>
  );
}
