import { useQuery } from "@tanstack/react-query";
import { supabase } from "./client";
import { useAuth } from "./auth";

export const retentionMessage = "Just upgrade your plan to edit or export.";
export type BillingPlan = {
  code: "free" | "starter" | "business";
  name: string;
  monthly_price: number;
  currency: string;
  limits: Record<string, number | null>;
};
export type BillingStatus = {
  plan: BillingPlan;
  paid_plan: string;
  paid_until: string | null;
  status: string;
  cancel_at_period_end: boolean;
  scheduled_plan: string | null;
  scheduled_change_at: string | null;
  usage: Record<string, { used: number; limit: number | null; excess: number }>;
  retention_deadline: string | null;
  server_time: string;
  renewal_warning: boolean;
};
export const usageLabels: Record<string, string> = {
  memberships: "Active team members",
  contacts: "Contacts",
  leads: "Leads",
  companies: "Companies",
  deals: "Active deals",
  pitch_templates: "Pitch templates",
};
export function useBilling() {
  const { org } = useAuth();
  return useQuery({
    queryKey: ["billing", org?.id],
    enabled: !!org,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("billing_status", {
        o: org!.id,
      });
      if (error) throw error;
      return data as BillingStatus;
    },
  });
}
export function useRecordPermissions(kind: string, ids: string[]) {
  const { org } = useAuth();
  return useQuery({
    queryKey: ["billing-permissions", org?.id, kind, ids.join(",")],
    enabled:
      !!org &&
      ids.length > 0 &&
      ["contacts", "leads", "companies"].includes(kind),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("billing_record_permissions", {
        o: org!.id,
        kind,
        ids,
      });
      if (error) throw error;
      return data as Record<
        string,
        { preserved: boolean; delete_at: string | null }
      >;
    },
  });
}
export async function assertExportAllowed(org: string, kind = "workspace") {
  const { error } = await supabase.rpc("billing_assert_export", {
    o: org,
    kind,
  });
  if (error) throw new Error(error.message);
}
export async function billingRequest(
  action: string,
  org: string,
  extra: Record<string, unknown> = {},
) {
  const { data, error } = await supabase.functions.invoke("crm-billing", {
    body: { action, org_id: org, ...extra },
  });
  if (error) {
    let message =
      "Billing is unavailable. Ask your administrator to finish Razorpay setup.";
    try {
      const body = await error.context?.json();
      if (body?.error) message = body.error;
    } catch {
      /* A gateway/network error has no JSON body. */
    }
    throw new Error(message);
  }
  return data;
}

type CheckoutResponse = {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
};
type RazorpayCheckout = new (options: Record<string, unknown>) => {
  open: () => void;
  on: (event: string, fn: (data: unknown) => void) => void;
};
declare global {
  interface Window {
    Razorpay?: RazorpayCheckout;
  }
}
let checkoutScript: Promise<void> | null = null;
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (!checkoutScript)
    checkoutScript = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        checkoutScript = null;
        script.remove();
        reject(
          new Error("Razorpay Checkout could not load. Please try again."),
        );
      };
      document.head.appendChild(script);
    });
  return checkoutScript;
}
export async function openCheckout(org: string, plan: string, email: string) {
  await loadRazorpay();
  const checkout = await billingRequest("checkout", org, { plan });
  return new Promise<void>((resolve, reject) => {
    const instance = new window.Razorpay!({
      key: checkout.key_id,
      subscription_id: checkout.subscription_id,
      name: "Align CRM",
      description: `${checkout.plan_name} monthly subscription`,
      prefill: { email },
      theme: { color: "#5b50c9" },
      handler: async (response: CheckoutResponse) => {
        try {
          await billingRequest("verify", org, response);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      modal: {
        ondismiss: () =>
          reject(
            new Error(
              "Checkout closed. Your subscription has not been changed.",
            ),
          ),
      },
    });
    instance.on("payment.failed", () =>
      reject(
        new Error(
          "Payment failed. Paid limits unlock only after verified payment.",
        ),
      ),
    );
    instance.open();
  });
}
