import { expect, test } from '@playwright/test';

test('allows an 18-year-old to continue', async ({ page }) => {
  await page.goto('/?age=18');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
});
