// Pure helpers for Align's own emails (follow-up digests and plan reminders).
// No I/O here, so the wording and escaping can be unit tested.

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Links in emails point at the app. APP_URL wins; otherwise the first https
// origin the security function already trusts.
export function appUrl(explicit: string, allowedOrigins: string): string {
  const pick = (v: string) => {
    try {
      const u = new URL(v.trim());
      return u.protocol === "https:" ? u.origin : "";
    } catch {
      return "";
    }
  };
  return (
    pick(explicit) ||
    allowedOrigins
      .split(",")
      .map(pick)
      .find(Boolean) ||
    ""
  );
}

export function formatDate(iso: string, timeZone = "Asia/Kolkata") {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone,
    }).format(d);
  } catch {
    return d.toUTCString().slice(5, 16);
  }
}

const shell = (body: string) =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5fb;font-family:Arial,Helvetica,sans-serif;color:#2b2540">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">${body}</div></body></html>`;
const button = (href: string, label: string) =>
  href
    ? `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#5a4fcf;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${escapeHtml(label)}</a></p>`
    : "";

export type DigestItem = { task: string; name: string; kind: string };

export function digestEmail(p: {
  name: string;
  org: string;
  items: DigestItem[];
  url: string;
}) {
  const count = p.items.length;
  const subject = `${count} follow-up${count === 1 ? "" : "s"} for today · ${p.org}`;
  const hello = p.name ? `Hi ${p.name},` : "Hello,";
  const why = (kind: string) =>
    kind === "proposal"
      ? "Client opened the proposal but hasn’t replied"
      : "Nothing logged on this lead recently";
  const list = p.items
    .map((item) => {
      const link = p.url ? `${p.url}/tasks/${encodeURIComponent(item.task)}` : "";
      const title = link
        ? `<a href="${escapeHtml(link)}" style="color:#5a4fcf">${escapeHtml(item.name)}</a>`
        : escapeHtml(item.name);
      return `<li style="margin:0 0 10px">${title}<br><span style="font-size:13px;color:#6f6787">${escapeHtml(why(item.kind))}</span></li>`;
    })
    .join("");
  const html = shell(`<p style="margin:0 0 16px">${escapeHtml(hello)}</p>
<p style="margin:0 0 16px;line-height:1.5">Align added ${count === 1 ? "this follow-up" : "these follow-ups"} to your tasks in ${escapeHtml(p.org)} today:</p>
<ul style="margin:0 0 8px;padding-left:20px">${list}</ul>
${button(p.url ? `${p.url}/tasks` : "", "Open your tasks")}
<p style="margin:0;font-size:12px;color:#8d7ea7">You get this because task reminders are on in your Align profile. Turn them off under Settings → Your profile.</p>`);
  const text = [
    hello,
    "",
    `Align added ${count === 1 ? "this follow-up" : "these follow-ups"} to your tasks in ${p.org} today:`,
    "",
    ...p.items.map((item) => `- ${item.name} (${why(item.kind)})`),
    "",
    ...(p.url ? [`Open your tasks: ${p.url}/tasks`, ""] : []),
    "You get this because task reminders are on in your Align profile.",
  ].join("\n");
  return { subject, html, text };
}

export function planEndingEmail(p: {
  name: string;
  org: string;
  plan: string;
  paidUntil: string;
  timezone: string;
  cancelling: boolean;
  url: string;
}) {
  const when = formatDate(p.paidUntil, p.timezone);
  const subject = p.cancelling
    ? `Your ${p.plan} plan for ${p.org} ends on ${when}`
    : `Your ${p.plan} plan for ${p.org} renews on ${when}`;
  const hello = p.name ? `Hi ${p.name},` : "Hello,";
  // Same wording as the warning on the Billing page.
  const detail = p.cancelling
    ? `Cancellation is scheduled, so paid access to ${p.org} ends on ${when}. Data above the Free plan limits becomes view-only for seven days, then the newest excess records are removed unless you upgrade.`
    : `The current paid period for ${p.org} ends on ${when}. Renewal is charged automatically; paid access ends at that time unless the renewal payment is verified. There is no grace period.`;
  const html = shell(`<p style="margin:0 0 16px">${escapeHtml(hello)}</p>
<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(detail)}</p>
${button(p.url ? `${p.url}/settings?tab=billing` : "", "Review billing")}
<p style="margin:0;font-size:12px;color:#8d7ea7">You get this because you are an administrator of ${escapeHtml(p.org)}.</p>`);
  const text = [
    hello,
    "",
    detail,
    "",
    ...(p.url ? [`Review billing: ${p.url}/settings?tab=billing`, ""] : []),
    `You get this because you are an administrator of ${p.org}.`,
  ].join("\n");
  return { subject, html, text };
}
