import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const password = 'automated test password 123';
const email = prefix => `${prefix}-${randomUUID()}@example.test`;
const saved = page => expect(page.locator('#save-label')).toHaveText('Saved to server');

async function register(page, name, address) {
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
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
  await register(page, 'Test admin', email('admin'));
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

  await page.reload();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Approve submitted hours', exact: true }).click();
  await saved(page);
  await worker.reload();
  await expect(worker.locator('input[type=number]').first()).toBeDisabled();

  const partnerEmail = email('partner');
  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  partner.on('pageerror', error => errors.push(error.message));
  await partner.goto(await invite(page, partnerEmail, 'admin'));
  await register(partner, 'Test partner', partnerEmail);
  await expect(partner.locator('nav button')).toHaveCount(6);
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
