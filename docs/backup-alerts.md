# Backup alert email setup

Developed on `staging`; test locally before approving a production release. Resend domain verification and creating a key do **not** enable alerts in Timekeeper. This feature uses the existing Render web process; no second Render service is required.

## Behavior

- Email on the first failed backup, including failed local snapshot/verification or off-site upload.
- Escalate once if no successful off-site upload has occurred for 48 hours. If there has never been an upload, count from when alerts were first enabled (persisted across restarts).
- Send a recovery email after successful off-site uploads resume, if an outage alert was accepted by Resend.
- Suppress repeated messages for the same outage, including across restarts. A fresh incident can send a new alert. Alert state is stored in `backup-alert-status.json` in the backup directory; don't delete it to clear errors.
- Failed email attempts retry after 15 minutes. Check Settings for email-delivery errors. Provider idempotency keys reduce duplicates when retrying an uncertain request. Delivery is best effort, not an exactly-once guarantee; Resend's idempotency window is limited. Disk-write failures degrade restart deduplication but do not prevent best-effort emails.
- No database contents, workspace names, customer data, credentials, attachments, or encryption keys are emailed. Emails contain a generic explanation and last successful off-site timestamp. Raw provider error responses are never emailed or logged.
- The backup process continues even if email delivery fails. Disabling email alerts leaves scheduled encrypted backups unchanged.

**Limitation:** this monitor runs inside the Timekeeper app. It cannot send while Render is stopped, crashed, or disconnected from the network. It evaluates status on startup and every minute while running, after any active backup attempt. Monitoring a completely stopped service requires an independent external monitor. An accepted email receipt is not proof of inbox delivery; check Resend delivery status and the recipient's spam folder.

## Domain and recipient

The intended sender is `backup@alerts.vtcsquared.com`; Resend must verify `alerts.vtcsquared.com` and enable sending. The intended recipient is `blake.ketterl@vtcsquared.com`; that address must have a working inbox/forwarding destination independently of Resend. Verifying the sending subdomain does not create a mailbox.

Create a Resend key with **Sending access**, restricted to this domain if available. Keep API keys in secure files/configuration, outside source control and chat. Do not change existing Wix website or email DNS records when configuring Resend; add exactly the records provided by Resend.

## Local review

1. Update your local staging checkout with `git switch staging`, `git pull origin staging`, and `npm ci`.
2. Keep the existing local backup key/R2 configuration, using the **test bucket**, not the production bucket. Use test account data.
3. Save the Resend API key as a single line in a private file outside the repository, for example `~/.config/timekeeper-backups/timekeeper-resend.key`; protect it with `chmod 600`. Do not pass the key itself as a terminal argument or commit it.
4. In the terminal used to start your local app:

```sh
export BACKUP_ALERTS_ENABLED=true
export RESEND_API_KEY_FILE="$HOME/.config/timekeeper-backups/timekeeper-resend.key"
export EMAIL_FROM="backup@alerts.vtcsquared.com"
export BACKUP_ALERT_TO="blake.ketterl@vtcsquared.com"
npm start
```

The prior backup variables must still be configured, including `BACKUP_ENABLED=true`, the backup key file, test R2 credentials file, and `BACKUP_OPERATOR_EMAILS` with your local admin login. Alerts require backups and an off-site destination. Keep Google and R2 credentials mutually exclusive. No live email is sent by automated tests; they inject a simulated sender.

5. Open local Settings → Server recovery backups. Confirm **Email alerts enabled**.
6. With the designated backup operator account, click **Send test backup alert**, enter your local Timekeeper login password, and confirm. Only a configured operator who is an admin can send tests; other admins and employees cannot. The recipient and message are fixed by the server. Rate limit: one test per minute, plus existing authentication attempt limits.
7. Confirm the test email reaches the intended inbox (check spam and Resend delivery logs). This verifies email delivery; it does not create a backup or prove that a backup can be restored.

Automated coverage simulates failure, 48-hour overdue status, provider failures/retries, restarts, deduplication, recovery, disk-write failure, and endpoint permissions without contacting Resend or changing production data. Avoid deliberately breaking production backups to test alerts.

## Render configuration after release approval

In the **existing** Render Timekeeper service → Environment → Secret Files, add:

- Filename: `timekeeper-resend.key`
- Contents: only your Resend API key, no JSON or quotation marks.

Add these variables:

| Key | Value |
| --- | --- |
| `BACKUP_ALERTS_ENABLED` | `true` |
| `RESEND_API_KEY_FILE` | `/etc/secrets/timekeeper-resend.key` |
| `EMAIL_FROM` | `backup@alerts.vtcsquared.com` |
| `BACKUP_ALERT_TO` | `blake.ketterl@vtcsquared.com` |

Alternatively use `RESEND_API_KEY` with the actual key value instead of `RESEND_API_KEY_FILE`; never set both. Keep the existing R2 credentials, backup encryption key, `DATA_DIR`, and backup interval/retention variables unchanged. A stale threshold of 48 hours is fixed for this version, regardless of the configured backup interval.

Save without deployment if possible until the user approves the code release to `main`. After release, Render's build command must be `npm ci && npm test`, and its start command `npm start`. The integration test strips all inherited backup and email configuration; production credentials must never be used by tests.

Once deployment is Live, sign into the hosted app as the configured backup operator and use **Send test backup alert**. Confirm actual receipt and a recent off-site backup timestamp. The status shows the last email accepted by the provider, not confirmed inbox delivery.

To disable alert emails, set `BACKUP_ALERTS_ENABLED=false` and restart/redeploy. Existing encrypted backups continue. To rotate the key, update the secret file and restart; never expose it in logs or screenshots. No database schema migration is needed. Password reset and invitation email delivery are separate future work.
