export function money(value: number | string = 0, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}
export function percent(n: number, d: number) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "0%";
}
export function date(
  value: string | undefined,
  timezone = "Asia/Kolkata",
  time = false,
) {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(d.valueOf())
    ? "—"
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        ...(value.length === 10 ? { timeZone: "UTC" } : { timeZone: timezone }),
        ...(time ? { hour: "numeric", minute: "2-digit" } : {}),
      }).format(d);
}
export function calendarDate(value: string, timezone = "Asia/Kolkata") {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}-${p.find((x) => x.type === "day")!.value}`;
}
// Convert a calendar date in the organization's zone into an exact UTC boundary.
export function zonedBoundary(day: string, zone: string) {
  const [y, m, d] = day.split("-").map(Number);
  const nominal = Date.UTC(y, m - 1, d);
  let result = nominal;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(result));
    const n = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    const represented = Date.UTC(
      n("year"),
      n("month") - 1,
      n("day"),
      n("hour"),
      n("minute"),
      n("second"),
    );
    result += nominal - represented;
  }
  return new Date(result).toISOString();
}
export function today(timezone = "Asia/Kolkata") {
  return calendarDate(new Date().toISOString(), timezone);
}
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function period(
  value: string,
  zone: string,
  from?: string,
  to?: string,
) {
  const now = today(zone);
  const [y, m] = now.split("-").map(Number);
  let a = now,
    b = now;
  switch (value) {
    case "7":
      a = addDays(now, -6);
      break;
    case "30":
      a = addDays(now, -29);
      break;
    case "month":
      a = `${y}-${String(m).padStart(2, "0")}-01`;
      break;
    case "lastMonth": {
      const d = new Date(Date.UTC(y, m - 2, 1));
      a = d.toISOString().slice(0, 10);
      b = addDays(`${y}-${String(m).padStart(2, "0")}-01`, -1);
      break;
    }
    case "quarter":
      a = `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
      break;
    case "year":
      a = `${y}-01-01`;
      break;
    case "all":
      a = "1970-01-01";
      break;
    case "custom":
      a = from || now;
      b = to || now;
      break;
  }
  return {
    from: a,
    to: b,
    start: zonedBoundary(a, zone),
    end: zonedBoundary(addDays(b, 1), zone),
  };
}
export function csv(
  rows: Record<string, unknown>[],
  columns: string[],
  filename: string,
) {
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return (
      '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
    );
  };
  const text = [
    columns.map(cell).join(","),
    ...rows.map((r) => columns.map((c) => cell(r[c])).join(",")),
  ].join("\r\n");
  const a = document.createElement("a");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }),
  );
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const cleanSearch = (s: string) =>
  s
    .replace(/[^\p{L}\p{N}\s@.+\-]/gu, "")
    .trim()
    .slice(0, 120);
export const initials = (name: string) =>
  name
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
