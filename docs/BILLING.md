# Align subscriptions

## Approved monthly plans

| Limit | Free | Starter ₹1,999 | Business ₹4,999 |
| --- | ---: | ---: | ---: |
| Active members | 3 | 10 | 50 |
| Contacts | 100 | 5,000 | 50,000 |
| Leads | 200 | 10,000 | 100,000 |
| Companies | 50 | 2,000 | 20,000 |
| Active deals | 50 | 2,000 | Unlimited |
| Pitch templates | 3 | 25 | Unlimited |

Archived customer records and templates still count. Deals count only while open and unarchived. Deactivating a membership frees a seat without deleting the person's login or history. The last active administrator cannot be deactivated or demoted.

## Expiry and retention

- A dashboard warning begins seven days before expiry. Paid access ends at the exact verified paid-until timestamp; there is no continued paid-access grace period.
- Excess contacts, leads, and companies become view-only for seven days. Editing, deleting, or using the application's export controls returns `Just upgrade your plan to edit or export.` Records within the new quota remain usable.
- The oldest customer entries are kept. The newest excess entries are deleted after seven days (LIFO), with an immutable identity sequence resolving timestamp ties. An upgrade that covers the data before the deadline restores access.
- Deals, pitches, tasks, activities, histories, payment records, and login accounts are retained. Customer references are detached where necessary. Members and templates over quota are restricted without automatic deletion.
- Cancellation stops renewal at the paid period's end; it does not issue a refund. Paid-to-paid plan changes are scheduled for the next cycle, without automatic midcycle proration. Razorpay may reject a change for some payment methods; the actual error is displayed.
- The five-minute worker checks up to 25 subscriptions per run. Permanent cleanup requires a successful provider reconciliation within the previous ten minutes. Provider failures postpone physical deletion; expired excess records are hidden at the exact deadline, including their retained-record previews.

Application export controls are enforced before fetching an export. A module export is blocked if that category has retained data; workspace, report, and proposal exports are conservatively blocked if any customer category has retained data. Because records are readable during the seven-day window, a person can still manually copy what they can view. Browser-readable data cannot be made impossible to copy.

## Server deployment

1. Apply all SQL files in `database/supabase/migrations` in filename order. Never replace an already-applied migration. Use `npx supabase --workdir database ...` for database CLI commands.
2. Deploy `backend/supabase/functions/crm-billing/index.ts` and `core.ts` as `crm-billing`. Use `npx supabase --workdir backend ...` for Edge Function CLI commands. Disable the legacy gateway JWT check, as specified in `backend/supabase/config.toml`: the handler validates user JWTs with Auth, active administrator membership, webhook HMAC signatures, or the private maintenance credential itself. Anonymous billing actions are rejected.
3. Run `database/supabase/setup-billing-cron.sql` once as database owner. It stores a randomly generated maintenance credential in Supabase Vault and schedules the worker. The URL in this file is specific to the CRM project `pojrnwxvudxgmdrgqfhg`.
4. Enter the following secrets directly into Supabase Edge Functions → Secrets. Never commit them, put them in Vite variables, or paste them into chat.

| Secret | Value |
| --- | --- |
| `RAZORPAY_MODE` | `test` initially; `live` only after acceptance testing |
| `RAZORPAY_KEY_ID` | Corresponding `rzp_test_…` / `rzp_live_…` key ID |
| `RAZORPAY_KEY_SECRET` | Corresponding server API secret |
| `RAZORPAY_STARTER_PLAN_ID` | Separate Align Starter monthly plan ID |
| `RAZORPAY_BUSINESS_PLAN_ID` | Separate Align Business monthly plan ID |
| `RAZORPAY_WEBHOOK_SECRET` | The secret entered for Align's webhook |
| `RAZORPAY_TEST_ORG_IDS` | Comma-separated UUIDs of approved test workspaces; test checkout is blocked for all others |
| `BILLING_ALLOWED_ORIGINS` | Optional comma-separated frontend origins; defaults to the Render site and `http://127.0.0.1:5173` |

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the server runtime. These must never reach the frontend.

## Razorpay setup

An existing merchant account can have separate Align plans and a separate webhook. Do not regenerate keys used by another project. Sign in to the intended account and select Test Mode first.

Align test plans created on 2026-10-24 (these IDs are configuration identifiers, not secret keys):

| Plan | Test Plan ID | Monthly price |
| --- | --- | ---: |
| Align CRM Starter | `plan_TripP3Eyzvptif` | ₹1,999 |
| Align CRM Business | `plan_Triq9SQtqvjB6q` | ₹4,999 |

Test/Live is selected for the merchant account's dashboard session; choosing Test Mode does not disable an existing project's live payments.

1. Create an Align Starter monthly plan for INR 199900 paise and an Align Business monthly plan for INR 499900 paise. Each interval is one month.
2. Create a webhook for `https://pojrnwxvudxgmdrgqfhg.supabase.co/functions/v1/crm-billing/webhook`. Enter its signing secret yourself. Select offered subscription events (`authenticated`, `activated`, `charged`, `pending`, `halted`, `cancelled`, `completed`, `updated`) and `invoice.paid` where available.
3. Enter the matching test credentials, plan IDs, webhook secret, and approved test workspace IDs into Supabase secrets.
4. In Settings → Plans & billing, use an approved test workspace to complete checkout and verify delivery in Razorpay's webhook log. Use Razorpay's test payment flow; no real charge is required.
5. Verify renewal, cancellation, next-cycle plan changes, duplicate/delayed webhooks, failed renewal, expiry, retained edit/export blocking, upgrade restoration, and newest-first cleanup in a dedicated test workspace. Time-boundary tests also run locally against isolated Postgres fixtures.
6. Before going live, create corresponding live plans/webhook, switch the server secrets to the matching live credentials and IDs, and complete the provider's activation requirements. Test receipts must not be migrated into production entitlements. Existing test subscriptions require reconciliation/cleanup before changing provider modes.

Checkout success alone never grants paid access. The server verifies HMAC signatures, subscription ownership, the canonical monthly plan/price, a fully paid subscription invoice, captured payment, and invoice billing period. Nominal authentication charges do not unlock a plan. Duplicate or older receipts cannot extend expiry. The handler fetches current provider state instead of trusting webhook payload claims.

If checkout creation has an ambiguous network failure, the database retains its reservation to prevent duplicate subscriptions. An operator must check Razorpay before clearing that reservation. An unpaid subscription for a different plan must be cancelled before starting another.

## Platform revenue visibility

Workspace administrators see their own usage and receipts. Global subscription revenue is restricted to IDs explicitly inserted by a database operator into `private.platform_billing_admins`; signing up or creating a workspace never grants this permission. Verify the intended owner's Auth UUID before inserting it. The report shows current paid subscription count/MRR, collected verified payments by UTC month, scheduled cancellations, and failed renewals. No time-limited trials are enabled.

## Verification

Run `npm test` for isolated Postgres/RLS/quota/retention tests and Razorpay signature/receipt checks, `npm run build` for TypeScript and production assets, and `deno check backend/supabase/functions/crm-billing/index.ts` for the server handler. Local tests do not prove real Razorpay webhook delivery or payment success. Until test credentials and webhook setup are complete, the billing page deliberately disables checkout and reports setup as incomplete.
