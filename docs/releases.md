# Test changes before production

`main` is the released source. `staging` is the test branch. A staging push does not change `main`, and must not trigger a production deployment. Production and staging are separate Render services with separate SQLite disks.

## One-time dashboard settings

These must be applied in GitHub and Render. Committing configuration or opening a PR does not apply settings to an existing manually created service.

### Production Render service

1. Open the existing production service for `timekeeper-sbzu.onrender.com`.
2. Under Settings, change **Auto-Deploy** to **Off**. Keep its branch set to **main**.
3. Keep its existing persistent disk, mount, and `DATA_DIR` unchanged. Do not create a replacement production service or delete its disk.
4. Releases will use **Manual Deploy → Deploy a specific commit**, choosing an approved commit on `main`. Record that commit for reference.

This provides a manual release boundary even before GitHub branch protections are configured.

### Staging Render service

Create a new, separate Node Web Service connected to the same GitHub repository:

| Setting | Value |
| --- | --- |
| Name | `timekeeper-staging` |
| Branch | `staging` |
| Build command | `npm test` |
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

### Protect main in GitHub

In the repository, open **Settings → Rules → Rulesets** and create an active branch ruleset targeting `main` (or use the branch protection settings available to your account):

- Require a pull request before merging.
- Require successful status checks. After the first run, select **backend (test)**, **backend (production)**, and **Browser smoke tests** from the actual check names shown by GitHub.
- Require the branch to be up to date before merging.
- Block force pushes and branch deletion; apply rules to administrators and avoid bypass actors.
- If a second GitHub collaborator can review, require one approval and dismiss stale approvals when new commits are pushed. PR authors cannot approve their own PRs.

If GitHub does not offer enforcement for the repository's visibility and plan, keep production's Render auto-deploy off and use the PR process and manual release boundary. Do not describe branch protection as enabled until the settings are saved and verified.

## Development cycle

1. Start from up-to-date `staging` or create a feature branch from it. Keep changes out of `main`.
2. Install the locked test tools with `npm ci`. For browser tests, run `npx playwright install chromium` once on the development machine.
3. Run `npm test` and `npm run test:e2e`. Add checks for the changed behavior when needed. Browser tests always start a private server with a new temporary database; they never use the developer or production `DATA_DIR`.
4. Push the change to `staging`, or open a feature PR targeting `staging` and merge after checks pass. GitHub runs the backend suite in test and production modes plus Chromium browser tests.
5. Wait for the staging service to deploy the commit. Test the changed behavior at the staging HTTPS URL with fake records, including the appropriate admin/employee roles.
6. Record the tested commit and ask the user to approve the concrete result. New commits require checks and review again.
7. Open a PR from `staging` into `main`. For this repository, the compare page is <https://github.com/brketterl/Timekeeper/compare/main...staging?expand=1>. Review the final diff and required checks. Merge only after the user authorizes that release.
8. Back up the production database before any data migration. Manually deploy the approved `main` commit in Render, then check `/health`, login, and the changed behavior on production.
9. Merge the released `main` back into `staging` if the PR merge/squash/rebase created different history, so later releases do not reintroduce old changes.

GitHub Actions failures include a browser report artifact for troubleshooting. Automated checks reduce regressions; they do not replace testing the staged change or checking production after release.

## Rollback

Record the previously deployed production commit before release. If only code changed, manually redeploy that commit and verify the app. Database migrations or data writes are not undone by reverting code. A schema-changing release needs a specific recovery plan and a verified database backup before it is approved.
