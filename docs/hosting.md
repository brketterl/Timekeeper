# Host Timekeeper on Render

This deploys one Node service with a persistent SQLite disk. Render provides a public HTTPS address; a custom domain is optional. This requires a paid web service and persistent disk. Review the current charges in Render before creating resources. The free service's temporary filesystem is not suitable for this database.

## Create the service

1. Sign in at <https://dashboard.render.com/> and connect the GitHub account that can access `brketterl/Timekeeper`.
2. Choose **New → Blueprint**, select the Timekeeper repository and its `main` branch. Render reads `render.yaml` from the repository root.
3. Review the proposed **Starter web service**, **one instance**, and **1 GB persistent disk**. Confirm the displayed charges before creating the Blueprint.
4. Wait for the build (`npm test`) and deployment (`npm start`) to finish. Open the service's HTTPS address from Render.

No API keys or email provider are needed. The service uses Render's `RENDER_EXTERNAL_URL` as the application origin and sets Secure session cookies. Do not set `APP_ORIGIN` unless using a custom domain; if you do, use the exact HTTPS origin, without a path. With a custom domain, access the app through that domain because writes from a different origin are rejected.

The repository sets Node.js 24.22.1, `NODE_ENV=production`, `HOST=0.0.0.0`, and `DATA_DIR=/var/data/timekeeper`. Render supplies `PORT`; the server must use it. SQLite files, including WAL files, live under the attached `/var/data` disk. Do not move them into the application checkout or change the disk mount after creating accounts. Do not increase the instance count while using this SQLite layout.

If the Blueprint flow is unavailable, create a **Node web service** from the same repository and copy the build/start commands and variables above. Attach a persistent disk mounted at `/var/data` before creating accounts, and set the health check path to `/health`.

## Set up the shared workspace

A new Render disk starts empty. Your Mac's `.data` database, existing accounts, and browser data are not uploaded by GitHub or deployment.

If starting fresh online:

1. Create your admin account using the hosted HTTPS address.
2. Configure your business, contracts, and employee records.
3. Open **Team → Workspace access**, create **Admin** invitations for partners and **Employee** invitations for staff, and share the links manually or enable account email to send them automatically.
4. Have invitees join using the exact email on their invitation. They should use the invitation rather than register a separate workspace.

If you want to retain existing accounts or work from your Mac, stop before creating hosted accounts and arrange a database transfer. Stop the local app and back up the entire `.data` directory. Transfer a consistent database backup securely using Render's authenticated SSH/SCP access, following the service-specific connection instructions in its dashboard. The destination database must be `/var/data/timekeeper/timekeeper.sqlite`. Do not overwrite an existing hosted database or copy files into a running database: back up the destination first and perform any replacement with the application stopped. Restart the service after transfer so migrations run before requests are accepted. Keep the local backup and do not put database files or connection credentials in GitHub or chat.

JSON workspace exports do not transfer account passwords, memberships, or invitations. A full database transfer is the appropriate option for preserving existing accounts. Restoring a JSON backup also requires retaining the employee records linked to the destination's accounts.

## Verify before sharing

- `/health` returns `{"status":"ok"}` and the login screen loads at the HTTPS address.
- Registration/login work, and business settings survive a page reload.
- After a service restart, those settings and accounts remain available.
- Test an admin invitation and an employee invitation using separate browser profiles. Admins share the workspace; employees see only their own timesheets and assigned contracts.
- Invitation links begin with the public HTTPS address, not your Mac's local address.

Code preparation and local integration tests do not prove this deployment works. Complete these checks against the live service after Render creates it.

## Updates and backups

Use [the staging and release workflow](releases.md) for later updates. Keep production on `main` with auto-deploy **Off**, test changes on a separate staging service, then manually deploy the approved `main` commit after review. These dashboard settings must be applied to an existing service; documentation alone does not enable them. Builds run backend tests before starting the new code. A single SQLite service with a disk can have a short interruption during deployments. Database files remain on the disk; application code comes from GitHub.

Before changing production data or deploying a database migration, make a restorable database backup. [Database recovery backups](backups.md) provides encrypted snapshots, restore verification, scheduling within the existing service, and optional uploads to Google Drive. Configure the encryption key and destination separately; deployment alone does not activate backups. Keep protected copies outside the hosting disk. Workspace JSON exports are useful additional copies but do not back up accounts.

Password reset and invitation emails are available through the optional [account email configuration](account-email.md). Email verification and payment processing are not implemented. Hosting alone does not enable email delivery.
