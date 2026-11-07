# Development and releases

- Use the existing checkout. Do not create Git worktrees unless the user requests one.
- Production auto-deploys from `main`; keep this enabled per the user. Hosted staging is https://timekeeper-staging-43o7.onrender.com and auto-deploys from `staging`.
- `main` is production. Do not push directly to `main` or merge a production pull request without the user's explicit authorization for that release.
- Develop on a feature branch or `staging`. Run `npm test` and relevant browser checks before pushing. Push reviewable changes to `staging`; never treat a staging push as a production release.
- Run browser checks with `npm ci`, `npx playwright install chromium`, then `npm run test:e2e`. Use isolated test data; do not run mutation tests against production.
- After pushing staging, report the changes and checks and provide the hosted Render staging URL and deployed commit for user review before releasing to `main`. The user prefers hosted staging; do not require local VS Code validation. If PR tools are unavailable, provide a GitHub compare link and identify the remaining manual step.
- Keep staging and production database disks separate. Never copy production account data into tests or commit database files, credentials, or invitation links.
- Before a database migration is released, require a restorable production database backup and explain any rollback limitations. Reverting code does not reverse database migrations.
- GitHub branch protection and Render deployment settings must be verified separately. Configuration files and documentation alone do not prove either is enabled.
