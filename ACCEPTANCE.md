# Verification status

Updated 2026-10-24. The application uses Supabase **CRM** (`pojrnwxvudxgmdrgqfhg`) in **gopal089's Org** and Render at https://align-crm-dashboard.onrender.com.

## Current local checks

- 52 automated tests pass across four files. They apply every migration in filename order to isolated PGlite PostgreSQL databases with application roles and a test Auth schema.
- Coverage includes workspace isolation, role restrictions, CRM relationships/conversion/history/payment rules, exact subscription expiry, quotas, active seats, immutable creation order, 500/300 newest-first retention, delayed cleanup visibility, upgrade restoration, preserved links, export rejection, receipt replay protection, owner-only revenue access, and Razorpay HMAC/paid-invoice validation.
- TypeScript compilation and Vite production build pass. The largest generated JavaScript chunk is approximately 396 KB before compression, with no size advisory.
- Deno type checking passes for the billing handler. Git whitespace checks pass. No business seed data or hardcoded business statistics were added.

## Subscription backend deployment

- Subscription and billing-hardening migrations applied to the final CRM project, with migration history recorded. All 21 public application tables have RLS enabled; internal billing state also has RLS and no client policies.
- Plan prices are INR paise: Free 0, Starter 199900, Business 500000.
- The crm-billing Edge Function is deployed with handler-level authentication. A live HTTP smoke check rejects anonymous configuration requests with HTTP 401. Earlier checks also rejected invalid JWTs/job credentials and unconfigured webhooks.
- The align-subscription-maintenance Cron job is active every five minutes using a server-generated Vault credential. Cleanup refuses to run without configured Razorpay and fresh provider reconciliation.
- Final-project transaction-only subscription checks passed: 500 temporary contacts remain viewable during retention; preserved edits/exports are rejected; expired excess and previews are hidden; cleanup keeps the oldest 100 and removes the newest 400. The entire fixture, including its passwordless test Auth row, was rolled back.
- Razorpay keys, plan IDs, webhook secret, and approved test workspace IDs remain unconfigured. Checkout intentionally stays unavailable. No real or test charge has been made.
- Platform revenue code exists, but no platform-owner identity was granted automatically. This requires a verified owner Auth UUID.

## Prior CRM verification

- Earlier transaction-only checks on the final project passed workspace creation, lead conversion/idempotency, relationships, pipeline/won calculations, stage history, and isolation. Those fixtures were rolled back. The project now has user-owned data; earlier zero-user/zero-workspace counts are historical.
- Auth health/settings endpoints worked; signup requires email confirmation. Render production Site URL and exact dashboard/recovery redirects were configured during the earlier deployment.
- Earlier Security Advisor rerun reported no issues; Performance Advisor had informational unused-index suggestions. Those results predate subscription migrations and do not establish security of the new release.
- On the earlier isolated test backend (zfcybanqdwwaqvokkfnb), real Auth/HTTP/browser checks covered login, CRM CRUD, conversion, search, filters, exports, pitches, reports, board drag/drop, tasks, notes, desktop/mobile layout, and dialogs. Disposable fixtures were removed. These checks do not establish an authenticated browser pass for the new billing screen on the final project.

## Remaining verification

- Sign in to Razorpay Test Mode, create Align-specific plans/webhook, enter matching server secrets, and complete checkout plus webhook delivery tests. See BILLING.md.
- Authenticated billing-screen desktop/mobile QA and real Razorpay renewal/cancellation/plan-change acceptance tests. No authenticated user session was available for these browser checks.
- Final-project confirmation/recovery email round trips, custom SMTP, backup restoration, load testing, and operational alerting.
- Exhaustive browser audit of every CRM control and actual printed PDF layout.

Customer proposal email delivery, customer view tracking, calendar synchronization, and external email/push reminder delivery remain unconfigured. Subscription renewal warnings are in-app. Manual customer payment records are separate from platform subscription billing.
