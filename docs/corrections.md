# Delete drafts and correct financial records

On Timesheets, Remove deletes a draft row after confirmation. The Undo button restores the row, including its hours and note, for ten seconds. Undo is local to that browser session and can be blocked if subsequent edits would exceed the daily hours limit. An empty timesheet has a Delete empty timesheet action; employees can delete only their own empty sheets.

On Contracts, Manage offers Archive contract or Restore contract. Archived contracts are hidden by default; enable Show archived contracts to find them. Archiving keeps assignments and history, but prevents new entries. A contract without timesheet or invoice history can be deleted, which also removes its assignments.

Unsent invoices can be deleted. Sent invoices must be voided instead: enter a reason, reverse any recorded payment entries first, then void. The invoice number and original snapshot remain in history; its balance becomes zero, and its source hours become available for correction or rebilling. Printing a voided invoice labels it VOIDED. A Voided filter is available in Invoices.

Reverse payment entry keeps the original amount, date, and reference, adds a dated reason, and excludes that entry from paid totals. Record the corrected payment as a new entry. This is a bookkeeping correction: it does not issue a refund or contact a bank or client. Voiding and reversing are admin actions, with server-derived actor details in Activity. Corrections cannot be undone or overwritten; use a new invoice or payment entry if needed.

Government invoices must be voided newest first within each task order. Later active invoices retain their frozen cumulative totals. Replacement invoices use a new number and exclude voided invoices from cumulative calculations.

Workspace backup restore, Start an empty workspace, and Reload sample workspace remain explicit whole-workspace replacements after confirmation; ordinary edits cannot delete sent invoices or rewrite recorded payments. Export a backup before replacing a workspace.

## Release and rollback

No SQLite schema migration is required. Voids and reversals add optional fields to the existing workspace JSON. Older code does not understand those fields and may calculate incorrect balances or reject backups after corrected payments. After using these actions, rolling back to an older application version requires a compatible fix or restoring a verified backup from before the corrections (which loses later writes). Keep a restorable production backup before releasing and do not deploy older code against corrected data.
