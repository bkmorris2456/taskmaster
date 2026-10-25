import { expect, test } from '@playwright/test';

test('standard production build cannot open the synthetic workspace', async ({
  page,
}) => {
  await page.goto('/list');
  await expect(
    page.getByRole('heading', { name: 'Local workspace disabled' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  for (const label of ['Categories', 'Date', 'Big List']) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: label, level: 1 }),
    ).toBeVisible();
  }
});
