import { createFeedHandler } from "./handler.ts";
Deno.serve(createFeedHandler((key) => Deno.env.get(key) || ""));
