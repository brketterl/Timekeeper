## Change

Describe the user-visible change and why it is needed.

## Checks

- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes, plus any manual checks specific to this change.
- [ ] No production database, credentials, or invitation links are included.

## Production release (when targeting main)

- [ ] The local staging review (or optional staging URL) and tested commit are recorded below.
- [ ] The user has reviewed the staging checkout locally (or on a staging service) and explicitly approved this release.
- [ ] All required GitHub checks pass for the current PR revision.
- [ ] Any database migration has a restorable backup and documented rollback limits.

Local review or staging URL / tested commit:

Validation and remaining limitations:
