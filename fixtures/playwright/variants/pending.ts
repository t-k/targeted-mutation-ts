import { expect, test } from '@playwright/test';

test('disables Save while a valid form submission is pending', async ({ page }) => {
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/save', async route => {
    await hold;
    await route.fulfill({ status: 204 });
  });
  await page.goto('/save?valid=yes');
  const button = page.getByRole('button', { name: 'Save' });
  await expect(button).toBeEnabled();
  const request = page.waitForRequest('**/api/save');
  try {
    await button.click();
    await request;
    await expect(button).toBeDisabled({ timeout: 1500 });
  } finally {
    finish();
  }
  await expect(button).toBeEnabled();
});
