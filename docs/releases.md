# Test changes before production

`main` is the released source. `staging` is the test branch. A staging push does not change `main`, and must not trigger a production deployment. If a hosted staging service is used, it must have its own SQLite disk, separate from production.

Use a separate hosted Render staging service for user review. Push tested changes to `staging`, wait for that commit to deploy, and review the staging URL before approving a release to `main`. Local VS Code validation is optional, not a release requirement. Record the reviewed commit before approving a release. Do not test mutations against the production service or copy the production database into automated tests.

## One-time dashboard settings

These must be applied in GitHub and Render. Committing configuration or opening a PR does not apply settings to an existing manually created service.

### Production Render service

1. Open the existing production service for `timekeeper-sbzu.onrender.com`.
2. Keep **Auto-Deploy → On Commit** enabled and its branch set to **main**, as requested by the user.
3. Keep its existing persistent disk, mount, and `DATA_DIR` unchanged. Do not create a replacement production service or delete its disk.
4. Merging approved changes into `main` automatically deploys production. Record the resulting deployed commit for reference.

The release approval boundary is the merge into `main`; obtain user approval before merging or pushing production changes.

### Staging Render service

Create a new, separate Node Web Service connected to the same GitHub repository:

| Setting | Value |
| --- | --- |
| Name | `timekeeper-staging` |
| Branch | `staging` |
| Build command | `npm ci && npm test` |
| Start command | `npm start` |
| Instance type | Starter |
| Auto-Deploy | On Commit |
| Health check | `/health` |
| `NODE_VERSION` | `24.22.1` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `DATA_DIR` | `/var/data/timekeeper-staging` |
| New persistent disk | 1 GB mounted at `/var/data` |

Render supplies `PORT` and `RENDER_EXTERNAL_URL`. Do not copy production's `APP_ORIGIN`; staging must use its own HTTPS origin. `render.staging.yaml` provides the same configuration if a separate Blueprint with a custom file path is preferred.

Staging requires another paid service and disk; review the charges before creating them. The identical `/var/data` mount path is safe because these are separate services with separate disks. Never attach, upload, or restore the production database to staging. Create dummy accounts and use sample data. The staging database is not promoted to production; only code is released.

Staging URL: <https://timekeeper-staging-43o7.onrender.com>

### Initialize and verify hosted staging

1. Check for an existing staging service before creating another. Confirm its repository is `brketterl/Timekeeper`, branch is `staging`, and its disk is separate from production. Record its HTTPS URL and deployed commit.
2. For a fresh, empty staging database only, temporarily set `ALLOW_PUBLIC_REGISTRATION=true` in the staging service environment and redeploy. Create your test admin account at the staging URL. Then remove the variable or set it to `false`, redeploy, and confirm **Create an account** is no longer offered to an unauthenticated visitor. Do not enable public registration on production.
3. Sign in to staging and use **Settings → Reload sample workspace**. Create invitations for any additional test users; use separate admin and employee accounts to review permissions. Do not restore production data or copy production email, backup, or storage credentials. Outbound email integrations can stay disabled for initial workflow review.
4. Verify `/health`, sign-in, sample timesheet editing, and a save/reload. After a staging redeploy, confirm the test account and saved records persist on its disk.
5. Confirm staging deploys from `staging` and production still uses `main` with auto-deploy on. Dashboard verification is required; these files alone do not establish either setting.

The review cycle is: automated checks → push to `staging` → hosted staging review → explicit release approval → merge to `main` → automatic production deploy. Only code moves between environments; staging accounts and data stay in staging.

### Protect main in GitHub

In the repository, open **Settings → Rules → Rulesets** and create an active branch ruleset targeting `main` (or use the branch protection settings available to your account):

- Require a pull request before merging.
- Require successful status checks. After the first run, select **backend (test)**, **backend (production)**, and **Browser smoke tests** from the actual check names shown by GitHub.
- Require the branch to be up to date before merging.
- Block force pushes and branch deletion; apply rules to administrators and avoid bypass actors.
- If a second GitHub collaborator can review, require one approval and dismiss stale approvals when new commits are pushed. PR authors cannot approve their own PRs.

If GitHub does not offer enforcement for the repository's visibility and plan, use the PR process and require explicit user release approval before merging into `main`; production auto-deploy stays enabled. Do not describe branch protection as enabled until the settings are saved and verified.

## Development cycle

1. Start from up-to-date `staging` or create a feature branch from it. Keep changes out of `main`.
2. Install the locked test tools with `npm ci`. For browser tests, run `npx playwright install chromium` once on the development machine.
3. Run `npm test` and `npm run test:e2e`. Add checks for the changed behavior when needed. Browser tests always start a private server with a new temporary database; they never use the developer or production `DATA_DIR`.
4. Push the change to `staging`, or open a feature PR targeting `staging` and merge after checks pass. GitHub runs the backend suite in test and production modes plus Chromium browser tests.
5. Wait for the exact tested commit to deploy to the hosted staging service. Review its URL using fake records and the appropriate admin/employee roles. Local testing is optional; user review happens on hosted staging.
6. Record the tested commit and ask the user to approve the concrete result. New commits require checks and review again.
7. Open a PR from `staging` into `main`. For this repository, the compare page is <https://github.com/brketterl/Timekeeper/compare/main...staging?expand=1>. Review the final diff and required checks. Merge only after the user authorizes that release.
8. Before merging a release with a data migration, back up the production database. After the approved merge into `main`, monitor the automatic Render deployment, then check `/health`, login, and the changed behavior on production.
9. Merge the released `main` back into `staging` if the PR merge/squash/rebase created different history, so later releases do not reintroduce old changes.

GitHub Actions failures include a browser report artifact for troubleshooting. Automated checks reduce regressions; they do not replace testing the staged change or checking production after release.

## Rollback

Record the previously deployed production commit before release. If only code changed, manually redeploy that commit and verify the app. Database migrations or data writes are not undone by reverting code. A schema-changing release needs a specific recovery plan and a verified database backup before it is approved.

## Authorized one-way business-data refresh

For manual staging review with real business records, use production **Settings → Export workspace backup**, then staging **Settings → Refresh staging from production export**. This copies only the exported workspace document, not the production SQLite database, users, password hashes, sessions, invitations, notification queues, audit log, environment variables, or provider credentials. Do not commit the export or use it in automated tests.

The tool requires `STAGING_DATA_REFRESH_ENABLED=true` and the exact hosted staging origin. Production remains disabled. On the existing manually configured Render staging service, keep `AUTH_EMAIL_ENABLED=false`, `TIMESHEET_EMAIL_ENABLED=false`, `BACKUP_ALERTS_ENABLED=false`, and `BACKUP_ENABLED=false`. Existing integration secrets are left untouched and unused. Startup refuses the refresh feature alongside outgoing account/timesheet email or external backup integrations. Do not enable these flags on production. These are explicit service overrides; the separate sample staging Blueprint does not enable the tool automatically.

The operator chooses the production workspace JSON file and reviews the record counts before replacement. A JSON backup of the old staging workspace is written privately to `DATA_DIR/staging-refresh-backups` before the transaction writes the replacement; a backup download is also initiated in the browser. A backup failure aborts the refresh. Keep downloaded exports private and remove local copies when no longer needed. These local staging backups are not automatically uploaded or pruned; retain the needed rollback copy and manage disk space before repeated refreshes. Restore the saved staging JSON using the ordinary Restore from backup action if necessary.

Linked staging employees are preserved by matching email and retaining staging employee IDs. Production employees without a linked staging account receive new employee IDs; timesheets, contract category assignments, and government invoice references are remapped together. Linked test accounts absent from the production export are kept active with no assigned contracts. Matching linked test accounts stay active so sign-in continues. Production names, hours, rates, invoice numbers, payment history, and billing snapshots are retained; authentication accounts and credentials are never imported.

This is a manual snapshot, not a background sync. Later staging edits never update production, and later production edits require another explicit refresh. The source export comes from the browser's saved workspace view; ensure production has no unsaved edits, reload its latest server copy, then export.
