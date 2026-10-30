# Custom fields and saved views — staging release notes

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
