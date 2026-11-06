// Builds an iCalendar (.ics) feed. Pure functions so the format is tested.

export const feedTokenPattern = /^[a-f0-9]{64}$/;

// Text values escape backslash, semicolon, comma and line breaks (RFC 5545).
export function icsText(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Lines longer than 75 bytes continue on the next line after a space,
// without splitting a multi-byte character.
export function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let current = "",
    size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75;
    if (size + n > limit) {
      out.push(current);
      current = ch;
      size = n;
    } else {
      current += ch;
      size += n;
    }
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (iso: string) => iso.slice(0, 10).replace(/-/g, "");
const nextDay = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};

export type FeedTask = {
  id: string;
  name: string;
  due: string;
  priority: string;
  description: string | null;
  updated_at: string;
};

export function buildFeed(p: {
  org: string;
  tasks: FeedTask[];
  appUrl: string;
  now?: Date;
}): string {
  const now = stamp(p.now || new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Align CRM//Tasks//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`Align tasks · ${p.org}`)}`,
    // A hint only; Google decides its own refresh schedule.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const t of p.tasks) {
    const link = p.appUrl ? `${p.appUrl}/tasks/${t.id}` : "";
    const details = [
      `Priority: ${t.priority}`,
      t.description || "",
      link ? `Open in Align: ${link}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@align-crm`,
      `DTSTAMP:${now}`,
      `LAST-MODIFIED:${stamp(new Date(t.updated_at))}`,
      `DTSTART;VALUE=DATE:${day(t.due)}`,
      `DTEND;VALUE=DATE:${nextDay(t.due)}`,
      `SUMMARY:${icsText(t.name)}`,
      `DESCRIPTION:${icsText(details)}`,
      ...(link ? [`URL:${link}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
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

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
