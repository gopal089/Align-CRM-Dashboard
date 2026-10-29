# Staging deployment: 2FA and session security, optional password hook OFF

Status: plan only; hosted deployment has not been performed or approved by this document. Base implementation: commit `d92709b`, branch `feature/2fa-session-security`, plus the subsequent local documentation/configuration commit. Record the exact approved release commit before deployment.

## Scope, target confirmation and phase approvals

- Use a separate staging Supabase project, staging Render site and disposable accounts. Do not access or modify production. The actual staging reference/site must be supplied and checked before any hosted interaction.
- Before **each command or UI operation that changes a hosted project**, show the literal staging project reference, the action and its expected effect; wait for the user's reply **"confirmed"**. A prior confirmation is not blanket approval for later mutations. Obtain separate approval before a push or a deployment.
- Read-only migration inspection and dry-run previews happen only after the user confirms the staging target. Do not print credentials or tokens. Use placeholders in saved commands; secrets are entered by the user.
- Keep staging closed while changing database/functions/frontend. Save the previous database/Auth state, migration history, Auth configuration and deployed artifacts before starting. Backups must cover relevant private and Auth state; a source-code rollback alone is insufficient.
- Password Verification Attempt is **optional and NOT enabled**. Do not perform the Teams/Enterprise opt-in instructions in SECURITY.md. TOTP is still enabled. No CAPTCHA integration is part of this rollout.

## 1. Confirm the staging reference and inspect migrations

The user supplies `<STAGING_PROJECT_REF>`. Show it back and wait for **confirmed**. Use explicit staging references rather than an implicitly linked production project. Run CLI help before execution if the installed CLI differs from the tested version.

From the repository root, the future read-only command is:

```sh
npx supabase --workdir database migration list --project-ref "<STAGING_PROJECT_REF>"
```

For an empty staging database apply all eight migrations in this exact order. If the first six are already applied, only the final two should be pending. Never rerun installed migrations or edit migration history to force a match.

| Order | File in database/supabase/migrations |
| --- | --- |
| 1 | 20261023185902_crm_foundation.sql |
| 2 | 20261023202758_crm_policy_indexes.sql |
| 3 | 20261024084523_crm_subscriptions.sql |
| 4 | 20261024092014_crm_billing_hardening.sql |
| 5 | 20261024093524_crm_billing_api_wrappers.sql |
| 6 | 20261024110228_business_price_4999.sql |
| 7 | 20261028181425_account_security.sql |
| 8 | 20261028185041_native_login_rate_limit.sql |

Migration 8 may be applied unchanged: its optional function is dormant without the Auth hook. It is not a prerequisite for TOTP/session enforcement, but keeping it in ordered history preserves compatibility with the repository and its optional SQL test. It does not turn the hook on.

## 2. Preview, approve, apply and verify

After target confirmation, produce and show this preview:

```sh
npx supabase --workdir database db push --project-ref "<STAGING_PROJECT_REF>" --skip-vault --dry-run
```

Stop for approval of that exact preview. Before the actual write, show the staging reference again and wait for **confirmed**:

```sh
npx supabase --workdir database db push --project-ref "<STAGING_PROJECT_REF>" --skip-vault
```

Then re-run migration listing and verify the two security functions/tables and their permissions with read-only staging checks. Keep `private` outside exposed Data API schemas. Do not run `setup-billing-cron.sql` for this security-only rollout.

## 3. Deploy backend functions separately

Get explicit approval and a fresh staging-reference **confirmed** response before each deployment, in this order:

```sh
npx supabase --workdir backend functions deploy account-security --project-ref "<STAGING_PROJECT_REF>" --no-verify-jwt
```

Verify deployment, then request the next confirmation:

```sh
npx supabase --workdir backend functions deploy crm-billing --project-ref "<STAGING_PROJECT_REF>" --no-verify-jwt
```

The handlers verify callers themselves. Disabling the legacy gateway JWT check does not make protected security/billing actions public. Do not call maintenance/webhook actions during security smoke tests.

## 4. User enters staging settings and environment values

Show the staging reference and request confirmation before asking the user to change hosted settings. The user enters values directly; never paste real values into chat or files committed to Git.

In Supabase **Edge Functions → Secrets** set only these application variables for this profile:

| Variable | Placeholder/example |
| --- | --- |
| SECURITY_ALLOWED_ORIGINS | https://align-staging.example.com |
| BILLING_ALLOWED_ORIGINS | https://align-staging.example.com |

Use the actual staging origin, without path or trailing slash. Add `http://127.0.0.1:5173` only if explicitly allowing local frontend access is approved. Do not leave production in either allowlist.

Supabase injects these runtime variables; do not manually add reserved names:

| Runtime variable | Expected value |
| --- | --- |
| SUPABASE_URL | https://<STAGING_PROJECT_REF>.supabase.co |
| SUPABASE_ANON_KEY | <AUTO_PROVIDED_STAGING_ANON_KEY> |
| SUPABASE_SERVICE_ROLE_KEY | <AUTO_PROVIDED_STAGING_SERVICE_ROLE_KEY> |

Leave **all Razorpay variables unset**, including `RAZORPAY_MODE`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_STARTER_PLAN_ID`, `RAZORPAY_BUSINESS_PLAN_ID`, `RAZORPAY_WEBHOOK_SECRET` and `RAZORPAY_TEST_ORG_IDS`. The handler's internal default mode is test, but missing keys keep billing unconfigured. No real payment-provider request is needed to verify billing authorization.

Keep Auth settings:

1. Confirm TOTP enrollment and verification are enabled.
2. Set **Authentication → URL Configuration → Site URL** to `https://align-staging.example.com`.
3. Allow `https://align-staging.example.com/dashboard` and `https://align-staging.example.com/update-password` as redirect URLs.
4. Confirm **Authentication → Hooks → Password Verification Attempt** is absent or disabled. Do not enable it. Check this through a read-only view first; any correction requires its own confirmation.
5. Review **Authentication → Rate Limits** separately. Native provider limits are not Align's per-account lockout. Retain email confirmation and arrange approved staging email recipients/delivery for signup and recovery checks.

Only if later opting in on **Teams/Enterprise**, follow SECURITY.md's optional-hook steps after separate approval. They are excluded from this deployment.

## 5. User deploys the separate staging frontend

Before changing the Render site, identify its staging site/service and corresponding `<STAGING_PROJECT_REF>`, get phase approval and wait for **confirmed**. Do not use the production Render site. Creating a Render Static Site starts its first deployment, so do not create it before the backend/configuration is ready.

| Setting | Value |
| --- | --- |
| Source branch | feature/2fa-session-security |
| Release | Exact user-approved commit, based on d92709b |
| Root directory | Repository root |
| Build command | npm ci && npm run build |
| Publish directory | dist |
| Auto deploy | Off during the coordinated rollout |
| SPA rewrite | /* → /index.html, action Rewrite |

Set these Render variables before building:

| Variable | Placeholder/example |
| --- | --- |
| VITE_SUPABASE_URL | https://<STAGING_PROJECT_REF>.supabase.co |
| VITE_SUPABASE_PUBLISHABLE_KEY | <STAGING_PUBLIC_PUBLISHABLE_KEY> |
| SKIP_INSTALL_DEPS | true |

The public key is intended for the browser. No server credential belongs in Render's `VITE_` variables. No CAPTCHA environment variable is required now. The user confirms when this frontend deployment is complete. A local-only follow-up commit is not available to Render until a later, separately approved push; do not push as part of Phase 2.

## 6. Verify staging and record results

Use [STAGING_SECURITY_CHECKLIST.md](STAGING_SECURITY_CHECKLIST.md). Run read-only anonymous smoke checks first. Authentication tests that create accounts, sessions or factors, consume codes, change counters or revoke sessions are hosted mutations too: show the staging reference and exact test action, obtain approval and wait for **confirmed** before each such operation. An approved deployment is not blanket approval for these test mutations.

Never guess or expose credentials. The user performs phone/credential-entry actions where required. Summarize PASS / FAIL / NOT TESTED; skipped/unavailable tests are not passes. Keep token-bearing HTTP payloads out of reports. Do not open staging to testers until baseline login and permissions pass.

## Rollback if login breaks

1. Keep staging closed. Preserve logs safely and determine whether the failure is expected Align preflight/code throttling, an expired session, missing function/configuration, or a runtime error. There is no optional-hook lockout in this profile.
2. Explain the cause before a fix. Show the staging reference and wait for **confirmed** before every hosted repair. Prefer fixing the matching feature version and redeploying it.
3. Do not drop restrictive policies, clear the MFA latch or disable TOTP to get old clients through. Leave Password Verification Attempt disabled.
4. A complete rollback requires separate approval to restore/recreate the disposable staging database and relevant Auth state from the pre-feature checkpoint, along with migration history and saved Auth configuration. Restore matching backend versions and the prior frontend (base parent commit `1a17b07`) together. No tested down migration currently exists. A restore can discard staging data created after the checkpoint.
5. For an existing Render site, **Deploys → Rollback → Rollback to this deploy** can restore its earlier frontend artifact, but it does not restore Supabase state. Coordinate it only after the matching database/backend state is ready, then retest baseline login, CRUD and billing authorization.

## Remaining risk accepted for this staging profile

Direct password guessing against Supabase is not locked out by Align; attackers can bypass `login_check`. Provider IP-based throttles still apply to hosted requests, but are not a ten-failure-per-account lockout. The risk is greatest for accounts without 2FA. Recommend that all administrators enable 2FA. CAPTCHA and an enforced administrator-2FA policy are possible later work, not part of this deployment.
