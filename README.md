# Timekeeper

Time and billing app with email/password accounts, server sessions, and SQLite persistence. The original contracts, timesheets, approvals, invoices, payments, printing, and backup UI is retained.

For a shared HTTPS deployment, see [Host Timekeeper on Render](docs/hosting.md). The included `render.yaml` configures one Node service and a persistent SQLite disk.

## Run

Requires **Node.js 24 or newer**. There are no third-party runtime dependencies and no build step.

```sh
cd /workspace/Timekeeper
npm run dev
```

`npm run dev` watches the backend for changes; `npm start` runs without watching. The default address is local port 3000. Open the app in a browser, choose **Create an account**, and use a password of at least 12 characters. Signup without an invitation creates a new, empty workspace with an admin account. Invitation signup joins the inviting workspace instead. Settings can explicitly load sample data or restore an exported workspace backup.

The Python static server used by the original prototype is no longer needed. The Node server serves both the app and API. Browser localStorage is no longer the workspace source of truth; existing browser-only data is not automatically imported. Export it from the original prototype and restore the JSON backup in Settings.

## Data and accounts

The database is `.data/timekeeper.sqlite` by default. Its directory is ignored by Git. Schema migrations are applied automatically on startup and tracked in `schema_migrations`. Migration 2 upgrades existing owner memberships to admins, links their employee records, and adds invitations without deleting existing workspaces or sessions.

Account, membership, workspace, invitation, and session records use separate relational tables. Business data (contracts, employees, timesheets, invoices, and payments) is initially stored as one validated JSON workspace document. This preserves the prototype's backup format and financial relationships while the business model evolves. It is an initial persistence layer; individual resource tables and endpoints can follow when employee access and reporting are added.

Passwords are salted and hashed with scrypt. Random session tokens are stored only as SHA-256 hashes in the database. Sessions expire after seven days; logout revokes the current session. Cookies use HttpOnly and SameSite=Lax. Writes check the request origin. Authentication endpoints have a simple in-process per-IP rate limit.

Every workspace request derives access from the server session and membership. Clients cannot choose another account's workspace ID. Admins have full workspace access. Employees receive only their own employee record, their own timesheets, and assigned/historical contract names. Employee responses omit billing rates, contract budgets, client billing details, invoices, and other employees. Employee writes use a restricted endpoint: the server chooses their identity, checks assigned contracts, locks approved rows, and controls submission/withdrawal transitions. Billing rates are calculated and locked on the server.

The last admin cannot be demoted or removed. Role changes are checked on subsequent requests. Removing membership revokes sessions for that workspace and retains historical employee records. Linked employee records cannot be deleted, archived, or assigned a different account email through workspace edits; remove access first. Sample/reset actions retain linked account records. Restoring a backup must also retain those records. JSON workspace backups do not include memberships or invitation credentials.

To correct a sign-in email, choose **My account** in the header, enter and confirm the new email, and provide your current password. The account and linked employee IDs stay the same, including across multiple workspaces. Other sessions for that account are revoked; the current session is renewed. The new email must not belong to another account. This does not change the business billing email in Settings, and no confirmation email is sent.

To remove an unused employee record, choose **Team → Remove from team**. Records without timesheets are deleted; records with timesheet history are archived so hours and invoices stay intact. Archived records are hidden by default; enable **Show archived** to view or reactivate them through Edit. Pending invitations for the removed record are revoked. For a linked sign-in account, remove access in **Workspace access** first; use My account to correct your own email instead of deleting your profile.

Saves use a revision check to reject stale updates from other tabs or devices. The header distinguishes saving, saved, and unsaved changes. If saving fails, export your changes before reloading the server copy; the app does not silently overwrite newer data.

Encrypted database recovery, scheduling, and optional Google Drive uploads are available; see [Database recovery backups](docs/backups.md) for local testing, encryption-key handling, Google authorization, and Render configuration. They run in the existing service and are disabled until configured. The Settings recovery panel reports separate local and off-site timestamps. Only explicitly configured server backup operators can download full recovery copies after confirming their password. Other workspace admins cannot download every workspace's accounts or records.

Do not copy only the main SQLite file while WAL writes are active. Recovery archives use SQLite's online backup API. Keep encrypted copies outside the hosting disk and keep the encryption key separately. The JSON export remains an additional workspace-level copy; it does not recover accounts or memberships.

## Invite partners and employees

1. Sign in as an admin and open **Team → Workspace access**.
2. Enter the invitee’s email and choose **Admin** for partners or **Employee** for restricted access.
3. Optionally select an existing employee record. Otherwise the app matches a unique active record by email, or creates one when the invitation is accepted.
4. Choose **Create invitation link**, copy the link shown once, and share it privately. Links expire after seven days, are single-use, and are stored only as hashes. Creating a replacement revokes the previous pending link for that email.
5. Invitees open the link and either create an account or sign in with the matching email. Existing accounts can also accept while signed in. Accounts with multiple memberships can choose a workspace from the header.

Admins can change member roles, remove access, and revoke pending invitations from the same panel. Assign contracts to employee records before asking employees to log time. Employee accounts see **Timesheets** and **Contracts** only. Partners invited as admins share the same contracts, hours, invoices, and payments.

Invitation links are not emailed automatically. A link generated on your Mac points to your Mac; deploy the app at an HTTPS address before inviting people in other locations. Password reset and email verification remain future work.

## Configuration

Set variables in the process environment; `.env` files are not loaded automatically.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `HOST` | `127.0.0.1` locally; `0.0.0.0` in production | Listening address |
| `DATA_DIR` | `.data` relative to current directory | Persistent SQLite directory |
| `NODE_ENV` | unset | Set to `production` for Secure session cookies |
| `APP_ORIGIN` | Render-provided `RENDER_EXTERNAL_URL`, otherwise local request origin | Production requires an HTTPS origin; set explicitly for custom domains or other hosts, e.g. `https://timekeeper.example.com` |

Production requires HTTPS in front of this server, `NODE_ENV=production`, and the correct `APP_ORIGIN` or Render-provided `RENDER_EXTERNAL_URL`. Use a persistent disk for `DATA_DIR`. The current implementation targets one Node process with SQLite; distributed rate limiting and multi-instance deployment need additional work.

## API

All bodies are JSON; mutation requests require an `Origin` matching the application origin. The browser sends the session cookie automatically.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{name,email,password,inviteToken?}` creates an account and session; optional invitation joins an existing workspace |
| `GET` | `/api/auth/features` | Reports whether account email is enabled |
| `POST` | `/api/auth/forgot-password` | `{email}`; generic confirmation and rate-limited email when configured |
| `POST` | `/api/auth/reset-password` | `{token,password}`; single-use reset and session revocation |
| `POST` | `/api/auth/login` | `{email,password,inviteToken?}` creates a session and optionally accepts an invitation |
| `POST` | `/api/auth/logout` | Revokes current session |
| `GET` | `/api/auth/me` | Returns signed-in identity, employee link, active workspace, and role |
| `PATCH` | `/api/auth/email` | `{email,currentPassword}` changes only the signed-in account's email, updates all employee links, and renews the session |
| `GET` | `/api/workspace` | Returns `{data,revision,role,employeeId,workspaceId}`; employee data is redacted |
| `PUT` | `/api/workspace` | Admin-only; validates and saves `{data,revision}`; returns new revision; stale revision returns 409 |
| `GET` | `/api/workspaces` | Lists the signed-in account’s workspace memberships |
| `POST` | `/api/auth/switch` | `{workspaceId}` switches active workspace and rotates the session |
| `PUT` | `/api/employee/timesheets` | Employee-only `{sheets,revision}` saves own hours; rates and identities are enforced by the server |
| `GET` | `/api/members` | Admin-only member list |
| `PATCH` / `DELETE` | `/api/members/:userId` | Admin-only role change `{role}` or access removal |
| `POST` | `/api/employees/:id/remove` | Admin-only `{revision}` deletes an unlinked unused record or archives one with timesheet history |
| `GET` / `POST` | `/api/invitations` | Admin-only list or creation `{email,role,employeeId?}`; creation returns token once |
| `DELETE` | `/api/invitations/:id` | Admin-only pending invitation revocation |
| `POST` | `/api/invitations/preview` | Public token lookup `{token}`; reports workspace, invitee email, and role |
| `POST` | `/api/invitations/accept` | Signed-in acceptance `{token}`; matching email required |
| `GET` | `/health` | Checks database availability |
| `GET` | `/api/backups/status` | Admin-only configuration and verification timestamps; no keys, paths, or archive contents |
| `POST` | `/api/backups/download` | Configured server operator only; `{currentPassword}` creates a fresh encrypted instance recovery archive |

## Validation

```sh
npm test
```

The backend integration tests use temporary databases and check invitations, linked employee access, role changes, last-admin protection, employee time-entry restrictions, redacted responses, migration from existing owner accounts, and registration, duplicate emails, password verification and hashing, logout and expiry, access enforcement, workspace isolation, invalid writes, concurrent saves, persistence after restart, origin checks, rate limiting, and production cookies.

Browser validation in Chromium also covered creating an account, starting with an empty workspace, loading sample data, all six screens, editing/submitting/approving hours, invoicing, duplicate billing prevention, partial/full payments, reload persistence, signing out, and signing back in. Date boundaries, leap years, and backup validation passed. Download/restore interactions, printed output, and mobile layouts still need dedicated checks.

Browser checks for shared access covered creating employee and admin invitations, joining existing employee records, restricted employee navigation and contract data, employee submission, admin approval, locked approved rows, and shared settings changes by a partner admin. No browser JavaScript errors occurred.

## GitHub workflow

The source repository is `https://github.com/brketterl/Timekeeper`. Use its `main` branch as the shared source of truth. Clone it into a new folder on your Mac rather than overwriting a folder containing an existing `.data` database. Keep the old folder until you have backed up its database and verified the new checkout. Never commit `.data`, database files, passwords, or invitation links. GitHub stores code; persistent runtime data remains on the machine hosting the app.

Use `staging` for changes and browser review before releasing to `main`. See [Test changes before production](docs/releases.md) for the separate staging service, GitHub branch protections, and manual production deployment settings. Existing Render settings must be changed in the dashboard; a Git push does not change those settings.

GitHub Actions runs the backend tests in both test and production modes, plus Chromium browser smoke tests. To run the browser tests locally:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The browser tests use a new temporary SQLite database, not the developer's or production's data. Playwright is a development-only dependency; the running server uses the AWS SDK for R2 uploads.

## Next backend work

- Email verification and administrative account recovery beyond emailed password resets.
- Resource-level business APIs, normalized financial tables, and an audit history.
- Independent monitoring for a completely stopped service. Google/R2 connectivity and off-site restore checks require your own configured account.

Invoice sending currently records a date; it does not send email. Payments are recorded manually and are not processed by the app.

Cloudflare R2 encrypted recovery backups are supported on staging; see [R2 setup and restore checks](docs/backups.md#cloudflare-r2-recommended-alternative-to-google-drive). No additional Render service is required.

Optional [backup alert emails through Resend](docs/backup-alerts.md) notify the server operator about failed backups, 48-hour overdue off-site uploads, and recovery. Configure separately after testing; alerts are disabled by default.

[Password reset and invitation email setup](docs/account-email.md) reuses Resend and the configured app domain. Account email is opt-in via `AUTH_EMAIL_ENABLED`; migration 3 requires a verified pre-release recovery backup.

Registration is invitation-only by default. Keep `ALLOW_PUBLIC_REGISTRATION` unset or `false` on the hosted service. For a new isolated local test database, use `ALLOW_PUBLIC_REGISTRATION=true npm start` temporarily to create its first test owner, then restart normally. Existing accounts can sign in; invited accounts receive only the invitation’s assigned role.

[Workspace activity history](docs/activity.md) records key committed changes for admins, with server-derived actors, workspace isolation, and append-only database entries. Migration 4 requires a verified pre-release production recovery archive.
