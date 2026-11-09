# Timesheet submission and approval emails

This feature is developed on `staging`. It reuses the existing Resend key and sender, runs in the existing Render process, and is disabled by default.

## What gets sent

- A committed submission sends one email per newly affected timesheet to **current workspace admins**, excluding the submitting account. This includes admin-submitted entries on someone else's behalf; a sole admin does not receive a self-notification for their own submission.
- A committed approval sends an email to the account linked to that employee record. Employees without a linked account do not receive mail through an arbitrary employee contact address.
- Multiple rows changed in the same timesheet/save are grouped. Additional submissions/approvals later are new actions and may produce new emails. A partial approval reports that hours were approved, not that the entire sheet is necessarily approved.
- Repeated saves with unchanged statuses do not generate additional emails. Draft edits, withdrawal, reopening, and edits to already-approved data do not themselves generate these notifications. They remain subject to Activity logging.
- Emails include the workspace name, submission actor where applicable, period start, affected row count, and a link to the configured app. They do not include billing rates, invoice/payment details, time-entry notes, or attachments. Recipients sign in and select the appropriate workspace/period to inspect current status; email does not grant access.

Recipients come from workspace memberships, not browser request fields. Before each attempt, the sender checks that submission recipients are still workspace admins or that approval recipients are still linked to the same employee. Removed members and ineligible role/link changes cancel delivery. Emails use the recipient account's current email. A message already handed to the provider cannot be recalled when membership subsequently changes.

## Delivery and duplicate suppression

A durable notification queue is written **inside the same transaction** as the timesheet change and its audit event. If queue storage fails, the change rolls back rather than pretending a notification was queued. If email delivery fails after commit, the hours/approval remain saved.

New writes trigger background processing; a once-per-minute check also handles pending work and restarts. Processing handles up to 20 due emails per pass. A busy queue may delay some messages until later passes. Each event/recipient pair is unique; each queued notification has a persistent random delivery ID reused for provider idempotency. Completed deliveries are not sent again after restart.

Failed delivery retries after 15 minutes, up to five attempts. Failed emails then remain visible for manual retry. Delivery is best effort rather than exactly once: provider idempotency has a finite window, and an uncertain receipt or manual retry outside that window can produce duplicates. Provider acceptance is not confirmed inbox delivery; check Resend delivery logs/spam when needed. Operate only one Timekeeper process against this SQLite database, as required by the hosting setup.

Admins can open **Settings → Timesheet email notifications** to see pending, accepted, and failed counts for their workspace. After fixing Resend/configuration issues, **Retry failed emails** queues only failed, undelivered, uncancelled entries in that workspace; accepted messages are not retried. This action is admin-only, same-origin, and rate limited. Logs expose generic failure codes rather than recipient addresses, message contents, or credentials.

The queue does not backfill old Activity events. Enabling notifications affects new transitions only. Imports that introduce new submitted/approved rows are genuine detected transitions and may queue notifications; use isolated test data/buckets and email addresses you control during local review. A withdrawal or edit after a message was queued does not retract that historical notification; the message asks recipients to inspect current status in the app.

## Local testing on your Mac

Stop the app and run from the project directory:

```sh
git switch staging
git pull origin staging
npm ci
export TIMESHEET_EMAIL_ENABLED=true
export RESEND_API_KEY_FILE="$HOME/.config/timekeeper-backups/timekeeper-resend.key"
export EMAIL_FROM="backup@alerts.vtcsquared.com"
export APP_ORIGIN="http://localhost:3000"
npm start
```

Open **http://localhost:3000** consistently with `APP_ORIGIN`. Existing account-email and backup-alert flags are independent; keep their settings as needed. Use local test accounts with real inboxes you control; this local configuration sends real mail only when you take the relevant actions. Keep production data and R2 buckets out of local tests.

1. Sign in as a linked employee, enter draft hours and submit them. Check the local workspace admin inbox. Multiple admin recipients must be members of this same workspace.
2. Save/reload without a new status transition and confirm no new notification arrives.
3. As an admin, approve submitted rows; confirm the linked employee receives an approval email. The link should use your local origin and the email should contain no financial details or private time-entry notes.
4. Open Settings and refresh notification status. Accepted counts mean Resend accepted messages, not that inbox delivery was guaranteed.
5. Confirm invitations, password recovery, Activity, and backups still work. Automated tests simulate mail and failures without reading production secrets or contacting real inboxes.

## Production configuration after approval

In the existing Render service add:

| Key | Value |
| --- | --- |
| `TIMESHEET_EMAIL_ENABLED` | `true` |

Keep the existing `RESEND_API_KEY_FILE`, verified `EMAIL_FROM`, and working `APP_ORIGIN=https://timekeeper.vtcsquared.com`. The same key must have sending permission for the sender domain. The code also supports `RESEND_API_KEY` instead of the key file; do not set both. `AUTH_EMAIL_ENABLED` and `BACKUP_ALERTS_ENABLED` do not automatically enable timesheet notifications. No additional service, mailbox, or runtime package is required.

Use Save only until the tested code release is approved. Once deployed, use a controlled employee/admin workflow to confirm real delivery and verify a successful backup. To pause sending and new queue creation, set `TIMESHEET_EMAIL_ENABLED=false` and restart. Existing pending emails remain paused and resume when enabled; old Activity events are not retroactively queued.

## Database and recovery

Migration **5** adds `timesheet_notifications`, its uniqueness constraint, and scheduling index. Existing accounts, roles, and timesheets remain intact. The queue stores event/recipient IDs and delivery status, not credentials or message bodies. Rows are retained for duplicate suppression/status counts and grow with activity; monitor the existing disk.

Before production approval, create and locally verify/restore a fresh production recovery archive. Backup tools now accept schemas **2–5**. Schema-5 restores keep audit history but clear the notification queue, sessions, password-reset links, and pending invitation access. Previously queued historical emails are not replayed after a restore. New notifications get new delivery IDs, including after rollback to an older archive.

Reverting code does not reverse migration 5. Older backup tools restricted to schema 4 cannot read schema-5 archives; keep updated recovery tools or fix forward. Restoring a pre-release database loses changes since that archive and requires a maintenance window and a new data directory. Prefer disabling the notification flag while diagnosing mail failures; that leaves business data unchanged.
