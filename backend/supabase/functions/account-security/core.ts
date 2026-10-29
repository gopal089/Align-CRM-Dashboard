export const IDLE_MS = 30 * 60 * 1000;
export function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error("Invalid input");
  return value;
}
export function uuid(value: unknown): string {
  const s = text(value, 36);
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(s))
    throw new Error("Invalid session");
  return s;
}
export function normalCode(value: unknown): string {
  const code = text(value, 64).replace(/[\s-]/g, "").toUpperCase();
  if (!/^\d{6}$/.test(code) && !/^[A-F0-9]{32}$/.test(code))
    throw new Error("Enter a six-digit code or a backup code");
  return code;
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
export async function backupCodes(user: string) {
  const codes = Array.from({ length: 10 }, () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    )
      .join("")
      .toUpperCase()
      .match(/.{4}/g)!
      .join("-"),
  );
  return {
    codes,
    hashes: await Promise.all(
      codes.map((c) => digest(user + ":" + normalCode(c))),
    ),
  };
}
// Decode only AFTER Auth.getUser has verified the access token.
export function sessionId(jwt: string): string {
  const raw = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return uuid(JSON.parse(atob(raw)).session_id);
}
