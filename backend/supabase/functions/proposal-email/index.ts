import { createProposalHandler } from "./handler.ts";
Deno.serve(createProposalHandler((key) => Deno.env.get(key) || ""));
