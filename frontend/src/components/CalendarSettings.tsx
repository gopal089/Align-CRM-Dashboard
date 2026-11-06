import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Copy, Link2, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/client";
import { date } from "../lib/utils";
import { calendarRequest, feedUrl, googleOutcome, type CalendarStatus } from "../lib/calendar";
import { Badge, Confirm, ErrorMessage, Loading, Section } from "./ui";

// Settings → Calendar. Everything here is per person: your own calendar and
// your own tasks in this workspace.
export default function CalendarSettings() {
  const { org } = useAuth();
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState("");
  const [link, setLink] = useState("");
  const [confirm, setConfirm] = useState<"disconnect" | "regenerate" | null>(null);
  const status = useQuery({
    queryKey: ["calendar-status", org!.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("calendar_status", { o: org!.id });
      if (error) throw error;
      return data as CalendarStatus;
    },
  });
  // Google sends people back here with ?google=connected (or a reason).
  useEffect(() => {
    const outcome = googleOutcome[params.get("google") || ""];
    if (!outcome) return;
    (outcome.ok ? toast.success : toast.error)(outcome.message);
    setParams({ tab: "calendar" }, { replace: true });
  }, []);
  const refresh = () => cache.invalidateQueries({ queryKey: ["calendar-status", org!.id] });

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
      await refresh();
    }
  }
  const newLink = () =>
    run("feed", async () => {
      const { data, error } = await supabase.rpc("calendar_new_feed", { o: org!.id });
      if (error) throw error;
      setLink(feedUrl(data as string));
    });

  if (status.isLoading) return <Loading />;
  if (status.error)
    return <ErrorMessage error={(status.error as Error).message} retry={() => status.refetch()} />;
  const google = status.data?.google;
  const feed = status.data?.feed;
  return (
    <>
      <Section
        title="Google Calendar"
        description="Your open tasks with due dates appear as all-day events in your Google Calendar. Meetings in that calendar with a lead or contact as a guest are added to Align as activities. Personal events are never brought in."
      >
        {google ? (
          <div className="calendar-card">
            <div>
              <strong>{google.email || "Google account"}</strong>
              <small>
                {google.status === "reconnect"
                  ? google.last_error
                  : google.last_synced_at
                    ? `Last synced ${date(google.last_synced_at, org!.timezone, true)}`
                    : "Waiting for the first sync"}
              </small>
              {google.status === "active" && google.last_error && (
                <small className="text-danger">{google.last_error}</small>
              )}
            </div>
            <Badge value={google.status === "active" ? "Connected" : "Reconnect needed"} />
            <div className="calendar-actions">
              {google.status === "reconnect" ? (
                <button className="button primary" disabled={!!busy} onClick={() => run("connect", connect)}>
                  <CalendarDays size={15} />
                  Reconnect
                </button>
              ) : (
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    run("sync", async () => {
                      const r = await calendarRequest("sync_now", { org_id: org!.id });
                      if (r.error) throw new Error(r.error === "reconnect" ? "Google access ended. Reconnect." : r.error);
                      toast.success(`Synced: ${r.pushed} task events updated, ${r.removed} removed, ${r.imported} meetings added.`);
                    })
                  }
                >
                  <RefreshCw size={15} className={busy === "sync" ? "spin" : ""} />
                  Sync now
                </button>
              )}
              <button className="button" disabled={!!busy} onClick={() => setConfirm("disconnect")}>
                <Unplug size={15} />
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <button className="button primary" disabled={!!busy} onClick={() => run("connect", connect)}>
            <CalendarDays size={15} />
            {busy === "connect" ? "Opening Google…" : "Connect Google Calendar"}
          </button>
        )}
        <p className="fine-print">
          Syncs about every 10 minutes. Only tasks you own are sent, and Align
          only reads meetings to match their guests against your leads and
          contacts.
        </p>
      </Section>
      <Section
        title="Subscribe link"
        description="For Apple Calendar, Outlook or any calendar app. Shows your open tasks; it cannot change Align."
      >
        {link ? (
          <div className="calendar-link">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Your private calendar link" />
            <button
              className="button"
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                toast.success("Link copied");
              }}
            >
              <Copy size={15} />
              Copy
            </button>
          </div>
        ) : null}
        {link ? (
          <p className="fine-print">
            Copy it now: for your safety Align shows it only once. Google
            Calendar: Other calendars → + → From URL. Apple Calendar: File → New
            Calendar Subscription. Google refreshes subscribed calendars only
            every few hours; use the connection above for faster updates.
          </p>
        ) : (
          <div className="calendar-actions">
            <button
              className="button"
              disabled={!!busy}
              onClick={() => (feed ? setConfirm("regenerate") : newLink())}
            >
              <Link2 size={15} />
              {feed ? "Create a new link" : "Create subscribe link"}
            </button>
            {feed && (
              <small className="muted">
                A link exists, created {date(feed.created_at, org!.timezone)}
                {feed.last_used_at ? `, last read ${date(feed.last_used_at, org!.timezone, true)}` : ", not used yet"}.
              </small>
            )}
          </div>
        )}
      </Section>
      <Confirm
        open={confirm === "disconnect"}
        onClose={() => setConfirm(null)}
        destructive
        title="Disconnect Google Calendar?"
        description="Align removes the task events it added to your calendar and stops syncing. Meetings already brought into Align stay."
        onConfirm={async () => {
          const r = await calendarRequest("disconnect", { org_id: org!.id });
          await refresh();
          toast.success(`Disconnected. ${r.removed} task events removed from your calendar.`);
        }}
      />
      <Confirm
        open={confirm === "regenerate"}
        onClose={() => setConfirm(null)}
        title="Create a new subscribe link?"
        description="The old link stops working straight away. Calendars using it will need the new one."
        onConfirm={newLink}
      />
    </>
  );

  async function connect() {
    const { url } = await calendarRequest<{ url: string }>("connect", { org_id: org!.id });
    window.location.assign(url);
  }
}
