import { createClient } from "@supabase/supabase-js";
import { appUrl, buildFeed, digest, feedTokenPattern } from "./core.ts";

// Calendar apps fetch this link on their own schedule, without signing in:
// the secret token in the link is the permission.
export function createFeedHandler(env: (key: string) => string) {
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const plain = (message: string, status: number) =>
    new Response(message, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "HEAD") return plain("Use GET", 405);
    try {
      const token = new URL(req.url).searchParams.get("token") || "";
      if (!feedTokenPattern.test(token)) return plain("This calendar link is not valid", 404);
      const hashed = await digest(token);
      const { data: allowed } = await admin.rpc("security_rate_limit", {
        b: "calendar-feed:" + hashed,
        max_attempts: 60,
      });
      if (allowed === false) return plain("Too many requests", 429);
      const { data, error } = await admin.rpc("calendar_feed", { link_hash: hashed });
      if (error) return plain("This calendar link is not valid", 404);
      const body = buildFeed({
        org: data.org,
        tasks: data.tasks || [],
        appUrl: appUrl(env("APP_URL"), env("SECURITY_ALLOWED_ORIGINS")),
      });
      return new Response(req.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="align-tasks.ics"',
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch {
      return plain("Calendar feed unavailable", 500);
    }
  };
}
