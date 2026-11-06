// Pure helpers for Google Calendar. No network calls here.

export const SCOPE_EVENTS = "https://www.googleapis.com/auth/calendar.events";

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function authUrl(p: { clientId: string; redirectUri: string; state: string }) {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: `openid email ${SCOPE_EVENTS}`,
    // "offline" + "consent" makes Google return a refresh token every time.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: p.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

// The ID token comes straight from Google's token endpoint over HTTPS, so its
// payload can be read without re-verifying the signature.
export function emailFromIdToken(idToken: string | undefined): string {
  try {
    const raw = (idToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return String(JSON.parse(atob(padded)).email || "");
  } catch {
    return "";
  }
}

export type PlannedTask = {
  task: string;
  event_id: string;
  name: string;
  due: string;
  priority: string;
  description: string | null;
  fingerprint: string;
};

const nextDay = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// An all-day, "free" event, tagged so Align never imports it back.
export function taskEvent(t: PlannedTask, appUrl: string, org: string) {
  const link = appUrl ? `${appUrl}/tasks/${t.task}` : "";
  return {
    id: t.event_id,
    summary: t.name,
    description: [
      `Align task · ${org} · ${t.priority} priority`,
      t.description || "",
      link ? `Open in Align: ${link}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    start: { date: t.due.slice(0, 10) },
    end: { date: nextDay(t.due) },
    transparency: "transparent",
    status: "confirmed",
    extendedProperties: { private: { alignTask: t.task } },
    ...(link ? { source: { title: "Align", url: link } } : {}),
  };
}

// Only what Align needs from a Google event: timed meetings and their guests.
export function simplifyEvent(e: any) {
  return {
    id: String(e?.id || ""),
    status: e?.status === "cancelled" ? "cancelled" : "confirmed",
    summary: typeof e?.summary === "string" ? e.summary.slice(0, 300) : "",
    description: typeof e?.description === "string" ? e.description.slice(0, 3000) : "",
    start: typeof e?.start?.dateTime === "string" ? e.start.dateTime : null,
    guests: [
      ...(Array.isArray(e?.attendees) ? e.attendees.map((a: any) => a?.email) : []),
      e?.organizer?.email,
    ].filter((x): x is string => typeof x === "string" && x.includes("@")),
    align: !!e?.extendedProperties?.private?.alignTask,
  };
}

export function appUrl(explicit: string, allowedOrigins: string): string {
  const pick = (v: string) => {
    try {
      const u = new URL(v.trim());
      return u.protocol === "https:" ? u.origin : "";
    } catch {
      return "";
    }
  };
  return pick(explicit) || allowedOrigins.split(",").map(pick).find(Boolean) || "";
}
