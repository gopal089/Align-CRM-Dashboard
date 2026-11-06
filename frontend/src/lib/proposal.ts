import { supabase } from "./client";

// The snapshot stored when a proposal is emailed. The client's page renders
// exactly this, so later edits to the pitch never change what was sent.
export type ProposalContent = {
  org: { name: string; website: string; currency: string; timezone: string };
  pitch: {
    name: string;
    objective: string;
    problem: string;
    solution: string;
    scope: string;
    pricing: string;
    amount: number;
    terms: string;
    created_at: string;
  };
  sections: { title: string; content: string }[];
  customer: string;
  sender: string;
};

export type OpenedProposal = {
  content: ProposalContent;
  to_name: string;
  sent_at: string;
  expires_at: string;
  reply_to: string | null;
  internal: boolean;
};

export const proposalFields = [
  "objective",
  "problem",
  "solution",
  "scope",
  "pricing",
] as const;

// Templates may contain {{customer}}, {{solution}}, {{pricing}} and {{terms}}.
export function placeholderFiller(
  content: ProposalContent,
  formatMoney: (amount: number, currency: string) => string,
) {
  const values: Record<string, string> = {
    customer: content.customer || "[Customer name]",
    solution: content.pitch.solution || "",
    pricing:
      content.pitch.pricing ||
      formatMoney(Number(content.pitch.amount) || 0, content.org.currency),
    terms: content.pitch.terms || "",
  };
  return (text: string) =>
    String(text || "").replace(
      /\{\{(customer|solution|pricing|terms)\}\}/g,
      (_, key: string) => values[key],
    );
}

export type SendRow = {
  status: string;
  revoked_at: string | null;
  expires_at: string;
  view_count: number;
};

// One label for the history list, in the order a sender cares about.
export function sendState(row: SendRow, now = Date.now()) {
  if (row.status === "failed") return "Failed";
  if (row.status === "sending") return "Sending";
  if (row.revoked_at) return "Withdrawn";
  if (new Date(row.expires_at).getTime() <= now) return "Expired";
  return row.view_count > 0 ? "Opened" : "Not opened yet";
}

export class ProposalError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function proposalRequest<T = any>(
  action: "send" | "revoke" | "open",
  payload: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("proposal-email", {
    body: { action, ...payload },
  });
  if (error) {
    const details = await error.context?.json?.().catch(() => null);
    throw new ProposalError(
      details?.error || "The proposal service is unavailable. Try again.",
      error.context?.status,
    );
  }
  return data as T;
}
