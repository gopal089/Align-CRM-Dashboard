# Verification status

Last updated 2026-10-25. This document records checks that can be shared publicly without exposing account names, project references, credentials, provider object IDs, or internal deployment details.

## Automated checks

- `npm test` runs 52 tests across the frontend, backend, and database folders.
- The database tests use isolated PGlite databases with test-only Auth roles. They cover organization isolation, permissions, CRM relationships, quota enforcement, expiry, retained records, and receipt replay protection.
- Backend tests cover Razorpay signatures, subscription ownership, plan validation, and paid-invoice validation using fake provider IDs and test fixtures.
- `npm run build` performs strict TypeScript checking and creates the production frontend bundle.
- No business seed data or real customer records are stored in the repository.

## Checks required for each deployment

- Confirm Supabase Auth sign-up, sign-in, confirmation, recovery, and redirect URLs in the target environment.
- Confirm row-level security and permissions with accounts from separate organizations.
- Confirm the deployed Edge Function rejects anonymous or invalid requests.
- Complete Razorpay checkout and webhook tests in Test Mode before enabling live credentials.
- Test renewal, cancellation, failed renewal, expiry, plan changes, retained-record restrictions, upgrade restoration, and cleanup timing.
- Verify SMTP delivery, backup restoration, monitoring, mobile layout, and the browser print/PDF workflow.

## Evidence limits

A successful local build or isolated database test does not prove that hosted Auth, email delivery, webhooks, backups, or external payment processing are configured correctly. Those checks must be repeated in the intended deployment environment without committing credentials or environment-specific identifiers.

See `BILLING.md` for generic subscription setup instructions.
