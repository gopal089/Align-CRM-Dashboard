import { supabase } from "./client";

export type CalendarStatus = {
  feed: { created_at: string; last_used_at: string | null } | null;
  google: {
    email: string;
    status: "active" | "reconnect";
    last_error: string | null;
    last_synced_at: string | null;
    connected_at: string;
  } | null;
};

// The subscribe link points straight at the calendar-feed server function.
export function feedUrl(token: string, base = import.meta.env.VITE_SUPABASE_URL || "") {
  return `${String(base).replace(/\/$/, "")}/functions/v1/calendar-feed?token=${token}`;
}

// Messages for the ?google=... result Google's redirect brings back.
export const googleOutcome: Record<string, { ok: boolean; message: string }> = {
  connected: { ok: true, message: "Google Calendar connected. Your tasks are on their way to your calendar." },
  denied: { ok: false, message: "Google Calendar was not connected because access was declined." },
  missing_permission: {
    ok: false,
    message: "Google Calendar needs permission to manage events. Connect again and keep the calendar box ticked.",
  },
  failed: { ok: false, message: "Google Calendar could not be connected. Try again." },
};

export async function calendarRequest<T = any>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("calendar-google", { body: { action, ...payload } });
  if (error) {
    const details = await error.context?.json?.().catch(() => null);
    throw new Error(details?.error || "The calendar service is unavailable. Try again.");
  }
  return data as T;
}
