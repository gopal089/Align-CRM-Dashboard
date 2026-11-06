import { createNotificationsHandler } from "./handler.ts";
Deno.serve(createNotificationsHandler((key) => Deno.env.get(key) || ""));
