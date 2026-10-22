## Change

Describe the user-visible change and why it is needed.

## Checks

- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes, plus any manual checks specific to this change.
- [ ] No production database, credentials, or invitation links are included.

## Production release (when targeting main)

- [ ] The staging URL and tested commit are recorded below.
- [ ] The user has tested staging and explicitly approved this release.
- [ ] All required GitHub checks pass for the current PR revision.
- [ ] Any database migration has a restorable backup and documented rollback limits.

Staging URL / tested commit:

Validation and remaining limitations:
