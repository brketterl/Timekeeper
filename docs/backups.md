# Database recovery backups

This feature is developed on `staging`. Test it locally before approving release to `main`. It does not enable backups in your existing Render service until you configure it there. There is no new Render instance or cron service.

## What is protected

- SQLite's online backup API captures a consistent database, including committed WAL data, while the app runs.
- Recovery archives include every hosted workspace, user/password hash, membership, contract, timesheet, invoice, and payment. They are not workspace JSON exports.
- Archives use AES-256-GCM with a random nonce and an authenticated metadata header. Every new archive is decrypted again and checked for database integrity, foreign-key errors, valid workspace data, and account/employee links before it is retained.
- Defaults: one backup every 24 hours, seven verified local copies, and seven Google Drive copies when Drive is configured. This is a latest-seven-copies policy, not guaranteed seven days of history: manual backups also count. Only files created and marked by this application are eligible for cleanup. Drive cleanup permanently deletes older managed copies after a verified replacement upload; unrelated files are left alone.
- Failed Google uploads retry after 15 minutes. Retries reuse the verified pending local snapshot during the current backup interval to avoid filling the disk with duplicates. The Settings panel shows failures and separate local/Google timestamps.
- Restore clears all sessions and revokes pending invitations so old access links are not revived. People sign in again with their backed-up email/password. Existing accepted memberships are preserved.

Backups protect data only up to their capture time. A daily schedule can lose up to approximately a day of changes after a disaster, or more if backups are failing. Check the latest successful timestamps. Disk-only copies do not protect against losing the disk; Google Drive or downloaded off-site copies are needed. The existing persistent disk must have room for the source database, retained full copies, and temporary snapshot/encryption files.

## 1. Generate and save an encryption key on your Mac

From the checked-out `staging` folder:

```sh
npm run backup:keygen -- "$HOME/.config/timekeeper-backups/timekeeper.backup.key"
```

This writes a private key file and refuses to overwrite an existing one. Save another protected copy in your password manager or another secure place. Keep the key separately from the backup archives. Without this key the archives cannot be decrypted, and neither Google nor the application can recover it. Do not put it in GitHub or chat.

For local testing, select the key file using:

```sh
export BACKUP_KEY_FILE="$HOME/.config/timekeeper-backups/timekeeper.backup.key"
```

The file contains the actual base64 key; never use the filename as `BACKUP_ENCRYPTION_KEY`. Use either the key-file variable or the key-value variable, not both. Key rotation requires retaining old keys for archives created with those keys.

## 2. Connect Google Drive / Google One

This integration uses Google Drive storage, not a Google Cloud Storage bucket. It uses your existing Drive quota; check available capacity. It does not require another Render service. Google OAuth configuration is needed for unattended uploads.

1. In your Google Cloud project, enable **Google Drive API**.
2. Configure the Google Auth Platform/OAuth consent screen for your own account. Create an OAuth client of type **Desktop app** and download its client JSON into a private folder outside the repository.
3. The setup tool requests only `drive.file`, so it can manage the backup folder/files it creates rather than your entire Drive. If your OAuth app is in **Testing**, refresh tokens for these scopes can expire after seven days. Use an appropriate **Production** publishing status for reliable unattended backups; follow Google's account/organization consent policies. Do not assume a Testing-mode grant will run indefinitely.
4. Run this on your Mac, substituting the actual private client-file path:

```sh
npm run backup:google-setup -- \
  "$HOME/.config/timekeeper-backups/google-desktop-client.json" \
  "$HOME/.config/timekeeper-backups/timekeeper-google-backup.json"
```

5. Open the printed authorization URL in a browser on the same Mac, sign in to your Google account, and grant the requested access. The tool uses an OAuth state check and PKCE, listens on a temporary loopback port, creates a private **Timekeeper recovery backups** folder in Drive, and writes the refresh credentials into the private output file. It refuses to overwrite that file. No credentials are printed.

Do not paste either credentials file into chat or commit it. A live Google connection has to be tested with your own account; automated tests use a simulated Google API and cannot establish real Drive access, token lifetime, or available quota.

## 3. Test locally before release

Using your local test database:

```sh
export GOOGLE_BACKUP_CREDENTIALS_FILE="$HOME/.config/timekeeper-backups/timekeeper-google-backup.json"
export BACKUP_ENABLED=true
export BACKUP_OPERATOR_EMAILS="your-local-admin-email@example.com"
npm start
```

Replace the example email with your local admin's actual login email. You can omit the Google credentials variable initially to test local archives and downloads only. In Settings, check **Server recovery backups**. The configured operator can choose **Create and download encrypted recovery copy** and confirm their current password. Because recovery copies include all workspaces, other workspace admins do not automatically have download access. `BACKUP_OPERATOR_EMAILS` is a server-operator allowlist; update it if that operator changes their login email.

Save a downloaded `.tkbackup` to your Mac and verify it:

```sh
npm run backup:verify -- "/path/to/downloaded.tkbackup"
npm run backup:restore -- "/path/to/downloaded.tkbackup" "$HOME/Documents/Timekeeper-restore-check"
```

The destination must not exist, even if it is empty. The tool never overwrites a running or existing database. Start a second local process pointed at the restored directory, on a different port:

```sh
DATA_DIR="$HOME/Documents/Timekeeper-restore-check" PORT=3002 npm start
```

Sign in locally and confirm the expected accounts, access permissions, hours, invoices, and payments. Stop this recovery-check process afterward. It is a test copy, not a source for new business entries. Use a fresh destination path for another restore check.

Other operator commands:

```sh
npm run backup:create
npm run backup:list
```

`backup:create` creates a verified encrypted local archive without uploading or pruning; this is useful for an explicit pre-release copy. The scheduled service handles Google uploads and retention. Archives and keys must remain outside Git. Local download copies may also be stored in a Google Drive-synced folder on your Mac.

## 4. Enable on the existing Render service after release approval

After testing, approve the code release through the normal local-test/manual-deploy workflow. In Render's existing service, add two **Secret Files**:

- `timekeeper-backup.key`: contents of your encryption key file.
- `timekeeper-google-backup.json`: contents of the Google credential file generated above.

Add these environment variables:

| Key | Value |
| --- | --- |
| `BACKUP_ENABLED` | `true` |
| `BACKUP_KEY_FILE` | `/etc/secrets/timekeeper-backup.key` |
| `GOOGLE_BACKUP_CREDENTIALS_FILE` | `/etc/secrets/timekeeper-google-backup.json` |
| `BACKUP_OPERATOR_EMAILS` | Your hosted admin login email; optional comma-separated additional server operators |
| `BACKUP_INTERVAL_HOURS` | `24` (default; allowed 1–168) |
| `BACKUP_RETAIN` | `7` (default; allowed 1–30) |

Keep `DATA_DIR=/var/data/timekeeper`. The default archive directory is `/var/data/timekeeper/backups`, on the existing disk. `BACKUP_DIR` can override it, but it must still be on persistent storage. Never configure the backup directory as a web-served directory. Existing production data and schema are unchanged by installing this feature.

Alternatively, supply the key value through `BACKUP_ENCRYPTION_KEY`, and Google fields through `GOOGLE_BACKUP_CLIENT_ID`, `GOOGLE_BACKUP_CLIENT_SECRET`, `GOOGLE_BACKUP_REFRESH_TOKEN`, and `GOOGLE_BACKUP_FOLDER_ID`. Use Render's secure configuration, not source files or command-line arguments. The Secret File approach avoids manually splitting credential fields.

Deploy/restart the existing service. It takes a snapshot on first start, then follows the interval. After restarts it verifies its checkpoint and last archive before deciding whether another backup is due. A new encryption key or Google destination triggers a fresh copy. The scheduler runs only while the service is running; it catches up on startup if overdue.

## 5. Verify actual off-site recovery

1. In Settings, confirm a recent local backup and Google upload timestamp, with no error.
2. In Google Drive, confirm a `.tkbackup` exists in the dedicated folder. Upload size and the Drive-provided checksum are checked before older copies are pruned.
3. Download that copy from Drive to your Mac. Run `backup:verify` and restore it into a new local directory using the commands above.
4. Sign in to the recovered local copy and check its data. Record the date of this restore check. Repeat periodically and before relying on a new key or destination.

Google authentication, permissions, network failures, a full Drive quota, or a full Render disk can stop new backups. The app keeps serving requests and shows an error; older verified copies are preserved if a new archive cannot be verified. Logs identify backup failure codes without printing encryption keys or OAuth credentials. Check Settings regularly; this version has no email/SMS failure alerts.

## Disaster recovery / rollback

Use the same encryption key and a trusted archive. Restore into a **new** directory on persistent storage, never over the live database. Confirm recovered accounts/data first, then arrange a maintenance window and change Render's `DATA_DIR` to the recovered directory and restart. Stop new business writes during the cutover; entries created after the chosen backup are not in it. Keep the previous database and disk until recovery is verified. A production restore replaces the entire instance's database, including every workspace; it is a server-operator action, not a normal workspace admin action.

Do not copy the main live SQLite file by itself. Do not restore only part of an archive. Restore drops old sessions and revokes unaccepted invitations, so users sign in again and admins issue new invitations when needed. The backup tool currently accepts schema version 2; future database migrations must update and test the recovery format before release.
