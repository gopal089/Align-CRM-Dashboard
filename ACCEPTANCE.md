# Verification status

Verified on 2026-10-24. The application is connected to **CRM**, project `pojrnwxvudxgmdrgqfhg`, in **gopal089's Org** (Sydney region selected during project creation).

## Passed locally

- TypeScript compilation and Vite production build.
- 29 automated tests using PGlite PostgreSQL, database roles and a test Auth schema. Both migrations run in filename order.
- Tests cover organization isolation, representative restrictions, conversion transactions and idempotency, relationships, histories, company/contact/activity/task CRUD, target validation, payment rules, archive behavior, anonymous permissions and date/currency calculations.
- No business seed data or hardcoded business metrics.
- Production dependency audit: zero known vulnerabilities at verification time.

## Passed on the final CRM project

- Both migrations applied; migration history recorded.
- 16 public application tables; row-level security enabled on all 16.
- Transaction-only authenticated-role checks passed for workspace creation, lead conversion, duplicate-conversion prevention, company/contact relationships, pipeline and won calculations, stage history, and organization isolation.
- All final-project test changes rolled back. Zero workspaces and zero Auth users at handoff; no test customers or sales data remain.
- Public Auth health and settings endpoints respond successfully. Email signup is enabled; email confirmation remains required.
- Public company query returns an empty result with no signed-in identity.
- Site URL saved as `http://127.0.0.1:5173`; exact redirects saved for `/dashboard` and `/update-password`.
- Local app reloaded after connection change and shows the protected sign-in screen.
- Performance Advisor shows zero errors and warnings, with 37 informational suggestions. Displayed suggestions concern unused indexes on the new database; indexes were retained for expected CRM queries.
- Security Advisor rerun completed with zero errors, warnings or suggestions. This is a configuration check, not a guarantee of production security.

## Passed on the earlier isolated test backend

These checks used the same application and migrations on project `zfcybanqdwwaqvokkfnb`, rather than the final CRM project. This distinction matters: they do not prove final-project email delivery or an authenticated browser session on the final project.

- 15 live HTTP test groups: real password login for three disposable users, workspace/member management, conversion, aggregates, stage changes, pitches/sections/deal creation, tasks, role and organization rejection, payments, reporting periods, pagination/search/sort, activities, targets and validation.
- Browser: login/logout and protected routes; lead create/edit/refresh/qualify/convert; search, pagination, bulk updates, filters, archive/restore and filtered CSV contents; correct back navigation.
- Browser: pitch preview, duplicate, section reorder and customer placeholders; all five report tabs and historical custom dates; deal board stage filtering and drag-and-drop persistence.
- Browser: tasks create/reschedule/complete, global search, notes and related activity, desktop and 390px mobile layout, drawer focus containment and Escape focus restoration.
- Disposable test organizations, business records and Auth users removed after testing. Confirmed zero organizations and zero Auth users on that backend. The unused initial project itself still exists and is not connected to this app.

## Still unverified or needed before production

- Create your own account in the app and confirm the email, then create your first workspace. No user password was chosen or stored by the agent.
- Final-project signup email delivery, confirmation-link completion and recovery-email round trip. Custom SMTP is not configured.
- An exhaustive browser click-by-click audit of every control in every module, especially permanent-delete confirmations, all settings/team changes, actual print/Save as PDF output, and every tablet size.
- Production hosting/HTTPS and redirect origins, backup restoration, load testing and operational monitoring.
- The main JavaScript bundle is about 678 KB before compression; the production build passes with a size advisory. Route components are lazy-loaded.

## Explicitly unconfigured external services

Customer proposal email delivery, customer view tracking, calendar synchronization, payment-provider synchronization and email/push reminders. Manual status records, manual payments, and in-app task reminders are available and labeled. Viewed pitch status is rejected until real tracking exists.
