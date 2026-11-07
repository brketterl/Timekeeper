import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const password = 'automated test password 123';
const email = prefix => `${prefix}-${randomUUID()}@example.test`;
const inboxEmails = async (page, address) => (await page.request.get('http://127.0.0.1:3101/?to=' + encodeURIComponent(address))).json();
const saved = page => expect(page.locator('#save-label')).toHaveText('Saved to server');

async function register(page, name, address) {
  await expect(page.getByRole('button', { name: /^(Create an account|Create account)$/ })).toBeVisible();
  if (!await page.getByLabel('Your name', { exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  }
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
}
async function invite(page, address, role) {
  await page.locator('nav button[title=Team]').click();
  await page.locator('#access-panel input[name=email]').fill(address);
  await page.locator('#access-panel select[name=role]').selectOption(role);
  await page.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  return page.locator('#invite-result input').inputValue();
}

test('employee invitation, restricted time entry, approval, and shared partner access', async ({ page, browser }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const adminEmail = email('admin');
  await register(page, 'Test admin', adminEmail);
  await expect(page.locator('.workspace strong')).toHaveText('Test admin');
  await expect(page.locator('.workspace small')).toHaveText('Admin');
  await expect(page.locator('.workspace .avatar')).toHaveText('TA');
  await expect(page.getByText('Your workspace is saved to your account.', { exact: true })).toHaveCount(0);
  await page.locator('nav button[title=Contracts]').click();
  await page.getByRole('button', { name: 'New contract', exact: true }).first().click();
  await page.locator('#contract-form [name=name]').fill('Shared project');
  await page.locator('#contract-form [name=client]').fill('Test client');
  await page.getByRole('button', { name: 'Save contract', exact: true }).click();
  await saved(page);

  const workerEmail = email('worker');
  await page.locator('nav button[title=Team]').click();
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  await page.locator('#employee-form [name=name]').fill('Test worker');
  await page.locator('#employee-form [name=email]').fill(workerEmail);
  await page.locator('#employee-form [name=contracts]').check();
  await page.getByRole('button', { name: 'Save employee', exact: true }).click();
  await saved(page);

  const workerContext = await browser.newContext();
  const worker = await workerContext.newPage();
  worker.on('pageerror', error => errors.push(error.message));
  await worker.goto(await invite(page, workerEmail, 'employee'));
  await register(worker, 'Test worker', workerEmail);
  await expect(worker.locator('.workspace strong')).toHaveText('Test worker');
  await expect(worker.locator('.workspace small')).toHaveText('Employee');
  await expect(worker.locator('nav button[title=Activity]')).toHaveCount(0);
  await expect(worker.locator('nav button')).toHaveText(['Timesheets', 'Contracts']);
  const employeeData = await (await worker.request.get('http://127.0.0.1:3100/api/workspace')).json();
  expect(employeeData.data.employees).toHaveLength(1);
  expect(employeeData.data.contracts[0]).not.toHaveProperty('rate');
  expect(employeeData.data.invoices).toEqual([]);
  await worker.getByRole('button', { name: 'Add contract', exact: true }).click();
  await worker.getByRole('button', { name: 'Add to timesheet', exact: true }).click();
  await saved(worker);
  await worker.locator('input[type=number]').first().fill('8');
  await worker.locator('input[type=number]').first().press('Tab');
  await saved(worker);
  await worker.getByRole('button', { name: 'Submit draft hours' }).click();
  await saved(worker);
  await expect(worker.getByRole('group', { name: 'Timesheet status by row' })).toHaveText('1 awaiting approval');
  await expect(worker.getByRole('button', { name: 'Withdraw submitted hours', exact: true })).toBeVisible();
  await expect.poll(async () => (await inboxEmails(page, adminEmail)).filter(email => email.subject.includes('submitted for review')).length).toBe(1);
  await worker.getByRole('button', { name: 'Withdraw row', exact: true }).click();
  await worker.getByRole('button', { name: 'Confirm', exact: true }).click();
  await saved(worker);
  await expect(worker.locator('.time-table tbody tr').first().locator('.badge')).toHaveText('Draft');
  await expect(worker.locator('input[type=number]').first()).toBeEnabled();
  await worker.getByRole('button', { name: 'Submit draft hours', exact: true }).click();
  await saved(worker);


  await page.reload();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Return row for changes', exact: true }).click();
  await page.getByLabel('What needs to change?', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Return to draft', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('Explain what needs to change.');
  await page.getByLabel('What needs to change?', { exact: true }).fill('Explain the work performed on the report.');
  await page.getByRole('button', { name: 'Return to draft', exact: true }).click();
  await saved(page);
  await worker.reload();
  await expect(worker.getByRole('note', { name: 'Reviewer feedback' })).toContainText('Explain the work performed on the report.');
  await worker.screenshot({ path: info.outputPath('employee-feedback.png'), fullPage: true });
  await worker.setViewportSize({ width: 390, height: 844 });
  await worker.screenshot({ path: info.outputPath('employee-feedback-mobile.png'), fullPage: true });
  const feedbackBounds=await worker.getByRole('note', { name: 'Reviewer feedback' }).boundingBox();
  expect(feedbackBounds.x+feedbackBounds.width).toBeLessThanOrEqual(390);
  await worker.setViewportSize({ width: 1280, height: 720 });
  await worker.getByRole('button', { name: 'Remove Shared project row', exact: true }).click();
  await worker.getByRole('button', { name: 'Confirm', exact: true }).click();await saved(worker);
  await worker.getByRole('button', { name: 'Undo', exact: true }).click();await saved(worker);
  await expect(worker.getByRole('note', { name: 'Reviewer feedback' })).toContainText('Explain the work performed on the report.');
  await worker.getByRole('button', { name: 'Add note', exact: true }).click();
  await worker.locator('#row-note').fill('Prepared the weekly progress report.');
  await worker.getByRole('button', { name: 'Save note', exact: true }).click();
  await saved(worker);
  await worker.getByRole('button', { name: 'Submit draft hours', exact: true }).click();
  await saved(worker);
  await expect(worker.getByRole('note', { name: 'Reviewer feedback' })).toContainText('Resubmitted');
  await page.reload();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('note', { name: 'Reviewer feedback' })).toContainText('Explain the work performed on the report.');
  await page.getByRole('button', { name: 'Approve submitted hours', exact: true }).click();
  await saved(page);
  await expect.poll(async () => (await inboxEmails(worker, workerEmail)).filter(email => email.subject.includes('hours were approved')).length).toBe(1);
  await worker.reload();
  await expect(worker.locator('input[type=number]').first()).toBeDisabled();
  await expect(worker.getByRole('button', { name: 'Reopen row', exact: true })).toHaveCount(0);
  await expect(worker.getByText('Ask an admin to reopen this row for corrections.', { exact: true })).toBeVisible();
  await expect(worker.getByRole('note', { name: 'Reviewer feedback' })).toContainText('Reviewer feedback history');

  const partnerEmail = email('partner');
  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  partner.on('pageerror', error => errors.push(error.message));
  await partner.goto(await invite(page, partnerEmail, 'admin'));
  await register(partner, 'Test partner', partnerEmail);
  await expect(partner.locator('nav button[title=Activity]')).toBeVisible();
  await partner.locator('nav button[title=Settings]').click();
  await partner.locator('input[name=business]').fill('Shared test business');
  await partner.getByRole('button', { name: 'Save settings', exact: true }).click();
  await saved(partner);
  await page.reload();
  await page.locator('nav button[title=Settings]').click();
  await expect(page.locator('input[name=business]')).toHaveValue('Shared test business');
  await page.locator('nav button[title=Activity]').click();
  const removedFeedback=page.locator('#activity-list article').filter({hasText:'Feedback from removed rows'});
  await removedFeedback.getByText('Feedback from removed rows', {exact:true}).click();
  await expect(removedFeedback).toContainText('Explain the work performed on the report.');
  await expect(page.locator('#activity-list article').filter({hasText:'Returned hours for'}).first()).toContainText('Explain the work performed on the report.');

  expect(errors).toEqual([]);
  await workerContext.close(); await partnerContext.close();
});

test('email correction, unused team deletion, and signing in with the corrected email', async ({ page }) => {
  await page.goto('/');
  const correctedEmail = email('corrected');
  await register(page, 'Email test', email('typo'));
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await page.locator('#account-email-form [name=email]').fill(correctedEmail);
  await page.locator('#account-email-form [name=confirmEmail]').fill(correctedEmail);
  await page.locator('#account-email-form [name=currentPassword]').fill('incorrect');
  await page.getByRole('button', { name: 'Update email', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('Your current password is incorrect.');
  await page.locator('#account-email-form [name=currentPassword]').fill(password);
  await page.getByRole('button', { name: 'Update email', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('nav button[title=Team]').click();
  await expect(page.locator('tbody')).toContainText(correctedEmail);
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  await page.locator('#employee-form [name=name]').fill('Unused record');
  await page.getByRole('button', { name: 'Save employee', exact: true }).click();
  await saved(page);
  await page.locator('tbody tr').filter({ hasText: 'Unused record' }).getByRole('button', { name: 'Remove from team' }).click();
  await expect(page.getByRole('heading', { name: 'Delete this team member?' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'Unused record' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(correctedEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Everything, in good time.' })).toBeVisible();
});

test('configured backup operator downloads an encrypted recovery archive from Settings', async ({ page }, info) => {
  await page.goto('/');
  await register(page, 'Backup operator', `backup-operator-${info.retry}@example.test`);
  await page.locator('nav button[title=Settings]').click();
  await expect(page.locator('#recovery-backups')).toContainText('These copies are on the server disk only.');
  await expect(page.locator('#timesheet-notifications')).toContainText('Submission and approval emails are enabled.');
  await expect(page.locator('#recovery-backups')).toContainText('Email alerts enabled');
  await page.getByRole('button', { name: 'Send test backup alert', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Send test email', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#recovery-backups')).not.toContainText('Last email accepted: None yet');

  await page.getByRole('button', { name: 'Create and download encrypted recovery copy', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Create and download', exact: true }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toMatch(/^timekeeper-.*\.tkbackup$/);
  const stream = await downloaded.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const contents = Buffer.concat(chunks);
  expect(contents.subarray(0, 10).toString()).toBe('TKBACKUP1\n');
  expect(contents.includes(Buffer.from('backup-operator'))).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('emailed invitation and password reset work without losing workspace access', async ({ page, browser }) => {
  const adminEmail = email('mail-admin'), invitedEmail = email('mail-worker');
  await page.goto('/'); await register(page, 'Email admin', adminEmail);
  const invitationLink = await invite(page, invitedEmail, 'employee');
  await expect(page.locator('#invite-result')).toContainText('Invitation email accepted');
  await page.locator('nav button[title=Activity]').click();
  await expect(page.locator('#activity-list')).toContainText('Invited ' + invitedEmail);
  await expect(page.locator('#activity-list')).toContainText('Email admin');
  const invitationEmails = await (await page.request.get('http://127.0.0.1:3101/?to=' + encodeURIComponent(invitedEmail))).json();
  expect(invitationEmails).toHaveLength(1); expect(invitationEmails[0].text).toContain(invitationLink);
  await page.goto(invitationLink);
  await expect(page.getByRole('dialog')).toContainText('You are signed in as');
  await page.getByRole('button', { name: 'Sign out and open invited signup' }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(invitedEmail);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const context = await browser.newContext(), worker = await context.newPage();
  await worker.goto(invitationEmails[0].text.match(/http:\/\/127\.0\.0\.1:3100\/#invite=[a-f0-9]+/)[0]);
  await expect(worker.getByLabel('Your name', { exact: true })).toBeVisible();
  await expect(worker.getByLabel('Email', { exact: true })).toHaveValue(invitedEmail);
  await expect(worker.getByRole('dialog')).toHaveCount(0);
  await register(worker, 'Email worker', invitedEmail);
  await expect(worker.locator('.workspace small')).toHaveText('Employee');
  await worker.getByRole('button', { name: 'Sign out', exact: true }).click();
  await worker.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await worker.getByLabel('Email', { exact: true }).fill(invitedEmail);
  await worker.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await expect(worker.locator('form [role=status]')).toContainText('If an account exists');
  const resetEmails = await (await worker.request.get('http://127.0.0.1:3101/?to=' + encodeURIComponent(invitedEmail))).json();
  const resetLink = resetEmails.find(message => message.subject.includes('Reset')).text.match(/http:\/\/127\.0\.0\.1:3100\/#reset=[a-f0-9]+/)[0];
  await worker.goto(resetLink);
  await expect(worker).toHaveURL('http://127.0.0.1:3100/');
  const newPassword = 'updated browser password 123';
  await worker.getByLabel('New password', { exact: true }).fill(newPassword);
  await worker.getByLabel('Confirm password', { exact: true }).fill('mismatched password');
  await worker.getByRole('button', { name: 'Save new password' }).click();
  await expect(worker.getByRole('alert')).toHaveText('Passwords do not match.');
  await worker.getByLabel('Confirm password', { exact: true }).fill(newPassword);
  await worker.getByRole('button', { name: 'Save new password' }).click();
  await expect(worker.getByRole('alert')).toContainText('Password updated');
  await worker.getByLabel('Email', { exact: true }).fill(invitedEmail);
  await worker.getByLabel('Password', { exact: true }).fill(newPassword);
  await worker.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(worker.locator('.workspace small')).toHaveText('Employee');
  await context.close();
});

test('default sign-in page is invitation-only and direct registration is rejected', async ({ page }) => {
  await page.goto('http://127.0.0.1:3102/');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('Accounts are invitation-only.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account', exact: true })).toHaveCount(0);
  const response = await page.request.post('http://127.0.0.1:3102/api/auth/register', {
    headers: { Origin: 'http://127.0.0.1:3102' }, data: { name: 'Uninvited', email: email('uninvited'), password, role: 'admin' }
  });
  expect(response.status()).toBe(403);
});

test('government invoice setup creates a highlighted monthly PDF with locked cumulative totals', async ({ page }, info) => {
  await page.goto('/'); await register(page, 'Government owner', email('government'));
  await page.locator('nav button[title=Settings]').click();
  await page.getByRole('button', { name: 'Add invoice signer', exact: true }).click();
  await page.locator('#signers-form [name=signerName]').fill('Authorized Signer');
  await page.locator('#signers-form [name=signerTitle]').fill('Partner');
  await page.getByRole('button', { name: 'Save signers', exact: true }).click(); await saved(page);
  await page.locator('nav button[title=Contracts]').click();
  await page.getByRole('button', { name: 'New contract', exact: true }).first().click();
  await page.locator('#contract-form [name=name]').fill('Government services');
  await page.locator('#contract-form [name=client]').fill('Government prime');
  await page.locator('#contract-form [name=invoiceTemplate]').selectOption('government');
  await page.getByRole('button', { name: 'Save contract', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Invoice setup', exact: true })).toBeVisible();
  await page.locator('#billing-form [name=prefix]').fill('C&C-TEST');
  await page.locator('#billing-form [name=nextNumber]').fill('30');
  await page.locator('#billing-form [name=agreementNumber]').fill('AGREEMENT-TEST');
  await page.locator('#billing-form [name=project]').fill('Test program');
  await page.locator('#billing-form [name=categoryName]').fill('RTE II');
  await page.locator('#billing-form [name=categoryRate]').fill('145');
  await page.locator('#billing-form [name=popStart]').fill('2025-05-12');
  await page.locator('#billing-form [name=popEnd]').fill('2030-04-21');
  await page.locator('#billing-form [name=funding]').fill('100000');
  await page.getByRole('button', { name: 'Save invoice setup', exact: true }).click(); await saved(page);
  await page.locator('nav button[title=Timesheets]').click();
  await page.getByRole('button', { name: 'Add contract', exact: true }).click();
  await expect(page.locator('#row-form [name=taskOrderId]')).toBeVisible();
  await page.getByRole('button', { name: 'Add to timesheet', exact: true }).click(); await saved(page);
  const doc=await (await page.request.get('/api/workspace')).json(), c=doc.data.contracts[0], person=doc.data.employees[0], order=c.billing.taskOrders[0], category=c.billing.categories[0];
  for(const [id,start,hours] of [['aug-first','2026-08-01',8],['aug-second','2026-08-16',4]])doc.data.sheets.push({id,employeeId:person.id,start,status:'approved',rows:[{id:'row-'+id,contractId:c.id,status:'approved',note:'',hours:{[start]:hours},rate:category.rate,taskOrderId:order.id,categoryId:category.id,laborCategory:category.name}]});
  const seeded=await page.request.put('/api/workspace',{headers:{Origin:'http://127.0.0.1:3100'},data:{data:doc.data,revision:doc.revision}});expect(seeded.status()).toBe(200);
  await page.reload(); await page.locator('nav button[title=Invoices]').click();
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await page.locator('#invoice-form [name=billingMonth]').fill('2026-08');
  await page.locator('#invoice-form [name=issued]').fill('2026-08-31');
  await page.locator('#invoice-form [name=due]').fill('2026-09-30');
  await page.getByRole('button',{name:'Create draft',exact:true}).click();
  await expect(page.getByRole('heading',{name:'C&C-TEST030',exact:true})).toBeVisible();
  await expect(page.locator('.gov-paper')).toContainText('RTE II');
  await expect(page.locator('.gov-paper')).toContainText('Authorized Signer');
  await expect(page.locator('.gov-paper')).toContainText('$1,740.00');
  await expect(page.locator('.gov-paper')).toContainText('$98,260.00');
  await expect(page.locator('.gov-highlight').first()).toHaveCSS('background-color','rgb(255, 255, 0)');
  await expect(page.locator('.gov-paper img')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('government-invoice-preview.png'),fullPage:true});
  await page.evaluate(()=>{document.getElementById('print-area').innerHTML=document.querySelector('.gov-paper').outerHTML;});
  const pdf=await page.pdf({path:info.outputPath('government-invoice.pdf'),format:'A4',printBackground:true});
  expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length).toBe(1);
  // A future invoice date must not prevent recording its actual send date.
  const future=await (await page.request.get('/api/workspace')).json();
  future.data.invoices[0].issued='2099-11-01';future.data.invoices[0].due='2099-12-01';
  const restored=await page.request.post('/api/workspace/import',{headers:{Origin:'http://127.0.0.1:3100'},data:{data:future.data,revision:future.revision}});
  expect(restored.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('navigation')).toBeVisible();
  await page.evaluate(()=>invoiceDetail(state.invoices[0].id));
  await page.getByRole('button',{name:/^Mark sent/}).click();
  await page.locator('#send-form [name=date]').fill('2026-10-28');
  await page.getByRole('button',{name:'Mark sent',exact:true}).click();await saved(page);
  const sent=await (await page.request.get('/api/workspace')).json();
  expect(sent.data.invoices[0].sentDate).toBe('2026-10-28');

});


test('mixed timesheet statuses remain visible and actions only change their stated rows', async ({ page }, info) => {
  await page.goto('/');
  await register(page, 'Status reviewer', email('statuses'));
  // Fixture lives only in the temporary e2e workspace, with the linked account retained.
  await page.evaluate(() => {
    state = retainAccounts(seed());
    const sheet = state.sheets.find(s => s.id === 's1');
    sheet.rows = ['approved', 'submitted', 'draft'].map((status, index) => ({
      id: 'mixed-row-' + index, contractId: index === 1 ? 'c2' : 'c1',
      rate: index === 1 ? 8500 : 12500, note: '', status, hours: { [sheet.start]: index + 1 }
    }));
    refreshSheet(sheet); save(); render();
  });
  await saved(page);
  const overviewRow = page.locator('tbody tr').filter({ has: page.getByText('You', { exact: true }) });
  await expect(overviewRow.getByRole('group', { name: 'Timesheet status by row' })).toHaveText('1 draft1 awaiting approval1 approved');
  await overviewRow.getByRole('button', { name: 'Review', exact: true }).click();
  const summary = page.getByRole('group', { name: 'Timesheet status by row' });
  const rows = page.locator('.time-table tbody tr');
  await page.screenshot({ path: info.outputPath('mixed-status-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('mixed-status-mobile.png'), fullPage: true });
  const bounds = await summary.boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(rows.nth(0).locator('.badge')).toHaveText('Approved');
  await expect(rows.nth(1).locator('.badge')).toHaveText('Awaiting approval');
  await expect(rows.nth(2).locator('.badge')).toHaveText('Draft');
  await expect(rows.nth(0).locator('input').first()).toBeDisabled();
  await expect(rows.nth(2).locator('input').first()).toBeEnabled();
  await page.getByRole('button', { name: 'Approve submitted hours', exact: true }).click();
  await saved(page);
  await expect(summary).toHaveText('1 draft2 approved');
  await expect(rows.nth(2).locator('.badge')).toHaveText('Draft');
  await page.getByRole('button', { name: 'Submit draft hours', exact: true }).click();
  await saved(page);
  await expect(summary).toHaveText('1 awaiting approval2 approved');
  await page.getByRole('button', { name: 'Return submitted hours for changes', exact: true }).click();
  await page.getByLabel('What needs to change?', { exact: true }).fill('Confirm the project assignment.');
  await page.getByRole('button', { name: 'Return to draft', exact: true }).click();
  await saved(page);
  await expect(summary).toHaveText('1 draft2 approved');
  await page.getByRole('button', { name: 'Submit draft hours', exact: true }).click();await saved(page);
  await page.getByRole('button', { name: 'Return submitted hours for changes', exact: true }).click();
  await page.getByLabel('What needs to change?', { exact: true }).fill('Also check the work date.');
  await page.getByRole('button', { name: 'Return to draft', exact: true }).click();await saved(page);
  await rows.nth(2).getByText('Earlier feedback (1)', { exact: true }).click();
  await expect(rows.nth(2).getByRole('note', { name: 'Reviewer feedback' })).toContainText('Confirm the project assignment.');
  await page.reload();
  const persisted = await (await page.request.get('/api/workspace')).json();
  expect(persisted.data.sheets.find(s => s.id === 's1').rows.map(r => r.status)).toEqual(['approved', 'approved', 'draft']);
  await page.locator('nav button[title=Timesheets]').click();
  await expect(page.getByRole('group', { name: 'Timesheet status by row' })).toHaveCount(0);
  await expect(page.locator('.timesheet-heading')).toContainText('Not started');
  await expect(page.getByRole('button', { name: 'Submit draft hours', exact: true })).toBeDisabled();
});


test('row corrections preserve neighboring and invoiced hours on a mixed timesheet', async ({ page }, info) => {
  await page.goto('/');
  await register(page, 'Correction reviewer', email('corrections'));
  await page.evaluate(() => {
    state = retainAccounts(seed());
    const sheet = state.sheets.find(s => s.id === 'old0');
    sheet.rows.push(...['approved', 'approved', 'submitted', 'draft'].map((status,index) => ({
      id: 'correction-' + index, contractId: 'c1', rate: 12500, status,
      note: 'Keep this work note ' + index, hours: { [sheet.start]: 1 }
    })));
    refreshSheet(sheet); save(); openSheet(sheet.employeeId,sheet.start);
  });
  await saved(page);
  const rows = page.locator('.time-table tbody tr');
  await expect(rows.nth(0)).toContainText('Locked on INV-1001');
  await expect(rows.nth(0).getByRole('button', { name: 'Reopen row', exact: true })).toHaveCount(0);
  await rows.nth(0).getByRole('button', { name: 'View invoice', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('INV-1001');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await rows.nth(1).getByRole('button', { name: 'Reopen row', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Only this row will return to draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(rows.nth(1).locator('.badge')).toHaveText('Approved');
  await rows.nth(1).getByRole('button', { name: 'Reopen row', exact: true }).click();
  await page.getByLabel('What needs to change?', { exact: true }).fill('Correct the work date.');
  await page.getByRole('button', { name: 'Return to draft', exact: true }).click();
  await saved(page);
  await expect(rows.nth(1).locator('input').first()).toBeEnabled();
  await expect(rows.nth(2).locator('.badge')).toHaveText('Approved');
  await expect(rows.nth(3).locator('.badge')).toHaveText('Awaiting approval');
  await rows.nth(1).getByRole('button', { name: 'View note', exact: true }).click();
  await expect(page.locator('#row-note')).toHaveValue('Keep this work note 0');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await rows.nth(3).getByRole('button', { name: 'Return row for changes', exact: true }).click();
  await page.getByLabel('What needs to change?', { exact: true }).fill('Add the missing work description.');
  await page.getByRole('button', { name: 'Return to draft', exact: true }).click();
  await saved(page);
  await expect(rows.nth(3).locator('.badge')).toHaveText('Draft');
  await expect(rows.nth(2).locator('.badge')).toHaveText('Approved');
  await page.screenshot({ path: info.outputPath('row-corrections.png'), fullPage: true });
  const doc = await (await page.request.get('/api/workspace')).json();
  const sheet = doc.data.sheets.find(s => s.id === 'old0');
  expect(sheet.rows.map(r => r.status)).toEqual(['approved','draft','approved','draft','draft']);
  expect(sheet.rows[1].hours[sheet.start]).toBe(1);
  sheet.rows[0].status = 'draft';
  const forged = await page.request.put('/api/workspace', { headers: { Origin: 'http://127.0.0.1:3100' }, data: { data: doc.data, revision: doc.revision } });
  expect(forged.status()).toBe(400);
  await page.reload();
  await expect(page.getByRole('navigation')).toBeVisible();
  const persisted = await (await page.request.get('/api/workspace')).json();
  expect(persisted.data.sheets.find(s => s.id === 'old0').rows.map(r => r.status)).toEqual(['approved','draft','approved','draft','draft']);
});

test('payment reversal and invoice void retain history and release hours for rebilling', async ({ page }, info) => {
  await page.goto('/');await register(page,'Recovery admin',email('recovery'));
  await page.evaluate(()=>{state=retainAccounts(seed());save();view='invoices';render();invoiceDetail('i0')});await saved(page);
  await page.getByRole('button',{name:'Void invoice',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Reverse recorded payments before voiding');
  await page.getByRole('button',{name:'Back to invoice',exact:true}).click();
  await page.getByRole('button',{name:'Reverse payment entry',exact:true}).click();
  await page.getByLabel('Reason',{exact:true}).fill('Duplicate payment entry');
  await page.getByRole('button',{name:'Reverse entry',exact:true}).click();await saved(page);
  await expect(page.getByRole('dialog')).toContainText('Duplicate payment entry');
  await expect(page.getByRole('button',{name:'Record payment',exact:true})).toBeVisible();
  await expect(page.locator('.invoice-totals .total')).toContainText('$6,000.00');
  await page.getByRole('button',{name:'Void invoice',exact:true}).click();
  await page.getByLabel('Reason',{exact:true}).fill('Wrong invoice sent');
  await page.getByRole('button',{name:'Void invoice',exact:true}).click();await saved(page);
  await expect(page.getByRole('dialog')).toContainText('VOIDED');
  await expect(page.locator('.invoice-totals .total')).toContainText('$0.00');
  await page.evaluate(()=>{window.print=()=>{}});
  await page.getByRole('button',{name:'Print / PDF',exact:true}).click();
  await expect(page.locator('#print-area')).toContainText('VOIDED');
  await expect(page.getByRole('button',{name:'Record payment',exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('voided-invoice.png'),fullPage:true});
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('button',{name:'Voided',exact:true}).click();
  await expect(page.locator('#invoice-results')).toContainText('INV-1001');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await page.locator('#invoice-form [name=contract]').selectOption('c1');
  await expect(page.locator('#invoice-preview')).toContainText('48 hours');
  await page.getByRole('button',{name:'Create draft',exact:true}).click();await saved(page);
  await page.getByRole('button',{name:'Delete draft',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();await saved(page);
  await page.reload();await expect(page.getByRole('navigation')).toBeVisible();
  const doc=await (await page.request.get('/api/workspace')).json();
  expect(doc.data.invoices.find(i=>i.id==='i0').voided.reason).toBe('Wrong invoice sent');
  expect(doc.data.invoices.find(i=>i.id==='i0').payments[0].reversed.reason).toBe('Duplicate payment entry');
  expect(doc.data.invoices).toHaveLength(3);
});

test('draft row undo, empty sheet deletion, contract archive and unused deletion', async ({ page }) => {
  await page.goto('/');await register(page,'Draft admin',email('draft-recovery'));
  await page.evaluate(()=>{state=retainAccounts(seed());currentSheet(true);save();openSheet('e1',periodFor(today()))});await saved(page);
  const original=await (await page.request.get('/api/workspace')).json();
  await page.getByRole('button',{name:'Remove Website & digital strategy row',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();await saved(page);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await saved(page);
  expect((await (await page.request.get('/api/workspace')).json()).data.sheets.find(s=>s.id==='s1').rows).toEqual(original.data.sheets.find(s=>s.id==='s1').rows);
  await page.locator('nav button[title=Timesheets]').click();
  await page.getByRole('combobox',{name:'Timesheet employee'}).selectOption(await page.evaluate(()=>linkedEmployeeId));
  await page.getByRole('button',{name:'Delete empty timesheet',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();await saved(page);
  await expect(page.getByRole('button',{name:'Delete empty timesheet',exact:true})).toHaveCount(0);
  await page.locator('nav button[title=Contracts]').click();
  await page.locator('.contract-card').filter({hasText:'Website & digital strategy'}).getByRole('button',{name:/Manage/}).click();
  await expect(page.getByRole('button',{name:'Delete unused contract',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Archive contract',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();await saved(page);
  await expect(page.locator('.contract-card').filter({hasText:'Website & digital strategy'})).toHaveCount(0);
  await page.getByLabel('Show archived contracts').check();
  await page.locator('.contract-card').filter({hasText:'Website & digital strategy'}).getByRole('button',{name:/Manage/}).click();
  await page.getByRole('button',{name:'Restore contract',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();await saved(page);
  await page.getByRole('button',{name:'New contract',exact:true}).first().click();
  await page.locator('#contract-form [name=name]').fill('Accidental contract');await page.locator('#contract-form [name=client]').fill('Test client');
  await page.getByRole('button',{name:'Save contract',exact:true}).click();await saved(page);
  await page.locator('.contract-card').filter({hasText:'Accidental contract'}).getByRole('button',{name:/Manage/}).click();
  await page.getByRole('button',{name:'Delete unused contract',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();await saved(page);
  await expect(page.locator('.contract-card').filter({hasText:'Accidental contract'})).toHaveCount(0);
  await page.locator('nav button[title=Settings]').click();
  await page.getByRole('button',{name:'Reload sample workspace',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Everything, in good time.',exact:true})).toBeVisible();
  await page.locator('nav button[title=Settings]').click();
  await page.getByRole('button',{name:'Start an empty workspace',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await expect.poll(async()=> (await (await page.request.get('/api/workspace')).json()).data.invoices.length).toBe(0);

});
