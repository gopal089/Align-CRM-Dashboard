import { describe, it, expect } from "vitest";
import {
  hmac,
  validSignature,
  validateProviderPlan,
  verifiedReceipt,
  subscriptionFromEvent,
} from "../supabase/functions/crm-billing/core";
const plan = {
  code: "starter",
  name: "Starter",
  monthly_price: 199900,
  currency: "INR",
};
const sub = { id: "sub_align", quantity: 1 };
const invoice = {
  id: "inv_align",
  subscription_id: sub.id,
  status: "paid",
  amount_due: 0,
  payment_id: "pay_align",
  currency: "INR",
  amount_paid: 199900,
  paid_at: Math.floor(Date.now() / 1000),
  billing_start: Math.floor(Date.now() / 1000) - 3600,
  billing_end: Math.floor(Date.now() / 1000) + 86400,
};
const payment = {
  id: "pay_align",
  invoice_id: invoice.id,
  status: "captured",
  currency: "INR",
  amount: 199900,
};
describe("Razorpay payment and webhook verification", () => {
  it("verifies the exact raw webhook body with a constant-length HMAC", async () => {
    const body = '{"event":"subscription.charged"}',
      signature = await hmac("test-secret", body);
    expect(await validSignature("test-secret", body, signature)).toBe(true);
    expect(await validSignature("test-secret", body + " ", signature)).toBe(
      false,
    );
    expect(await validSignature("different-secret", body, signature)).toBe(
      false,
    );
    expect(await validSignature("test-secret", body, null)).toBe(false);
  });
  it("binds checkout signatures to payment and subscription IDs", async () => {
    const signature = await hmac("test-secret", "pay_align|sub_align");
    expect(
      await validSignature("test-secret", "pay_align|sub_other", signature),
    ).toBe(false);
    expect(
      await validSignature("test-secret", "pay_other|sub_align", signature),
    ).toBe(false);
  });
  it("requires the approved price, currency and monthly interval", () => {
    expect(() =>
      validateProviderPlan(
        {
          period: "monthly",
          interval: 1,
          item: { amount: 199900, currency: "INR" },
        },
        plan,
      ),
    ).not.toThrow();
    for (const p of [
      {
        period: "yearly",
        interval: 1,
        item: { amount: 199900, currency: "INR" },
      },
      {
        period: "monthly",
        interval: 1,
        item: { amount: 99900, currency: "INR" },
      },
      {
        period: "monthly",
        interval: 1,
        item: { amount: 199900, currency: "USD" },
      },
    ])
      expect(() => validateProviderPlan(p, plan)).toThrow();
  });
  it("accepts only a captured payment linked to the paid invoice and subscription", () => {
    const receipt = verifiedReceipt(sub, invoice, payment, plan);
    expect(receipt).toMatchObject({
      payment_id: payment.id,
      invoice_id: invoice.id,
      plan_code: "starter",
      amount: 199900,
    });
    expect(new Date(receipt.period_end).getTime()).toBe(
      invoice.billing_end * 1000,
    );
  });
  it("rejects authorization-only, nominal, unpaid and cross-subscription payments", () => {
    expect(() =>
      verifiedReceipt(sub, invoice, { ...payment, status: "authorized" }, plan),
    ).toThrow();
    expect(() =>
      verifiedReceipt(
        sub,
        { ...invoice, amount_paid: 100 },
        { ...payment, amount: 100 },
        plan,
      ),
    ).toThrow();
    expect(() =>
      verifiedReceipt(sub, { ...invoice, status: "issued" }, payment, plan),
    ).toThrow();
    expect(() =>
      verifiedReceipt(
        sub,
        { ...invoice, subscription_id: "sub_other" },
        payment,
        plan,
      ),
    ).toThrow();
    expect(() =>
      verifiedReceipt(
        sub,
        invoice,
        { ...payment, invoice_id: "inv_other" },
        plan,
      ),
    ).toThrow();
  });
  it("rejects missing, inverted and future paid periods", () => {
    for (const dates of [
      { billing_start: null },
      { billing_end: invoice.billing_start },
      { billing_start: Date.now() / 1000 + 99999 },
    ])
      expect(() =>
        verifiedReceipt(sub, { ...invoice, ...dates }, payment, plan),
      ).toThrow();
  });
  it("extracts a subscription only from supported signed event payloads", () => {
    expect(
      subscriptionFromEvent({
        payload: { subscription: { entity: { id: sub.id } } },
      }),
    ).toBe(sub.id);
    expect(
      subscriptionFromEvent({
        payload: { invoice: { entity: { subscription_id: sub.id } } },
      }),
    ).toBe(sub.id);
    expect(subscriptionFromEvent({ org_id: "forged" })).toBe(null);
  });
});
