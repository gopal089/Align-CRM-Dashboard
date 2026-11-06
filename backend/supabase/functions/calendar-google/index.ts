import { createCalendarHandler } from "./handler.ts";
Deno.serve(createCalendarHandler((key) => Deno.env.get(key) || ""));
