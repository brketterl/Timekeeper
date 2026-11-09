# Password recovery and invitation emails

Developed on `staging`; production needs a separate release approval after local review. This feature reuses Resend and your verified sender. No extra Render service, mailbox, or runtime dependency is required.

## Invitation-only registration

Public signup is disabled by default. The ordinary sign-in page has no Create an account button. A valid invitation exposes account creation; the backend requires the invitation, verifies its email/expiry/revocation, and assigns its stored role. Posting directly to the registration API cannot bypass this rule, even when the database is empty.

Keep `ALLOW_PUBLIC_REGISTRATION` unset or `false` on Render. `true` is an explicit operator override for isolated local setup/test installations; never enable it on this invitation-only hosted app. For a brand-new local development database only, run `ALLOW_PUBLIC_REGISTRATION=true npm start` to create a test owner, then stop and restart normally to close signup. No automatic first-user registration exception exists.

Existing accounts, including previously self-created workspaces, are retained. This change prevents new uninvited registrations; it does not delete prior accounts or grant them access to other workspaces. Existing sign-in, password recovery, and emailed/manual invitations continue to work. No database migration is added by this signup restriction.

## What users see

- Sign in → **Forgot password?** → enter the account email. A generic confirmation appears whether or not an account exists. Email delivery is asynchronous and never returned as an account-specific success/failure response.
- The emailed link opens **Choose a new password**. Enter and confirm 12–256 characters. Links expire after 30 minutes and work once. All of the account's sessions are removed after reset; sign in again with the new password.
- Reset requests are limited to one active link request per account per two minutes, plus the existing IP-based authentication limit (20 requests per 15 minutes, shared with other authentication actions). A later eligible request invalidates the earlier link. Account email changes and password changes invalidate prior links.
- An admin creates an invitation in Team → Workspace access, choosing the email, role, and optional employee record as before. When enabled, the app emails the link automatically. The link can still be copied from the result, shown once. The status distinguishes provider acceptance, failed delivery, and disabled email.
- Invitation links open the signup form directly for signed-out users, with the invited email prefilled. New users create an account with the invited email. Existing users sign in or accept while already signed in. Existing role restrictions, employee links, email binding, seven-day expiry, revocation, and single-use acceptance remain enforced by the backend.
- To retry a failed invitation email, create a replacement invitation with the same email and intended role/employee. This revokes the old link. Already-created invitations are not emailed retroactively.
- If an invited existing user forgets their password, reset it and then reopen the original invitation link to sign in/accept. Password reset does not itself grant workspace membership.

Email provider acceptance does not guarantee inbox delivery. Check spam and Resend logs when needed. Reset-delivery failures are logged with a generic code without exposing account existence, credentials, or links. There is no automatic retry of reset or invitation email; request/create a replacement if delivery fails. Backup-alert retries are unchanged.

## Configuration

| Key | Value |
| --- | --- |
| `AUTH_EMAIL_ENABLED` | `true` to enable password-reset and invitation emails; disabled by default |
| `RESEND_API_KEY_FILE` | `/etc/secrets/timekeeper-resend.key` on Render; existing local private file on your Mac |
| `EMAIL_FROM` | `backup@alerts.vtcsquared.com` (existing verified sender) |
| `APP_ORIGIN` | `https://timekeeper.vtcsquared.com` once that is your verified, active HTTPS domain |

The same Resend key must allow sending from this verified domain. `RESEND_API_KEY` is supported instead of the key file; never set both. `BACKUP_ALERT_TO` remains the backup-alert recipient and is **not** used for account emails: those go only to the account/invitation email. Backup alert configuration remains independent; it can be enabled or disabled separately.

Links use the configured application origin, never request Host/Origin headers or a client-supplied URL. Without `APP_ORIGIN`, the Render external URL is used in production; set `APP_ORIGIN` explicitly for the custom domain. Locally, use a local origin. Tokens are in URL fragments so they do not enter HTTP access logs; reset fragments are removed from the address bar after the form loads. Never share invitation/reset links in tickets, chat, Git, or screenshots. Scanner GET requests do not consume reset tokens.

## Test on your Mac

From your local project, stop the app and update staging:

```sh
git switch staging
git pull origin staging
npm ci
export AUTH_EMAIL_ENABLED=true
export RESEND_API_KEY_FILE="$HOME/.config/timekeeper-backups/timekeeper-resend.key"
export EMAIL_FROM="backup@alerts.vtcsquared.com"
export APP_ORIGIN="http://localhost:3000"
npm start
```

Use **http://localhost:3000** consistently with that exact `APP_ORIGIN`. Keep local test data and test R2 bucket configuration separate from production. Don't export production `DATA_DIR` or use production credentials/data in automated tests. This local app will send real emails when you explicitly request a reset or create an invitation. Use only email addresses you control for testing.

1. Sign in with a local account whose email you can receive. Sign out, request a password-reset email, follow it, choose a new password, and sign in again. An expired/used link must show an error and cannot change the password again.
2. As a local admin, invite an address you control. Confirm the email mentions the correct workspace and role, follow it in a separate browser profile/private window, and create an account or sign in with that same invited email.
3. Confirm an Employee sees only their own hours and assigned contracts. Existing accounts can join the same workspace without creating duplicate accounts.
4. Confirm Settings → Server recovery backups still shows successful status. Optionally send a backup test alert to ensure the existing bound alert recipient is unchanged.

Automated tests use simulated mail only, including a loopback-only inbox in `e2e/server.js`. It is not part of the production server. Tests cover expiry, replacement, replay, concurrent redemption, role isolation, manual fallback, disabled mail, rate limits, session invalidation, and backup restoration across schemas 2 and 3.

## Migration and production release

This release adds database migration **3**, creating a `password_resets` table. It does not alter workspace data or existing accounts/permissions. Only SHA-256 token hashes and credential fingerprints are stored; raw reset tokens are never persisted in the database. Restoring a schema-3 backup clears reset links along with sessions and pending invitations. Existing schema-2 archives can be verified/restored by the new tools, then upgraded on application startup.

**Before approving production:** create a fresh production backup on the currently deployed app, download the Cloudflare copy, and verify/restore it locally using the matching encryption key. Keep that pre-migration archive and key. Do not restore over a live database or commit business data.

After local testing and explicit release approval, merge staging to main. In the existing Render service, keep the Resend secret, email sender, and backup settings. Add `AUTH_EMAIL_ENABLED=true` and confirm `APP_ORIGIN` is your working public domain. Use Save only until release. Deploy the approved main commit; build command stays `npm ci && npm test`, start command `npm start`. Check health, account login, an invitation to an address you control, password-reset delivery, and backups after deployment.

Rollback: disabling `AUTH_EMAIL_ENABLED` stops new account emails and hides Forgot password, while manual invitations and backup emails remain. Previously issued reset links remain usable until expiry or use. Reverting code does not remove migration 3; old backup tools that accept only schema 2 cannot process schema-3 archives. Prefer the current backup tools or fix forward. A full database rollback from the pre-release backup loses changes since that capture and needs a maintenance window and a new data directory.
