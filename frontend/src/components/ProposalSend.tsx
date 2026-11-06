import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Mail } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import type { Row } from "../lib/model";
import { date } from "../lib/utils";
import { proposalRequest, sendState } from "../lib/proposal";
import { Badge, Confirm, ErrorMessage, Modal } from "./ui";

const closed = ["Accepted", "Rejected", "Expired"];

// "Send by email" on a pitch, plus the list of every time it was sent and
// whether the client has opened it.
export default function ProposalSend({
  pitch,
  canEdit,
}: {
  pitch: Row;
  canEdit: boolean;
}) {
  const { org, session, role, profile } = useAuth();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const manager = role === "Administrator" || role === "Sales Manager";
  const blocked = pitch.archived_at
    ? "Restore this proposal to send it."
    : closed.includes(pitch.status)
      ? "This proposal is closed. Duplicate it to send a new version."
      : "";

  // Pre-fill the recipient from the linked contact, or else the linked lead.
  const recipient = useQuery({
    queryKey: ["proposal-recipient", pitch.contact_id, pitch.lead_id],
    enabled: open && !!(pitch.contact_id || pitch.lead_id),
    queryFn: async () => {
      const table = pitch.contact_id ? "contacts" : "leads";
      const { data, error } = await supabase
        .from(table)
        .select("name,email")
        .eq("org_id", org!.id)
        .eq("id", pitch.contact_id || pitch.lead_id)
        .maybeSingle();
      if (error) throw error;
      return data as { name: string; email: string | null } | null;
    },
  });
  const sends = useQuery({
    queryKey: ["proposal-sends", pitch.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("proposal_sends")
        .select(
          "id,sent_by,recipient_email,recipient_name,subject,status,error,expires_at,revoked_at,view_count,first_viewed_at,last_viewed_at,created_at",
        )
        .eq("org_id", org!.id)
        .eq("pitch_id", pitch.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });

  async function send(form: FormData) {
    setBusy(true);
    setError("");
    try {
      await proposalRequest("send", {
        pitch_id: pitch.id,
        to_email: String(form.get("to_email") || "").trim(),
        to_name: String(form.get("to_name") || "").trim(),
        subject: String(form.get("subject") || "").trim(),
        message: String(form.get("message") || ""),
      });
      toast.success("Proposal emailed. You'll see here when it's opened.");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      // A failed attempt is recorded too, so refresh either way.
      await cache.invalidateQueries();
    }
  }

  const contact = recipient.data;
  return (
    <>
      <button
        className="button primary"
        disabled={!canEdit || !!blocked}
        title={blocked || undefined}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <Mail size={15} />
        Send by email
      </button>
      {sends.data && sends.data.length > 0 && (
        <div className="proposal-sends">
          <h3>Sent by email</h3>
          <ul>
            {sends.data.map((s: any) => {
              const state = sendState(s);
              const canWithdraw =
                s.status === "sent" &&
                !s.revoked_at &&
                state !== "Expired" &&
                (s.sent_by === session!.user.id || manager);
              return (
                <li key={s.id}>
                  <div>
                    <strong>{s.recipient_name || s.recipient_email}</strong>
                    <small>
                      {s.recipient_name ? `${s.recipient_email} · ` : ""}
                      Sent {date(s.created_at, org!.timezone, true)}
                    </small>
                    {s.status === "failed" && s.error && (
                      <small className="text-danger">{s.error}</small>
                    )}
                  </div>
                  <div className="proposal-send-state">
                    <Badge value={state} />
                    {s.view_count > 0 && (
                      <small>
                        Opened {s.view_count}{" "}
                        {s.view_count === 1 ? "time" : "times"} · last{" "}
                        {date(s.last_viewed_at, org!.timezone, true)}
                      </small>
                    )}
                    {canWithdraw && (
                      <button
                        className="button small"
                        onClick={() => setWithdrawing(s.id)}
                      >
                        <Ban size={13} />
                        Withdraw link
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {sends.error && (
        <ErrorMessage
          error={(sends.error as Error).message}
          retry={() => sends.refetch()}
        />
      )}
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Send proposal by email"
        description="The client gets a private link to this proposal. You'll see here each time they open it."
      >
        <form
          key={contact?.email || "blank"}
          onSubmit={(e) => {
            e.preventDefault();
            send(new FormData(e.currentTarget));
          }}
        >
          <div className="form-grid">
            <label>
              Client email
              <input
                name="to_email"
                type="email"
                required
                maxLength={254}
                defaultValue={contact?.email || ""}
              />
            </label>
            <label>
              Client name
              <input
                name="to_name"
                maxLength={200}
                defaultValue={contact?.name || ""}
              />
            </label>
            <label className="span-2">
              Subject
              <input
                name="subject"
                required
                maxLength={200}
                defaultValue={`Proposal: ${pitch.name}`}
              />
            </label>
            <label className="span-2">
              Message
              <textarea
                name="message"
                rows={6}
                maxLength={5000}
                defaultValue={`Please find our proposal for ${pitch.name} at the link below.\n\nHappy to answer any questions.\n\n${profile?.name || ""}`.trim()}
              />
            </label>
          </div>
          <p className="muted">
            Replies go to your account email. The link stays private and works
            for 30 days unless you withdraw it.
          </p>
          {error && <ErrorMessage error={error} />}
          <div className="form-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "Sending…" : "Send proposal"}
            </button>
          </div>
        </form>
      </Modal>
      <Confirm
        open={!!withdrawing}
        onClose={() => setWithdrawing(null)}
        title="Withdraw this link?"
        description="The client will see a notice that the proposal was withdrawn instead of the proposal. You can send a new link at any time."
        onConfirm={async () => {
          await proposalRequest("revoke", { send_id: withdrawing });
          await cache.invalidateQueries({ queryKey: ["proposal-sends"] });
          toast.success("Link withdrawn");
        }}
      />
    </>
  );
}
