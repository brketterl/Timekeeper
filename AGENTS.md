# Development and releases

- Use the existing checkout. Do not create Git worktrees unless the user requests one.
- `main` is production. Do not push directly to `main` or merge a production pull request without the user's explicit authorization for that release.
- Develop on a feature branch or `staging`. Run `npm test` and relevant browser checks before pushing. Push reviewable changes to `staging`; never treat a staging push as a production release.
- Run browser checks with `npm ci`, `npx playwright install chromium`, then `npm run test:e2e`. Use isolated test data; do not run mutation tests against production.
- After pushing staging, report the changes and checks. Have the user verify the staging deployment before creating/merging the release to `main`. If PR tools are unavailable, provide a GitHub compare link and identify the remaining manual step.
- Keep staging and production database disks separate. Never copy production account data into tests or commit database files, credentials, or invitation links.
- Before a database migration is released, require a restorable production database backup and explain any rollback limitations. Reverting code does not reverse database migrations.
- GitHub branch protection and Render deployment settings must be verified separately. Configuration files and documentation alone do not prove either is enabled.
