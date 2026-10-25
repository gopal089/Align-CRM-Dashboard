# Align CRM

A React + TypeScript CRM built for persistent Supabase records. The interface uses Tailwind CSS, Radix accessible dialogs and menus, TanStack Query, and a restrained indigo design system.

## Start locally

The app is connected to **CRM** in **gopal089's Org**:

- Dashboard: https://supabase.com/dashboard/project/pojrnwxvudxgmdrgqfhg
- API: https://pojrnwxvudxgmdrgqfhg.supabase.co
- All migrations in `database/supabase/migrations/` are already applied, in filename order.
- Auth site URL is `http://127.0.0.1:5173`. Sign-in and password recovery redirects are configured.
- `frontend/.env.local` already contains the project URL and public publishable key. Do not overwrite it with the empty example.

```bash
cd /Users/gopalsarma/CRM-Dashboard
npm install --cache /private/tmp/crm-npm-cache
npm run dev
```

Open http://127.0.0.1:5173. Create your account, confirm your email, and create a workspace. The first member becomes its administrator. Other people sign up, then the administrator adds their registered email from Team. **This does not send an invitation email.** People who belong to multiple workspaces can switch in Settings.

For a separate installation, copy `frontend/.env.example` to `frontend/.env.local`, enter that project's URL and **public publishable key**, and apply every migration in `database/supabase/migrations/` to a new empty database. Configure the site URL and the `/dashboard` and `/update-password` redirect URLs for your origin. Never put a service-role key in a `VITE_` variable: Vite exposes those values to the browser. Keep signup email confirmation enabled and configure SMTP for reliable email delivery.

Without a configured backend, the app shows a setup screen. It does not fall back to browser arrays, generated business records, or pretend successful saves.

## Project structure

| Folder | Purpose |
| --- | --- |
| `frontend/` | React screens, browser-side Supabase client, styles, public assets, Vite configuration, and frontend tests |
| `backend/` | Supabase Edge Functions and backend tests for Razorpay signature and receipt handling |
| `database/` | PostgreSQL migrations, Supabase database configuration, maintenance Cron setup, and database tests |
| `docs/` | Billing and verification documentation |

The root `package.json` and `package-lock.json` are shared tooling files. Keeping them at the root lets one `npm install` support all three areas. Run the normal `npm` commands from the repository root.

## What is implemented

- Protected application routes; Supabase sign-up, sign-in, sign-out, reset request, and recovery form.
- Overview, Leads, Contacts, Companies, Deals & Pipeline, Pitch Desk, Sales Reports, Activities, Tasks, Team, and Settings.
- Shared CRUD forms, detail routes, archive/restore, administrator/manager permanent deletion with confirmation, validation, empty/error/loading states, search, filters, server pagination, sorting, and filtered CSV exports.
- Duplicate checks for company names and contact/lead emails, including archived records.
- Qualified-lead conversion in a single PostgreSQL transaction. Existing matching contacts and companies are reused. Repeated conversion returns the same deal.
- Configurable pipeline stages and probabilities, drag-and-drop stage updates, a table alternative, weighted value, close timestamps, and automatic stage history.
- Pitches, reusable templates, ordered editable sections, proposal preview, browser print/Save as PDF, duplicate, archive/delete, status history, acceptance analytics, and idempotent deal creation from accepted pitches.
- Calls, meetings, emails, notes, follow-ups, and automatic deal/pitch updates. These are manually recorded activities unless created by an internal database trigger.
- Tasks, assignment, due dates, status changes, overdue/today/upcoming/completed views, and in-app due-task reminders.
- Server-side reports for revenue, pipeline, lead sources/conversion, representatives, and pitches, with date-range controls, sortable/filterable tables, CSV export, and print styles.
- Workspace profile, single currency, time zone, pipeline configuration, lead sources, personal preferences, manual payment tracking, data export, membership roles, and team/individual targets.

## Important behavior and definitions

- **No business seed data is loaded.** Empty datasets display zero and useful onboarding actions.
- An **open pipeline** is potential value. **Closed-won value** is the value of won deals. **Collected payments** are separate manually recorded payments; no money is collected by this app.
- The organization has one currency. Currency changes are blocked after any deal, pitch, target, or payment exists, preventing silent currency mixing.
- Reporting date ranges are inclusive calendar dates in the workspace's time zone, translated to an exclusive UTC end boundary.
- Leads, contacts, and pitches are measured by creation time; won/lost values use the recorded close time. Lead-to-won attribution follows explicit `deals.lead_id` for leads created in the selected cohort, with wins before period end.
- Qualified leads include Qualified and Converted. Conversion rate = Converted / leads created in the period.
- Open pipeline and pipeline stage counts are the **current snapshot**, independent of report dates. Upcoming tasks are also current. These definitions are visible in the app.
- Targets count periods that overlap the report range. They are **not prorated**. Team target achievement uses team targets; representative performance uses individual targets.
- Stage configuration changes do not silently rewrite existing deal probabilities. A new stage selection uses that stage's configured probability. Stages in use cannot be removed or have their outcome changed.
- Closed deal reopening resets its close timestamp; closing it again records the new close time. Stage history preserves transitions. Revenue reports reflect current deal state, rather than an accounting ledger.
- Pitch “Sent” is a **manual status record**, not email delivery. Viewed status is rejected by the database until real tracking is implemented. “Sent” analytics count the current manually recorded Sent status.
- Print/Save as PDF uses the browser print dialog. It is not a server-generated or digitally signed PDF.
- All organization members can read shared organization records. Representatives can create and update their own assigned records, but cannot reassign them to others, delete records, manage targets, alter roles, or change workspace configuration. Sales managers can manage sales records and targets; only administrators can change membership and organization configuration.
- Search supports name/company/email/phone where relevant. Global search returns up to 20 matches. Relationship selectors return 50 matches and support search. Pipeline columns show the first 30 matching cards and link to the paginated full list. Related record tabs show 10 records and offer the full filtered list.

## Database and security design

The migrations create 21 application tables with organization identifiers, composite relationship constraints, timestamps, indexes, decimal monetary columns, validation triggers, and row-level security (RLS). Browser queries use the signed-in user's access token. Database policies enforce organization membership and roles; changing a URL or `org_id` cannot grant access to another organization. Subscription quotas, exact expiry, and retained customer records are enforced in Postgres. See `docs/BILLING.md` for Razorpay setup, the approved limits, and deployment checks.

Sensitive bootstrap and membership lookups live in the **non-exposed `private` schema** with a fixed search path, explicit grants, and checks of the authenticated user. Public RPCs use `SECURITY INVOKER`. Keep `private` out of Supabase's exposed schemas. Public functions are not executable by anonymous callers. A workspace must retain at least one administrator.

Lead conversion, pitch/section save, and accepted-pitch deal creation execute transactionally on the database. Audit histories cannot be directly modified by ordinary clients. Composite foreign keys prevent cross-organization associations, even when the client knows another record's UUID.

## External integrations

| Feature                                         | State                                                           |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Supabase database / authentication              | Connected to the CRM project; real SDK integration              |
| Account verification / password recovery emails | Redirects configured; custom SMTP and email delivery unverified |
| Customer proposal email delivery                | Unconfigured; record external sends manually                    |
| Customer view tracking                          | Unconfigured; no fabricated Viewed status                       |
| Calendar sync                                   | Unconfigured; log meetings manually                             |
| Payment provider                                | Unconfigured; optional manual payment records only              |
| Email / push task reminders                     | Unconfigured; in-app due-task reminders provided                |

## Verification

```bash
npm test
npm run build
```

The tests use **PGlite, a real PostgreSQL engine**, in an isolated in-memory database with a test-only Auth schema and database roles. They test SQL/RLS rules and calculations. They do not prove hosted Supabase Auth, PostgREST, email delivery, production configuration, or browser acceptance.

`database/tests/database.test.ts` covers organization isolation, representative permissions, nonmember membership attacks, duplicate/email validation, transactional/idempotent conversion, weighted versus won versus collected value, stage history, invalid updates, foreign-key isolation, atomic pitch/section saves, view-tracking rejection, accepted pitch conversion, payment enablement, report periods, archive behavior, last administrator protection, and anonymous access. `frontend/tests/utils.test.ts` covers currency, time-zone/daylight-saving boundaries, inclusive date ranges, and search input sanitization.

See `docs/ACCEPTANCE.md` for the exact current verification state. Do not treat a passing frontend build or local SQL tests as proof of production readiness.

## Deployment

`npm run build` writes the generated static application to the repository-level `dist` directory so the existing Render publish setting keeps working. The source files remain inside `frontend/`. Serve the build over HTTPS with SPA fallback to `index.html`, set the two public environment values at build time, and configure the deployed Auth redirect URLs. The database migrations must be installed first. Before production rollout, complete the remaining checks in `docs/ACCEPTANCE.md`, configure account email delivery, set production Auth URLs, and choose your backup/recovery policy.
