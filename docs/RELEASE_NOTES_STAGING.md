# Contacts CSV/XLSX import — current staging release

## Scope and source

- Branch: `feature/customer-import`, starting from custom-fields commit `8cb245f`.
- Local implementation only. Pushing, migration application and staging deployment require separate approval. Nothing merges into main or releases to live in this task.
- Contacts only. Leads, Companies, proposals, email and follow-ups are not part of this release.
- The nine baseline migrations, existing security/billing functions and billing scheduler are unchanged.

## Design, limits and dependencies

- Contacts → Import contacts opens a lazy-loaded wizard: choose file, worksheet, map columns, choose Skip/Update existing, build the complete server preview, confirm, then commit bounded batches.
- Exact parser versions: `papaparse@5.5.3` (CSV), `fflate@0.8.3` (bounded ZIP decoding), `saxes@6.0.0` (read-only streaming XML); `@types/papaparse@5.3.16` is development-only. Their lockfile is committed. Releases predate this work; fflate 0.8.3 includes the ZIP64 fix missing in 0.8.2.
- ExcelJS was evaluated and removed because its dependency tree reported vulnerabilities. The final dependency tree passed npm audit with zero findings at verification time. An audit is a point-in-time check, not a guarantee against future advisories.
- Parsing runs in a dedicated worker only after file selection. It does not execute formulas, macros, scripts, external links or XML entities. The main thread terminates parsing after 15 seconds.
- Accepted: UTF-8 CSV (including BOM), XLSX with up to 20 worksheets; choose one worksheet. First row is the header. Excel date styles become YYYY-MM-DD values; numeric identifiers should be stored as text if leading zeros matter.
- Limits: 5 MiB file, 10,000 data rows across the workbook, 100 columns, 2,000 characters per cell, 250,000 worksheet cells, 1,000 ZIP entries, 20 MiB total expanded ZIP content. ZIP64, encrypted ZIPs, legacy XLS and XLSM are rejected.
- The ZIP central directory is checked before decompression; actual output sizes are checked during streaming in small compressed chunks, including dishonest archive-size metadata.
- Uploads and commits contain at most 25 rows; upload JSON targets 90 KiB with a server maximum of 96 KiB. A single oversized row is rejected. A job stores at most 16 MiB of temporary JSON and a workspace has at most three undiscarded recent jobs.
- No import Edge Function, paid account, queue or background import worker is required. Browser parsing and small Postgres RPC transactions avoid the hosted Edge Function CPU/runtime limits. A full 10,000-row hosted performance/load test has not been performed.

## Database and permissions

New migration, after the existing nine:

`20261101112111_contact_import.sql`

It adds:

- `private.contact_import_jobs` and `private.contact_import_rows`: private staged/source data, expiry, immutable server-generated row retry IDs, reviewed target IDs and committed outcomes.
- Both tables have RLS, owner/workspace read policies and restrictive session/MFA policies. All direct PUBLIC/anon/authenticated table privileges are revoked; do not expose the private schema through the Data API.
- Public invoker RPC `public.contact_import(uuid,text,uuid,jsonb)` delegates to the narrow private definer workflow. Execution is authenticated-only. The private helper needs elevated access to its inaccessible staging ledger and explicitly checks native session/MFA, active workspace membership, job ownership, record ownership, billing visibility/preservation and current permissions. These checks are required because definer code bypasses ordinary RLS. Existing record, custom-value and billing-quota triggers still run.
- Private helpers `import_email`, `import_phone`, `contact_import_lock`, `import_contact_value`, `contact_import`, `cleanup_contact_imports`. All use an empty search path. Only the pure normalization functions need authenticated/service-role execution for contact expression indexes; no staging read/write permission is granted.
- Two normalized contact indexes and `aa_contact_import_lock` on Contacts. The trigger acquires the existing billing workspace advisory lock before record/custom/quota triggers, serializing duplicate decisions with ordinary saves. Other record types are unchanged.
- A separate hourly SQL Cron job named `align-contact-import-cleanup`, scheduled at minute 17. It deletes expired jobs and cascades temporary rows. The migration enables pg_cron only when available. PGlite skips Cron; real Docker verification checks the job. It does not modify existing billing jobs.

## Duplicate, transaction and retry behavior

- Email is trimmed/lowercased. Phone punctuation is removed, leading 00 is normalized, and 7–15 digits are required. No country code is guessed. Local and international numbers must use consistent country-code conventions to match.
- Duplicate checks use email OR phone against workspace contacts, including archived/preserved matches, and earlier valid file rows. Name-only rows cannot be deduplicated automatically.
- Skip leaves matching contacts unchanged. Update existing uses one explicit reviewed target ID; it never inserts an extra duplicate. Conflicting email/phone matches become preview errors. There is no Import anyway option and no automatic merging of multiple contacts.
- New contacts belong to the importing user. V1 maps Name, Email, Phone, Job title, Tags, Notes and active Contact custom fields. Company/owner assignment is not imported; updates preserve those links. Empty and unmapped values do not erase existing values.
- Custom fields use permanent IDs and current definitions. Zero/No remain typed values. Existing archived custom values are retained; a field archived between preview and commit causes that row to fail safely.
- A confirmation value is issued only after all rows have been reviewed. Every committed row specifies its retry ID and reviewed target. Batches run in row order and transactionally record contact changes plus outcomes. Replayed rows return their existing outcome; a lost response or reopened import does not create another contact.
- Permissions, matching identities, ownership and quotas are checked again at commit. Changed matches/permissions produce failed rows, not silent target changes. A row failure rolls back that row; completed rows stay committed.
- Imported totals include updated rows; Updated is a subset. The final report separately shows Imported, Updated, Skipped and Failed.
- Error CSV contains original source columns, row number and error. It uses the existing CSV helper plus protection for leading-whitespace formula-like values/headers. It does not export values from matched CRM records.

## Temporary-data retention and resume

- Raw files remain in browser memory. Source rows, including unmapped columns, and mapped values are stored privately for resume and error reports. Users should remove unnecessary sensitive columns before importing.
- Access expires exactly 24 hours after job creation. Hourly cleanup normally removes expired data within the next hour; outages or disabled Cron can delay physical deletion. Verify Cron operation before staging acceptance.
- Closing/pausing stops future client batches after the current request. No import continues automatically in the background. Reopen Contacts → Import contacts → Recent imports to resume.
- An interrupted upload requires reselecting the same file; a SHA-256 fingerprint and saved worksheet/mapping are checked, and previously uploaded rows must match exactly.
- Discard temporary import immediately deletes temporary source/outcome rows and frees a job slot. Contacts already committed remain. Download the error report before discarding.
- After expiry, restart with a fresh preview. Old job IDs cannot be revived. Normalized duplicate checks run again against already committed contacts.

## Functions, secrets and manual configuration

- New Edge Functions, Storage buckets, API secrets and frontend environment variables: none.
- Keep existing frontend examples/settings and native TOTP/session configuration. Do not enable the optional password hook for this release.
- Keep private tables/schema unexposed. Confirm the separate import-cleanup Cron job is active. Do not change billing Cron, Razorpay or Auth URLs for this feature.

## Local verification

- Run `npm test` and `npm run build` from this branch.
- Initialize a fresh unlinked Docker project named `align-import-local-test`, copy all ten migrations and existing backend functions, enable native TOTP and keep the password hook disabled. Only loopback origins and test values are allowed. Studio/analytics/Storage are not needed for these tests.
- Serve the existing account-security/crm-billing functions locally, then run `node backend/tests/customer-import.local-e2e.mjs <LOCAL_TEST_WORKDIR>`. The shared runner refuses hosted URLs and unknown project identities.
- It first repeats the native 2FA, backup hashing/single use, session, rate-limit, billing and custom-field checks, then import permissions, preview, duplicates, explicit IDs, partial retries, quotas, custom fields, hostile rows, expiry and cleanup.
- Run `npx supabase --workdir <LOCAL_TEST_WORKDIR> stop --project-id align-import-local-test` when finished. Never use --all.

### Results for this local implementation

- Full suite: 132 tests passed across 12 files; production build passed. The parser is emitted as a separate worker bundle.
- Real Docker: all ten migrations applied. Sixteen existing native security/billing/custom-field groups and ten import groups passed, including 1,000 duplicate-heavy rows, transaction/retry behavior, ownership changes, quotas, expiry and cleanup.
- Additional SQL tests cover retained-record protection after preview; parser tests cover malformed/oversized/encoded input, workbook formulas/macros/entities, inflated-size lies, decompression bombs, multiple sheets and currency formats.
- Local browser: CSV mapping, custom number/yes-no columns, preview with one duplicate/error, confirmation and final 1 imported / 1 skipped / 1 failed report passed. Reopening the completed job after signing in again also passed.
- Browser download automation did not observe the error-file completion. The real CSV Blob-generation path and formula escaping passed automated tests; repeat the actual browser download manually on staging.
- Staging/live were not accessed. Physical-phone, 24-hour wall-clock retention, hosted performance and a 10,000-row hosted load test were not performed.

## Staging deployment plan — not executed

1. Inspect the final local commit and secret scan. Obtain separate approval to push only `feature/customer-import`: `git push origin feature/customer-import`.
2. Confirm the separate staging project and staging Render service. Save a fresh private schema/data recovery copy outside Git. Never link or target live.
3. Read history: `npx --no-install supabase --workdir database migration list --project-ref <STAGING_PROJECT_REF>`.
4. Preview: `npx --no-install supabase --workdir database db push --project-ref <STAGING_PROJECT_REF> --skip-vault --dry-run`. Stop unless the existing nine versions match and only `20261101112111_contact_import.sql` is pending.
5. Show the preview and obtain separate approval before applying: `npx --no-install supabase --workdir database db push --project-ref <STAGING_PROJECT_REF> --skip-vault`.
6. Verify all ten migrations, private-table privileges/RLS, RPC anonymous denial, and `align-contact-import-cleanup` in Cron. Check that the previous billing jobs are unchanged. Do not deploy any Edge Function.
7. After separate approval, change only the staging Render Static Site branch to `feature/customer-import`, keep Auto-Deploy Off, build `npm ci && npm run build`, publish `dist`, and preserve existing staging-only VITE variables and SPA rewrite. Manually deploy the approved commit.
8. Run public HTTPS/asset checks first. Obtain separate approval for authenticated staging acceptance. Nothing merges into main or deploys to live in these steps.
9. Frontend rollback uses the previous artifact/branch. Keep the additive import schema and existing cleanup job to remove temporary data. Committed contacts are ordinary CRM records; no automatic destructive undo is supplied.

## Manual staging acceptance — after separate approval

1. Sign in as staging administrator with existing 2FA. Confirm normal CRM/billing/custom-field flows.
2. Contacts → Import contacts: upload a small UTF-8 CSV, then an XLSX with two worksheets. Choose the intended worksheet.
3. Map core/custom columns, including number zero and No. Build preview; verify errors, duplicates and explicit target IDs before confirming. Contacts must not change during preview.
4. Test Skip, then Update existing against existing contacts and repeated file rows. Blank/unmapped values and owner/company links must remain unchanged.
5. Verify conflicting email/phone matches, invalid values and archived fields appear as errors. Confirm valid rows only and inspect the totals.
6. Pause/close after a partial commit, reopen Recent imports and resume. A lost-response retry must not duplicate contacts. An interrupted upload must require the original file.
7. Download error rows; open as text first and confirm source columns/errors and formula protection. Confirm ordinary CRM CSV export still works.
8. Repeat as representative and as a different workspace user. Other owners' records and foreign jobs must be inaccessible; test a role/owner change between preview and commit.
9. Check quota and retained-record denials; completed rows remain while failing rows are reported. Repeat the existing 2FA/session checklist.
10. Test oversize, too many rows, wrong encoding, formula and macro files. Verify clear rejection. Inspect Cron history for cleanup and confirm expiry denies old jobs. Discard temporary test imports when reports are saved.

---

# Previous release: custom fields and saved views

## Scope and source

- Branch: `feature/custom-fields-saved-views`, based on `2980780`.
- Local implementation only. Do not push or deploy without separate approval.
- Leads and Contacts support workspace custom fields and saved views. Companies are unchanged.
- No CSV/XLSX import, email sending, proposal tracking, reminder or scheduler feature is included.
- The existing billing scheduler, Auth hooks, Edge Functions and subscription behavior are unchanged.

## Migration

Apply only this new migration after the existing eight migrations:

`20261030103722_custom_fields_saved_views.sql`

It adds:

- `public.custom_field_definitions`: permanent UUIDs, workspace, record type, name, type, dropdown options and archive state.
- `public.saved_views`: owner, workspace, entity, personal/shared visibility and validated configuration.
- `public.leads.custom_values` and `public.contacts.custom_values`: JSON objects defaulting to empty, without replacing existing columns or IDs.
- Workspace/role policies and explicit restrictive `account_security` policies on both new tables.
- Private trigger functions `private.validate_custom_field()`, `private.validate_custom_values()` and `private.validate_saved_view()`. These are security-invoker functions with an empty search path; direct execution is revoked from PUBLIC, anon and authenticated.
- Triggers validate definitions, record values and saved configurations regardless of the client. New APIs use the existing Supabase Data API; no public RPC or Edge Function is added.

The eight older migration files are not edited. No historical records are rewritten by this migration; the new columns start empty.

## Permissions and retained data

- Active workspace members can read field definitions, shared views and records allowed by the existing CRM policies. Personal views are visible only to their owner, including when another member is an administrator.
- Only administrators can create, rename, archive or restore fields, and create/edit/delete shared views. Sales Managers do not receive this administrator-only permission.
- Personal view ownership and field/view identity cannot be forged or moved between workspaces.
- Field type is fixed. Existing dropdown options cannot be removed; new options can be appended.
- Physical field deletion is not granted. Archive hides the field from entry forms; values remain visible in record details and can be restored.
- Views retain archived-field references, filters and ordering, with a warning. They do not silently broaden results by removing archived filters.
- Record values remain protected by existing ownership, quotas, retention, MFA and session checks. Field archival does not exempt records from normal record deletion or existing billing retention.
- Lead conversion retains custom values on the original lead. Contact fields have independent IDs; automatic lead-to-contact field mapping is not included.

## User interface and validation

- Settings → Custom fields → Leads or Contacts → Add field.
- Types: text, number, date, dropdown and yes/no. Unset and No/zero are distinct.
- Forms, detail pages and list tables show custom values. Archived values are retained during ordinary form edits.
- Leads/Contacts → Fields & columns controls visible columns and custom filters. Clicking a table heading controls sorting; numeric custom sorting is numeric, not alphabetical.
- Save new view creates a named personal or administrator-created shared view. Update view saves subsequent changes; otherwise changes are temporary.
- CSV export retains the existing permission checks, formula protection and filename behavior, and exports visible custom columns with their current labels.
- Limits: 50 active fields per workspace/entity; 50 dropdown options; field/view names 80 characters; text values 2,000 characters; custom JSON 50 KB per record; numbers within ±1e15; 100 views per owner/workspace; 20 custom filters; 60 visible columns.
- Custom filters support equals, contains for text, numeric/date ranges, empty and not-empty. All custom filters must match.
- This release has no custom-value search index. Review query plans before large-scale rollout rather than adding an index for every workspace field.

## Functions, secrets and settings

- New Edge Functions: none. Existing `account-security` and `crm-billing` do not need redeployment.
- New secrets: none. Existing frontend public Supabase variables and function-origin settings remain required.
- New Auth settings, hooks, schedulers, outside accounts or paid services: none.
- No changes to the billing cron script or Razorpay settings.

## Local verification

Run `npm test` and `npm run build` from the feature worktree.

Real Docker acceptance uses `backend/tests/customization.local-e2e.mjs`:

1. Create a fresh, unlinked local Supabase project with `supabase init` in a disposable local directory. Never copy a hosted `.env` or link file.
2. Set its `project_id` to `align-fields-local-test`, choose unused local ports, enable local TOTP, and keep the Password Verification Attempt hook disabled.
3. Copy `database/supabase/migrations/` into that local project's migrations folder. Copy `backend/supabase/functions/` and the two local function settings from `backend/supabase/config.toml`.
4. Set only local test origins for the two functions; leave Razorpay credentials unset. Start Docker Supabase and serve functions locally with `--no-verify-jwt`, as the handlers perform authorization.
5. Run `node backend/tests/customization.local-e2e.mjs <LOCAL_TEST_WORKDIR>`. The runner rejects non-loopback API targets, checks the local project identity, generates disposable users/passwords in memory and prints only sanitized outcomes.
6. The runner verifies typed CRUD, numeric filtering/sorting, cross-workspace and role restrictions, private/shared views, archival, billing quotas/authorization, real TOTP and backup hashing/single use, session revocation, code/preflight limits and simulated 31-minute idle expiry.
7. Run `npx supabase --workdir <LOCAL_TEST_WORKDIR> stop --project-id align-fields-local-test`. Do not use `--all`; other local projects may belong to other work.

Generated codes exercise real local Auth; they do not prove physical phone scanning or a real 30-minute browser idle wait. No hosted or payment-provider calls belong in this test run.

### Local results for this release

- Full suite: 107 tests passed across 10 files; production build passed.
- A fresh Docker database applied all nine migrations. The local acceptance runner passed all 16 grouped checks with the optional password hook disabled.
- Catalog checks confirmed row security on both new tables, invoker-mode validation functions, an empty search path and no direct anon/authenticated execution grants.
- Browser checks covered field creation, zero/No values, custom filtering and columns, a persisted shared view, archive warnings and CSV output retaining custom labels and zero/false.
- Staging and production were not accessed. Hosted deployment, physical-phone testing and load testing remain unverified.

## Future staging deployment — written plan only

Each hosted mutation requires explicit staging-target confirmation and action approval. Replace placeholders privately; never use production values or print credentials.

1. Inspect the local final commit and secret scan, then obtain separate approval to push **only** `feature/custom-fields-saved-views`:

   `git push -u origin feature/custom-fields-saved-views`

2. Confirm the separate staging project reference and Render staging service. Do not link a project. Record a staging backup/recovery checkpoint before migration.
3. Read staging migration history:

   `npx supabase --workdir database migration list --project-ref <STAGING_PROJECT_REF>`

4. Preview the push without Vault updates:

   `npx supabase --workdir database db push --project-ref <STAGING_PROJECT_REF> --skip-vault --dry-run`

   Stop if the preview includes anything except `20261030103722_custom_fields_saved_views.sql`, or the baseline history differs.

5. Show the preview and obtain separate approval. Then apply:

   `npx supabase --workdir database db push --project-ref <STAGING_PROJECT_REF> --skip-vault`

6. Repeat migration list and verify version `20261030103722` is applied. Inspect both new tables' RLS and restrictive session policies. Stop on failure; do not deploy the frontend before the database is ready.
7. Do not redeploy functions or modify secrets, Auth settings or scheduled jobs for this feature.
8. After separate approval, open **Render → the staging Static Site → Settings → Build & Deploy → Branch**; change only that site's branch to `feature/custom-fields-saved-views`. Keep Auto-Deploy Off. Save the branch setting.
9. Keep repository root blank, build `npm ci && npm run build`, publish `dist`, existing SPA rewrite `/*` → `/index.html`, and staging-only frontend connection variables. No new environment variable is needed.
10. Use **Manual Deploy → Deploy latest commit** on the staging site, verify the exact approved commit, wait for success and copy its assigned staging address.
11. Run anonymous read-only checks first. Obtain separate approval for all authenticated acceptance tests below. Nothing merges into main or releases to live as part of these steps.

## Staging acceptance — user performs after approval

1. Sign in as a disposable staging administrator, including existing 2FA when enabled. Confirm ordinary CRM pages and billing still work.
2. Open Settings → Custom fields → Leads. Create one field of each type; repeat on Contacts.
3. Create/edit records with text, a negative number/zero, a valid date, a dropdown value and No. Refresh: values and types persist in forms, tables and details.
4. In a list, open Fields & columns. Select columns and apply a numeric/date filter. Sort the numeric heading both ways and check values such as 2 and 12.
5. Save a personal view. Switch views and refresh; filters, sorting and columns persist. Update it after making changes.
6. Create a shared view as administrator. Another workspace member sees it but cannot edit it unless an administrator. The administrator's personal view stays private.
7. Rename a field: values and view references remain. Archive it: it disappears from entry forms, stored values stay on record details, and views referencing it show a warning. Ordinary edits retain archived values. Restore it and edit again.
8. Sign in as a representative: field management/shared-view creation is unavailable; direct forbidden writes also fail. Own record values are editable; other owners' values are not. A Sales Manager still cannot manage field definitions or shared views.
9. Use a different disposable workspace: fields, values and views from the first workspace are unavailable. Switching back restores the correct workspace configuration.
10. Export a permitted filtered list. Check custom column labels, false/zero values, and formula protection. Existing billing export restrictions must still apply.
11. Recheck MFA, backup codes, sessions, revocation and idle expiry with the existing staging security checklist. Do not infer these passes from unit tests alone.

## Rollback and known limits

- Frontend rollback to the prior artifact leaves definitions, values and views in the database. Keep the additive migration; do not drop columns/tables to roll back a UI problem.
- No destructive down migration is supplied. Export/back up feature data before any separately approved schema removal.
- Archived labels are unique within their workspace/entity; restore or rename the archived definition instead of accidentally reusing its identity.
- Removing a user's account deletes their saved-view configurations through its owner foreign key; this does not delete CRM records or field definitions. Workspace deletion retains existing cascade semantics.
- Archived fields can still appear in saved-view columns, filters and sorting. This is intentional data preservation, with a warning.
- No hosted load test, staging migration/deployment or physical-phone acceptance is performed by this local implementation task.
