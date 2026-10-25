export type Entity = Record<string, any>;
export type Plan = {
  code: string;
  name: string;
  monthly_price: number;
  currency: string;
};

export async function hmac(secret: string, message: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function validSignature(
  secret: string,
  body: string,
  supplied: string | null,
) {
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = await hmac(secret, body);
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return difference === 0;
}
export function validateProviderPlan(provider: Entity, local: Plan) {
  if (
    provider.period !== "monthly" ||
    provider.interval !== 1 ||
    provider.item?.amount !== local.monthly_price ||
    provider.item?.currency !== "INR"
  )
    throw new Error(
      `Razorpay ${local.name} plan must be monthly, INR ${local.monthly_price / 100}.`,
    );
}
export function verifiedReceipt(
  subscription: Entity,
  invoice: Entity,
  payment: Entity,
  local: Plan,
) {
  const start = invoice.billing_start,
    end = invoice.billing_end;
  if (
    invoice.subscription_id !== subscription.id ||
    invoice.status !== "paid" ||
    invoice.amount_due !== 0 ||
    invoice.payment_id !== payment.id ||
    payment.invoice_id !== invoice.id ||
    payment.status !== "captured" ||
    invoice.currency !== "INR" ||
    payment.currency !== "INR" ||
    invoice.amount_paid !== local.monthly_price ||
    payment.amount !== invoice.amount_paid ||
    subscription.quantity !== 1 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(invoice.paid_at) ||
    end <= start ||
    start > Date.now() / 1000 + 60
  )
    throw new Error(
      "No verified full subscription payment for this billing period. Authorization alone does not activate a paid plan.",
    );
  return {
    payment_id: payment.id,
    invoice_id: invoice.id,
    plan_code: local.code,
    amount: invoice.amount_paid,
    currency: "INR",
    period_start: new Date(start * 1000).toISOString(),
    period_end: new Date(end * 1000).toISOString(),
    paid_at: new Date(invoice.paid_at * 1000).toISOString(),
    invoice_url:
      typeof invoice.short_url === "string" &&
      /^https:\/\/rzp\.io\//.test(invoice.short_url)
        ? invoice.short_url
        : null,
  };
}
export function subscriptionFromEvent(event: Entity): string | null {
  return (
    event.payload?.subscription?.entity?.id ||
    event.payload?.invoice?.entity?.subscription_id ||
    null
  );
}
