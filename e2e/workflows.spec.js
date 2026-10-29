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

test('employee invitation, restricted time entry, approval, and shared partner access', async ({ page, browser }) => {
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
  await worker.getByRole('button', { name: 'Submit timesheet' }).click();
  await saved(worker);
  await expect.poll(async () => (await inboxEmails(page, adminEmail)).filter(email => email.subject.includes('submitted for review')).length).toBe(1);

  await page.reload();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Approve submitted hours', exact: true }).click();
  await saved(page);
  await expect.poll(async () => (await inboxEmails(worker, workerEmail)).filter(email => email.subject.includes('hours were approved')).length).toBe(1);
  await worker.reload();
  await expect(worker.locator('input[type=number]').first()).toBeDisabled();

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
});
