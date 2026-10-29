import { createSecurityHandler } from "./handler.ts";
Deno.serve(createSecurityHandler((key) => Deno.env.get(key) || ""));
