# Government invoice setup and monthly billing

Developed on `staging`; test locally before approving a release to `main`. Standard invoices remain the default. This adds optional fields inside existing workspace JSON documents, not a new SQLite schema migration or paid service. Updated application/recovery tools are required to understand government metadata and custom invoice numbers.

## 1. Business details and signers

In **Settings**, confirm the legal business name (including DBA if needed), billing email, and address. Under **Invoice signers**, add each permitted printed name and title and save. A signer is selected for each government invoice. Only the name/title are printed; there is no signature image or automatic signing. Add the actual signature after creating the PDF and before sending it yourself.

The certification wording is based on the provided CSS invoice sample. Each invoice snapshots that wording. Review the template with your customer/prime before using it for an actual submission; this is the supplied billing layout, not an assertion of compliance with every government contract's requirements.

## 2. Contract invoice setup

Create or manage a contract and select **Government Invoice**. Saving opens **Invoice setup**; existing contracts also have an Invoice setup button in the Manage contract dialog. Configure:

- Invoice prefix, next number, and number digits. Example: prefix `GOV-`, next number `30`, digits `3` produces `GOV-030`.
- Subcontract/consultant agreement number and program/project name.
- Labor categories and the **rate for each category on this contract**. Rates are not independent employee overrides. Each employee has one assigned category per contract; every assigned employee who will log time needs a category selected in Invoice setup.
- Task/work orders, each with its own number, performance start/end dates, and total funding in USD. The UI/data model supports multiple orders now, even if only one is configured initially.

Use **VTC Standard Invoice** to retain the standard layout. Its default contract rate remains applicable; optional prefix/number settings can also be configured in Invoice setup. Government contract cards show that rates are defined by category rather than showing the unused standard fallback rate.

Set up categories and task orders before entering new government time. If converting a contract with unbilled legacy time, select task orders on those draft rows. Submitted/approved unbilled legacy rows must be withdrawn/reopened before assignment. Time already billed on standard invoices cannot be reassigned silently: government billing is blocked for contracts with standard invoices. Use a separate government contract record and enter its history explicitly if necessary; do not send duplicate historical invoices to the customer.

## 3. Time and historical entry

Time entry still uses semi-monthly sheets. Government rows have a **task-order selector**; multiple rows on the same contract can represent different orders. Dates with positive hours must fall inside the selected order's period of performance. Submission locks the labor-category ID/name, task order, and applicable category rate. Employee API responses omit rates and funding while exposing task-order choices and their own row category label.

To backfill the current contract, work **oldest month first**:

1. Configure the rate that applied to that historical month.
2. Enter the employee's actual hours in both semi-monthly periods as needed, select the order, submit, and approve them.
3. Create that month's government invoice with its original issue/due dates and invoice number.
4. Mark it sent using its original sent date before creating the next month.
5. Repeat chronologically; update the category rate when historical rates change. Already submitted/approved rows keep their locked rate. When finished, set the current category rates and next invoice sequence.

There are no opening-balance shortcuts. Cumulative figures become accurate only after the relevant history has been entered. Creating a later-month invoice before entering earlier history is blocked from correction by backdating another invoice behind it; deleting an unsent later draft lets you enter the earlier months first. Correcting an already-issued sequence needs a deliberate restore/correction process, not a silent recalculation. Credits, voids, and invoice amendments are not implemented by this MVP.

## 4. Create a government invoice

Open **Invoices → Create invoice**, select the contract, then choose:

- Calendar billing month.
- Task/work order.
- Printed signer.
- Invoice number (defaults to the configured sequence; editable for original historical numbers).
- Issue date on or after the last day of that month, and a due date on/after issue date.

The server selects approved, unbilled rows for that exact month/order. All positive-hour rows for that month/order must be approved. The same source row cannot be invoiced twice, and each order permits one invoice per calendar month. Other orders/months are excluded. A prior unsent invoice for that order must be marked sent or deleted before creating another. Historical entries are recorded only; the app does not email invoice PDFs.

Current lines group sources by employee, labor-category ID, and locked rate across both semi-monthly sheets. A category rate change creates separate rate tiers; historical tiers can have zero current hours while retaining cumulative values. Cumulative hours/dollars sum prior sent invoices plus the current invoice for the same contract/order, including the current month once. Payments received do not change funding consumption.

**Remaining funding = task-order funding − cumulative invoiced dollars.** Remaining percentage divides this by the selected order's funding. Billing above funding is blocked; update authorized funding first. A funding amendment affects future invoices, while older snapshots preserve the funding used at issue.

Invoice numbers are unique within the workspace. Automatic numbering advances after creation and does not rewind when a draft is deleted. A manually supplied number sharing the configured prefix advances the counter when it reaches/exceeds the current sequence; an older historical number does not lower it. Changing the counter/prefix manually is an explicit admin configuration action.

## 5. Preview and PDF

Government previews include the yellow highlighted fields, monthly labor table with current/cumulative totals, remaining funding/percentage, certification, signer name/title, and blank signature line. Choose **Print / PDF → Save as PDF**. Enable **Background graphics** in the browser's print options to retain yellow highlighting. Multi-page tables may be needed with many labor/resource/rate combinations; review page breaks before submission. No signature from the sample is copied.

Government drafts capture template version, business/client details, categories/rates, agreement/order details, funding, cumulative totals, certification, and signer text when generated. Contract/settings edits do not rewrite them. To change an unsent government draft, delete and recreate it. Issued invoice financial details cannot be changed or deleted through normal workspace edits; payments can still be recorded. The standard template retains its established behavior. Government financial history has the additional backend snapshot protections described here.

## Backups, imports, and release

Encrypted recovery backups include these fields, and updated tools verify/restore them. Workspace JSON exports include them too. JSON restoration uses an explicit admin-only import action, retains linked account employee records, validates source references and cumulative totals, and records a restore Activity event. Unlike normal edits, this deliberate restore can replace financial history with the chosen backup's contents; review the confirmation and retain a current backup first. Relational audit history is not replaced by a JSON restore.

No new environment variables are required. Test locally with `git switch staging`, `git pull origin staging`, `npm ci`, and `npm start`. Use test accounts/data and test R2 storage, not the production database. Test two historical months, two semi-monthly sheets, a rate change, numbering, a funding amendment, and printing before production approval.

Before releasing, keep a verified production recovery archive and matching encryption key. Reverting to old code can reject custom invoice numbers or ignore billing extensions; use the updated recovery tools or fix forward. A pre-feature database restore loses later changes and requires a maintenance window and new data directory. Government billing does not change the existing account, employee, or workspace access rules.
