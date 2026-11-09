# Delete drafts and correct financial records

On Timesheets, Remove deletes a draft row after confirmation. The Undo button restores the row, including its hours and note, for ten seconds. Undo is local to that browser session and can be blocked if subsequent edits would exceed the daily hours limit. An empty timesheet has a Delete empty timesheet action; employees can delete only their own empty sheets.

On Contracts, Manage offers Archive contract or Restore contract. Archived contracts are hidden by default; enable Show archived contracts to find them. Archiving keeps assignments and history, but prevents new entries. A contract without timesheet or invoice history can be deleted, which also removes its assignments.

Unsent invoices can be deleted. Sent invoices must be voided instead: enter a reason, reverse any recorded payment entries first, then void. The invoice number and original snapshot remain in history; its balance becomes zero, and its source hours become available for correction or rebilling. Printing a voided invoice labels it VOIDED. A Voided filter is available in Invoices.

Reverse payment entry keeps the original amount, date, and reference, adds a dated reason, and excludes that entry from paid totals. Record the corrected payment as a new entry. This is a bookkeeping correction: it does not issue a refund or contact a bank or client. Voiding and reversing are admin actions, with server-derived actor details in Activity. Corrections cannot be undone or overwritten; use a new invoice or payment entry if needed.

Government invoices must be voided newest first within each task order. Later active invoices retain their frozen cumulative totals. Replacement invoices use a new number and exclude voided invoices from cumulative calculations.

Workspace backup restore, Start an empty workspace, and Reload sample workspace remain explicit whole-workspace replacements after confirmation; ordinary edits cannot delete sent invoices or rewrite recorded payments. Export a backup before replacing a workspace.

## Release and rollback

No SQLite schema migration is required. Voids and reversals add optional fields to the existing workspace JSON. Older code does not understand those fields and may calculate incorrect balances or reject backups after corrected payments. After using these actions, rolling back to an older application version requires a compatible fix or restoring a verified backup from before the corrections (which loses later writes). Keep a restorable production backup before releasing and do not deploy older code against corrected data.

## Return hours with feedback

An admin returning submitted hours or reopening approved, uninvoiced hours must enter a correction reason (up to 500 characters). The dialog lists the affected rows; a bulk return applies the same reason to each listed row. Existing draft rows and invoiced rows are unaffected.

Employees see the latest reason beside the affected row. Earlier feedback remains available under Earlier feedback. Work notes remain separate and editable while the row is draft. Reviewer feedback remains visible through resubmission and approval; employees cannot edit the reviewer feedback field. Deleting an entire draft row removes it from the timesheet display; the original reviewer feedback remains in admin Activity. Activity records each reason with the server-derived reviewer identity and timestamp. These actions do not add return-for-changes emails; existing submission and approval emails continue unchanged.

Existing timesheets need no migration. Feedback is an optional append-only row field preserved in workspace exports and restores. Older clients that do not understand feedback must be upgraded before editing affected records.

## Approval queue

Admins can open Approvals to find submitted rows across all timesheet periods, including mixed-status sheets and inactive employees. Entries are ordered by period (oldest first), and show submitted hours only, rather than the full timesheet total. Search by employee or period; Review refreshes the workspace and opens the exact employee and period. Back to approvals returns to the queue. Approval, return for changes, or employee withdrawal removes the corresponding submitted rows from the queue. Refresh approvals fetches current workspace data.

The waiting age uses server-recorded submission events for the currently submitted rows. New row submissions do not reset the age of older rows still waiting on the same timesheet. Missing dates on older records or restored submissions display Not recorded; no historical timestamp is invented. This adds row IDs to new submission audit events without a database migration. The queue is admin-only and stays within the active workspace. On mobile, each entry displays as a card with its Review action visible.

## Select standard invoice entries and edit drafts

Create invoice opens on the most recent period with eligible approved rows. Select a Billing period, or choose All available periods to select across periods. Check the entries to include; each shows the employee, period, hours, amount, and work note. Only checked rows are billed. Changing the period resets the selection to that period; Clear selection starts over. The selected total stays visible beside Create draft. Unchecked entries remain available for later invoices, and active invoice sources cannot be selected again.

On an unsent standard invoice, Edit draft can change its selected entries, invoice and due dates, bill-to name/email/address, and invoice note. Cancel discards the edit. Saving retains the invoice ID, number, original business details, and unchanged source lines. Removing an entry releases it for later billing. Sent and voided invoices remain locked; use the correction workflow instead. Government invoices retain their monthly task-order workflow and frozen snapshots; unsent government drafts can still be deleted and recreated.

No database migration or new invoice data fields are required for entry selection or standard draft editing.

## Mobile time entry and navigation

At widths up to 900 pixels, Timesheets defaults to Day view. Use the date picker or previous/next-day buttons to enter hours across contracts for a single day. The day total updates while the period total remains visible; expand the period summary for billing value and CSV export on admin accounts. Choose Grid view for the full period grid, or Day view on desktop. The view choice lasts for the current browser tab; a reload uses the screen-size default.

Changing views or rotating the device keeps recorded hours. The same quarter-hour increments, 24-hour combined daily limit, task-order date rules, and submitted/approved locks apply. Work notes cover the entire contract row for the period. Submit draft hours submits all draft rows in the period, including other dates; it is not a one-day submission.

Menu opens labeled navigation and account actions on small screens, and closes after choosing a page or pressing Escape. Employees see their permitted Timesheets and Contracts pages. All these changes use the existing workspace data and require no database migration.


## Staging trial: whole timesheets

Submission, withdrawal, approval, and return now cover every row in the semi-monthly period. Submitted and approved sheets cannot accept additional rows or edits. An admin can return an unbilled sheet with a required reason; existing row feedback is retained. The UI shows returned drafts as Returned until resubmission. Billing can still select approved hours by contract or task order.

Legacy mixed-status sheets remain readable and retain their billing sources. An admin must return all rows together before further editing. A sheet containing invoiced hours cannot be reopened; its records remain available for review. Restoring a workspace backup preserves historical mixed states rather than rewriting them.

For review on staging, try two contracts in one period: submit, withdraw, resubmit, return with feedback, correct hours, resubmit, and approve. Check both day and grid views and confirm every entry locks together. No database schema migration is needed for this trial.
