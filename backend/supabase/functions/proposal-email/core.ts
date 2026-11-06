// Pure helpers for proposal emails. Kept free of I/O so they can be unit tested.
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid input");
  return value;
}
export function optional(value: unknown, max: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid input");
  return value;
}

// 32 random bytes, URL-safe. Only its hash is stored, so a database leak does
// not reveal working links.
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

// Store only a rough device type, never the full browser string or IP.
export function deviceLabel(userAgent: string): string {
  if (!userAgent) return "Unknown";
  if (/ipad|tablet/i.test(userAgent)) return "Tablet";
  if (/mobi|iphone|android/i.test(userAgent)) return "Mobile";
  return "Desktop";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A display name goes inside an email header, so characters that could break
// out of the quoted name are removed.
export function displayName(name: string): string {
  const clean = name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60);
  return clean || "Align";
}

export function proposalEmail(p: {
  toName: string;
  message: string;
  link: string;
  sender: string;
  org: string;
  expiresAt: string;
}) {
  const greeting = p.toName.trim() ? `Hi ${p.toName.trim()},` : "Hello,";
  const expires = new Date(p.expiresAt).toUTCString().slice(0, 16);
  const from = [p.sender, p.org].filter(Boolean).join(", ");
  const paragraphs = p.message
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5fb;font-family:Arial,Helvetica,sans-serif;color:#2b2540">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 16px">${escapeHtml(greeting)}</p>
${paragraphs.map((x) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(x).replace(/\n/g, "<br>")}</p>`).join("\n")}
<p style="margin:24px 0"><a href="${escapeHtml(p.link)}" style="background:#5a4fcf;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">View proposal</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#6f6787;word-break:break-all">Or open this link: ${escapeHtml(p.link)}</p>
<p style="margin:0;font-size:13px;color:#6f6787">This private link works until ${escapeHtml(expires)}. Reply to this email to reach ${escapeHtml(from || "the sender")} directly.</p>
</div></body></html>`;
  const plain = [
    greeting,
    "",
    ...paragraphs.flatMap((x) => [x, ""]),
    `View proposal: ${p.link}`,
    "",
    `This private link works until ${expires}. Reply to this email to reach ${from || "the sender"} directly.`,
  ].join("\n");
  return { html, text: plain };
}
