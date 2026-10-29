# Staging security checklist — password hook OFF

Use only a user-confirmed staging Supabase project and Render site, disposable test users, a phone authenticator and two independent browser sessions. Password Verification Attempt is optional and **NOT enabled**. All Razorpay environment variables remain unset. No production access is permitted.

Before every hosted mutation, show `<STAGING_PROJECT_REF>` and the exact operation; wait for the user's **confirmed** reply. This includes test account/session/factor creation, code consumption, simulated timestamps and revocations. Do not print passwords, keys, TOTP secrets, backup codes or tokens. Record only outcomes and sanitized error messages. Manual phone tests remain NOT TESTED until the user reports completing them.

## Setup and automated smoke checks

| Check | Expected outcome | Result |
| --- | --- | --- |
| Target and release | Approved staging reference/site and exact release commit recorded | NOT TESTED |
| Migration history | All expected migrations applied, including the dormant optional-function migration | NOT TESTED |
| Hook state | Password Verification Attempt absent/disabled; no native Align lockout claimed | NOT TESTED |
| Auth settings | TOTP enabled; staging Site URL and both redirect URLs allowed | NOT TESTED |
| Environment | Exact staging CORS origins; public frontend values; no Razorpay credentials | NOT TESTED |
| Anonymous security request | POST account-security with action status and no user token returns 401; no user data | NOT TESTED |
| Anonymous billing request | POST crm-billing with configuration action and no user token returns 401 | NOT TESTED |
| Normal account | Approved disposable user signs in, registers its session and creates/opens its workspace | NOT TESTED |
| CRM access | Active verified session can read/write permitted disposable records | NOT TESTED |
| Billing configuration | Active workspace administrator gets HTTP 200 and configured: false | NOT TESTED |
| Billing permissions | Representative gets 403; pre-MFA/revoked/expired session gets 401 | NOT TESTED |
| Private data | Ordinary clients cannot read or change security tables or execute service-only security RPCs | NOT TESTED |
| Cross-user attempts | Forged user/session IDs reveal no other user's sessions/codes and cannot revoke them | NOT TESTED |
| Align login preflight | First ten checks allowed per email/window; eleventh returns 429 | NOT TESTED |
| Align code limit | Invalid-code operations rejected; eleventh returns 429 within the window | NOT TESTED |
| Counter expiry | Align preflight/code limits recover after their window; use scoped staging-only simulation only with approval | NOT TESTED |
| Direct native password request | Wrong password rejected. Record provider throttling separately; do not require 429 after ten failures or mutate hook state | NOT TESTED |
| Direct API before MFA | Records/owner-only writes, workspace creation and billing denied before verification | NOT TESTED |
| Revoked session | Backend/database access denied immediately; registration cannot revive it | NOT TESTED |
| Idle server expiry | Approved test session moved back 31 minutes loses database/backend/billing access; touch/register cannot revive it | NOT TESTED |
| Local regression suite | npm test passes; optional-function test is capability-only evidence | NOT TESTED |
| Production build | npm run build passes with staging build values for the staged deployment | NOT TESTED |

The earlier full SQL lint diagnostic in existing billing retention is tracked separately. Do not describe that full lint run as clean; its local runtime loop check passed, and no retention source was changed by this feature.

## Manual browser and phone tests

1. **Baseline:** signup/confirmation, login with 2FA off, workspace onboarding, CRUD and password recovery work with staging email delivery.
2. **QR setup:** scan in the phone authenticator. Incorrect TOTP must fail; correct TOTP enables 2FA. Save the ten backup codes privately; reloading must not reveal them again.
3. **Second browser:** sign in and confirm the MFA challenge appears before workspace data, including after refresh/direct navigation. Wrong code fails; correct phone code allows access.
4. **Backup codes:** one works once and fails on reuse. Another unused code works. Replacing the set with password plus code invalidates the old set.
5. **Disable:** wrong password with a valid code fails; correct password with a wrong code fails. Both correct disables 2FA and revokes other Align sessions. Re-enable to check the new QR/code set.
6. **Session controls:** two independent browser sessions appear with truthful device/IP/last-active information. Revoke one; its UI returns to login at the next check (normally within 15 seconds). Test current-session logout and all-other-session logout. Another user remains unaffected.
7. **Real idle wait:** leave the app untouched for 30 minutes, including background tabs. Browser clears the CRM screen and requires login. Refresh/polling must not keep it alive. Repeat offline and reconnect; server denial must remain.
8. **Recovery with 2FA:** reset does not bypass MFA; use the working authenticator. Backup codes grant Align access but do not upgrade native Auth to AAL2 for all account/password changes. Loss of both factors/codes requires operator-assisted identity verification.
9. **Administrator recommendation:** confirm administrators can enable 2FA and are advised to do so. Do not claim automatic administrator-2FA enforcement.

Record each manual check separately as PASS / FAIL / NOT TESTED, with only sanitized notes. Do not infer a phone/browser pass from unit tests or generated TOTP API tests.

## Scope removed from this staging profile

The following four hook-dependent tests are **excluded from active staging acceptance**: native Auth ten-failure account lockout; rejection of a correct password during that lockout; expiration of that native-hook lockout; and preservation of existing sessions during that lockout. They may be reintroduced only for a separately approved Teams/Enterprise deployment with the hook enabled.

The SQL test named **"optional function only; does not prove the hook is enabled"** remains in the regression suite and directly tests the dormant function. It does not require an enabled hosted hook or prove any hosted account lockout. Other session, MFA, billing and Align limiter tests remain required.

## Final report template

| Area | PASS / FAIL / NOT TESTED | Sanitized evidence or reason |
| --- | --- | --- |
| Staging target/configuration | NOT TESTED | Awaiting phase/target confirmation |
| Database and functions | NOT TESTED | Awaiting deployment approval |
| Authentication and MFA | NOT TESTED | Awaiting disposable-user and phone tests |
| Backup codes and permissions | NOT TESTED | Awaiting approved mutation tests |
| Align rate limits | NOT TESTED | Additional preflight/code limits only |
| Session revocation and idle expiry | NOT TESTED | Include real browser wait and approved simulation |
| Billing authorization | NOT TESTED | Razorpay unconfigured; configured: false expected |
| Regression suite/build | NOT TESTED | Record actual command outcomes |

State the remaining gap in the report: direct password guessing against Supabase is not locked out by Align and matters most for users without 2FA. Hosted provider limits may throttle the source IP; they do not establish Align's account-specific lockout.
