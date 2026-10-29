# Account security

Feature 1 extends the existing Supabase email/password login with authenticator setup, a second-step screen, one-time backup codes and **Settings → Security & sessions**. Signup, email confirmation, workspace onboarding and password recovery stay in the existing Auth screen.

## Current staging profile: password hook NOT enabled

The Password Verification Attempt hook is optional and is **not enabled** for this staging profile. `database/supabase/config.toml` sets `auth.hook.password_verification_attempt.enabled = false`. Hosted Auth must also leave the hook disabled; local configuration is not automatically applied to hosted Auth.

Migration `20261028185041_native_login_rate_limit.sql` remains in migration history and may be applied after the account-security migration. It creates the private optional function, grants narrowly scoped access to Supabase Auth, and creates its counter policy. It does not enable a hosted hook, register a trigger, schedule a job, or modify existing user records. When unused, the function is dormant and supplies no login lockout. Do not edit an already-applied migration to remove it.

**Remaining security gap:** direct password guessing against Supabase is not locked out by Align. An attacker can skip Align's `login_check` preflight and call `/auth/v1/token?grant_type=password` directly. Align's ten-check limit does not count those requests. Supabase's own hosted endpoint protections still apply, but they are separate from an account-specific failed-password lockout. The local Docker result must not be treated as proof of hosted rate-limit settings.

This gap matters most for users without 2FA: a correctly guessed password can grant their account access. For accounts with 2FA enabled, a password alone still cannot pass Align's second-step/session checks. **Recommend that administrators enable 2FA**, and encourage every user to do the same. This is a recommendation, not an automatically enforced administrator policy.

## What is enforced without the hook

- Supabase Auth owns TOTP secrets and verifies six-digit codes. Align stores the factor ID and ten user-bound SHA-256 backup-code hashes, never plaintext backup codes. Each code has 128 bits of cryptographic randomness. Consumption and the session grant happen in one locked transaction.
- Enabling requires a valid TOTP. Turning off 2FA or replacing backup codes requires the current password plus a current TOTP or unused backup code. Turning off also revokes the user's other Align sessions. Replacing codes invalidates the previous set.
- The backend verifies the access token with Supabase Auth and checks its session ID against the native session. The user cannot choose another identity or manufacture a verification grant. Removing a native factor directly does not clear Align's separate enabled state.
- Restrictive policies guard all current public application tables. Workspace/member/billing paths are also guarded. The billing function checks session validity before using its service-role client; separately authenticated webhooks and maintenance retain their existing checks.
- Sessions expire 30 minutes after last recorded activity. Activity writes are throttled to once per minute, so the deadline may be up to a minute earlier than the last interaction. Status polling and token refresh do not extend it. Expired/revoked sessions cannot re-register; the user must sign in again.
- Revocation denies further Align database and billing access immediately. Open screens check every 15 seconds and clear cached data on expiration/revocation. A local expiry timer also works offline. These controls cannot erase already downloaded information or revoke every native Auth capability of an existing JWT. Current-session logout additionally calls native local signout.
- The session page lists registered Align sessions backed by valid native sessions. Tabs in the same browser share a session. Device/User-Agent and IP come from Supabase; missing values and geographic location are shown as unavailable.
- Align limits login preflight checks per normalized email, and code/security-setup operations per user, to ten per 15-minute window. These counters are independent of the disabled optional hook. A code limiter still protects Align's verification endpoints; direct native MFA calls are subject to Supabase's own controls.

## Configuration and coordinated release

Follow [the staging deployment plan](STAGING_DEPLOYMENT.md), then [the staging test checklist](STAGING_SECURITY_CHECKLIST.md). Hosted changes require approval of the exact staging project reference before each mutation. Never operate on production as part of this staging workflow.

1. Use only staging public URL/key values for the frontend. Never put a service-role key in a `VITE_` variable.
2. Set `SECURITY_ALLOWED_ORIGINS` and `BILLING_ALLOWED_ORIGINS` to exact staging origins, comma-separated with no trailing slash. Hosted Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. See `backend/.env.example`; no new secret is needed for TOTP or backup codes.
3. In Auth, confirm **TOTP enrollment and verification are enabled**, set the staging **Site URL**, and allow staging `/dashboard` and `/update-password` redirect URLs. Keep Password Verification Attempt disabled. Inspect provider rate-limit settings separately. Leave Razorpay variables unset for this security-only staging profile.
4. Apply migrations in order, deploy `account-security`, then updated `crm-billing`, then the matching frontend. Both handlers use `verify_jwt = false` in backend configuration and perform their own authorization. Keep staging closed during the transition: old frontend bundles cannot register sessions under the new database rules.
5. Reload test browsers and complete baseline login, onboarding, recovery, permissions and billing-authorization checks before inviting testers.

CAPTCHA is not implemented in this release. Do not turn on hosted CAPTCHA before the frontend Auth requests and the backend password-recheck flow support it; doing so can break login, signup, recovery and 2FA removal/code replacement.

## Optional hook — only for Teams/Enterprise

These instructions are future opt-in instructions, **not steps in the current staging deployment**. Supabase currently reserves Password Verification Attempt hooks for Teams/Enterprise. Recheck the official plan entitlement before future use.

1. Keep both security migrations applied; confirm `private.security_password_attempt(jsonb)` exists.
2. In the intended project's Dashboard, open **Authentication → Hooks → Add hook → Password Verification Attempt hook**.
3. Select **Postgres**, schema **private**, function **security_password_attempt**. Enable the hook and choose **Create hook** (or **Update hook** when editing).
4. The URI is `pg-functions://postgres/private/security_password_attempt`; no HTTP hook secret is required. Do not expose `private` through the Data API.
5. Only for that future opt-in profile, enable the local hook too and add separate end-to-end acceptance tests for the account lockout. The optional function blocks attempts after ten failed passwords for an existing account in a 15-minute window; even a correct password is rejected during that lockout, while existing sessions are preserved.

Applying the function migration alone never proves that this hook is active.

## Verification boundaries

`npm test` runs business, endpoint/client and isolated PostgreSQL tests. The SQL test labelled **"optional function only; does not prove the hook is enabled"** invokes the function directly under a test Auth role. It is retained as optional capability coverage; its passing result does not claim the staging hook is enabled. Other security and application tests remain required.

Four hook-dependent expectations are removed from the active staging checklist: direct native ten-failure lockout, rejection of a correct password during that lockout, expiration of that native-hook lockout, and preservation of existing sessions during that lockout. General session controls and Align preflight/code-counter expiry tests stay required.

Earlier Docker end-to-end evidence with the hook enabled describes that earlier profile. The hook-disabled profile needs its own runtime acceptance evidence. Unit tests, configuration inspection and a production build alone do not establish hosted behavior. Run Deno type checks when backend code changes.

No geographic lookup, operator recovery screen, automatic administrator-MFA enforcement or CAPTCHA integration is included. A workspace administrator cannot automatically reset another user's MFA state. Password reset does not bypass 2FA. A backup code grants Align access, not native AAL2; native password/account changes may still require the authenticator. Exceptional recovery requires independent identity verification by the installation operator.

References: [Supabase Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks), [TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp), [rate limits](https://supabase.com/docs/guides/auth/rate-limits), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
