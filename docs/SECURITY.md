# Account security

Feature 1 extends the existing Supabase email/password login. It adds authenticator setup and a second-step screen, one-time backup codes, and **Settings → Security & sessions**. Signup, email confirmation, workspace onboarding and password recovery remain in the existing Auth screen. No new package, email provider, calendar service or paid geolocation service is required.

## What is enforced

- Supabase Auth owns TOTP secrets and verifies six-digit codes. Align stores the factor ID and ten user-bound SHA-256 backup-code hashes, never the plaintext backup codes. Each backup code has 128 bits of cryptographic randomness. Backup-code consumption and the session grant happen in one locked database transaction.
- Enabling requires a valid TOTP. Turning off or replacing backup codes requires the current password plus a current TOTP or unused backup code. Turning off also revokes the user's other Align sessions. Replacing codes invalidates the previous set.
- The server verifies the access token with Supabase Auth, reads its session ID, and checks ownership against the native session. A client cannot choose another user or manufacture an MFA grant. Direct calls to native Auth to remove a factor do not clear Align's separate enabled state.
- A restrictive policy protects every current public application table. Security-definer workspace/member/billing paths are also guarded. The billing Edge Function checks the caller's session before using its service-role client; its separately authenticated webhook and scheduled maintenance paths remain unchanged.
- Sessions expire 30 minutes after the last recorded user activity. Activity writes are throttled to once per minute, so the deadline may be up to a minute earlier than the last interaction. Background status polling and token refresh do not extend access. Expired/revoked sessions cannot re-register; the user must sign in again.
- Revocation denies further **Align database and billing access immediately**. Open screens check every 15 seconds and clear their cached data on expiration/revocation. The local expiry timer also works without a network connection. These controls do not erase information already downloaded or revoke every native Auth capability of an existing JWT. Current-session logout additionally calls native local signout.
- The session page lists registered Align sessions that still have a valid native Auth session. Multiple tabs in the same browser share a session. Device/User-Agent and IP come from Supabase's session record; missing fields are shown honestly. Geographic location is unavailable; IP is not proof of physical location. Sessions predating this release register when the updated app loads.
- Align limits login preflight checks per normalized email and security-code operations per user to 10 per 15-minute window. Counters are committed independently of a failed verification. Native password sign-in remains directly between the browser and Supabase, preserving its device/IP recording. The required `private.security_password_attempt` password-verification hook also limits direct native logins: after ten failed passwords for an existing account within 15 minutes, further attempts return HTTP 429 until the window expires. A successful login before lockout resets that account's failure count. During lockout even a correct password is rejected; existing verified sessions remain active. The hook is executable only by `supabase_auth_admin`, and its counters are protected by RLS. Unknown email addresses have no Auth user ID and do not invoke this account hook; retain provider/gateway protections and the additional Align email preflight. Local testing found that the CLI's generated sign-in rate setting alone did not throttle direct password logins, so the hook must be configured explicitly.

Supabase references: [TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp), [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits), [session behavior](https://supabase.com/docs/guides/auth/sessions).

## Configuration and coordinated release

This feature is not activated by frontend files alone. Test it on a staging/local Supabase project before enabling production enforcement.

1. Keep `frontend/.env.local` configured with the public project URL and publishable key. No service-role key belongs in a `VITE_` variable.
2. Use `backend/.env.example` as the local server configuration reference. Hosted Supabase automatically supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Set `SECURITY_ALLOWED_ORIGINS` to the exact deployed HTTPS origin and any allowed development origin, comma-separated with no trailing slash. Keep these values in Edge Function secrets/local ignored environment files.
3. Confirm TOTP enrollment/verification is enabled in Supabase Auth. Enable the **Password Verification Attempt** Auth hook with `pg-functions://postgres/private/security_password_attempt`. Local database configuration includes this hook; the hosted Auth setting must be enabled separately before release. Apply the `20261028185041_native_login_rate_limit.sql` migration first. Inspect Authentication → Rate Limits. The feature assumes email/password accounts. If enabling Auth CAPTCHA later, wire its challenge into both sign-in and the backend password recheck first.
4. In staging, apply `database/supabase/migrations/20261028181425_account_security.sql` and `database/supabase/migrations/20261028185041_native_login_rate_limit.sql` after the existing migrations. Deploy `account-security` and the updated `crm-billing` function from `backend`, using the existing `verify_jwt = false` configurations because both handlers perform their own authorization.
5. Deploy the matching frontend and run the checklist below against that project. **Production needs a coordinated maintenance release**: pause user access while applying the migration and deploying both functions and the frontend. The migration deliberately denies unregistered sessions, so old frontend bundles cannot keep working with it. Tell users to reload. Do not push only the frontend to an auto-deploy branch before the backend is ready.
6. Check login without MFA, onboarding, recovery, an existing workspace and billing before reopening access. Keep the prior build and a database backup. Do not drop enforcement policies to “fix” a deployment after users enable MFA; roll forward with the matching backend/frontend instead.

Example CLI commands, from the repository root, after signing in and selecting a **staging** project:

```sh
npx supabase --workdir database link --project-ref YOUR_STAGING_PROJECT_REF
npx supabase --workdir database db push
npx supabase --workdir backend functions deploy account-security --project-ref YOUR_STAGING_PROJECT_REF
npx supabase --workdir backend functions deploy crm-billing --project-ref YOUR_STAGING_PROJECT_REF
npm test
npm run build
```

Review CLI help and the target before running deployment commands. Configure secrets through the dashboard or an ignored environment file; never paste keys into GitHub or chat.

## Manual acceptance checklist

Use disposable test accounts and two different browsers/private-browser sessions. Never enroll a real customer's authenticator for testing.

1. **Baseline:** sign up, confirm email, sign in and create a workspace. Sign out/in with MFA still off. Exercise password reset, ordinary record CRUD and billing configuration.
2. **Setup:** open Security & sessions, scan the QR using an authenticator, enter an incorrect code (must fail), then a valid code. Save the ten backup codes. Reload: codes must not be shown again.
3. **Login gate:** sign in in the second browser. No workspace data should load before a correct code. Refresh and navigate directly to a record URL: the challenge must remain. Incorrect codes must never grant data access.
4. **Backup codes:** use one to sign in. Sign out and try the same code again: it must fail. Use another code successfully. Generate replacement codes with password + code and verify old unused codes now fail.
5. **Disable:** wrong password + correct code and correct password + wrong code must both fail. With both correct, disable succeeds; the second browser loses CRM access. Re-enable and verify the new QR/codes work.
6. **Sessions:** verify device/IP/last-active display. Revoke the other session: its next data request must be denied and its UI must return to login within the next 15-second check. “Log out all other sessions” retains the current one. “Log out this session” returns to login. A separate user must be unaffected.
7. **Idle:** leave the app untouched for 30 minutes, including background tabs. It must clear the screen and require fresh login. Background token refresh must not keep it alive. Repeat offline, then reconnect. In staging only, a database operator can move that test session's `last_active` back 31 minutes to accelerate the server-side case; never shorten production deadlines for a test.
8. **Limits:** make 11 invalid code attempts within 15 minutes: the additional Align limiter must return HTTP 429. Use a disposable email to check the login preflight limit. Bypass the preflight and call native Auth directly for an existing disposable account: after ten failed passwords the next attempt must return 429. Confirm that a correct password is also rejected during lockout, then simulate a 16-minute-old counter in staging and confirm a correct password succeeds again. Keep other verified sessions active.
9. **Direct API:** with the second browser's pre-MFA token, try reads, owner-only updates, workspace creation and billing requests. All must be denied or return no records. After session revocation, re-registration must fail even if the JWT has not expired.
10. **Recovery:** test the existing reset link with MFA off, then with MFA on and a working authenticator. Password recovery does not bypass MFA. A backup code grants Align access, not native AAL2; Supabase may require the authenticator for native password/account changes. Someone missing both password and authenticator needs operator-assisted identity-verified recovery, not an automatic reset of the MFA latch.

## Automated checks and limits of verification

`npm test` runs the existing business-rule tests and new PostgreSQL, endpoint and client tests. They cover ownership, pre-MFA data denial, protected definer paths, one-time backup-code use, replacement, revocation, idle expiry, rate counters, wrong password/code and provider failure paths. PostgreSQL tests use isolated PGlite records. Endpoint tests mock Auth; they do not prove hosted TOTP delivery or project settings.

Run Deno's type checker for both functions in addition to the frontend production build. A full end-to-end Auth test requires running local Supabase/Docker or a properly configured staging project. Do not mark the hosted feature verified solely from these tests.

No operator recovery screen, geographic IP lookup, or additional roadmap feature is included. Keep backup codes safely: a CRM workspace administrator cannot automatically reset another user's security state. The installation operator must verify identity independently before any exceptional recovery and revoke existing sessions as part of it.
