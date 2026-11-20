import { expect, test } from '@playwright/test';

test('disables Continue at 17 and enables it at 20', async ({ page, request }) => {
  expect(await (await request.get('/?age=17')).text()).toContain('aria-label="Continue" disabled');
  await page.goto('/?age=17');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.goto('/?age=20');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
});

test('enables Save only for valid forms before submitting', async ({ page }) => {
  await page.goto('/save');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.goto('/save?valid=yes');
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
});
