import { expect, test } from '@playwright/test';

test('default view, navigation, history and direct loading render without errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/list$/);
  await expect(
    page.getByRole('heading', { name: 'Big List', level: 1 }),
  ).toBeVisible();
  for (const label of ['Categories', 'Date', 'Big List']) {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: label, exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: label, level: 1 }),
    ).toBeFocused();
    await expect(
      page.getByRole('link', { name: label, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveTitle(`${label} · Taskmaster`);
  }
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Date', level: 1 }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Date', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keyboard users can skip navigation and activate each view', async ({
  page,
}) => {
  await page.goto('/list');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.reload();
  await page.keyboard.press('Tab'); // skip link
  await page.keyboard.press('Tab'); // brand
  await page.keyboard.press('Tab'); // Categories
  await expect(
    page.getByRole('link', { name: 'Categories', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Categories', level: 1 }),
  ).toBeFocused();
  await page.getByRole('link', { name: 'Date', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Date', level: 1 }),
  ).toBeFocused();
  await page.getByRole('link', { name: 'Big List', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Big List', level: 1 }),
  ).toBeFocused();
});

test('small and desktop layouts fit the viewport with touch-sized navigation', async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/list');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    for (const link of await page
      .getByRole('navigation')
      .getByRole('link')
      .all()) {
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
  }
});

test('manifest and icons are valid and use standalone display', async ({
  page,
  request,
}) => {
  await page.goto('/list');
  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute('href');
  expect(manifestHref).toBeTruthy();
  const response = await request.get(manifestHref ?? '/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest: unknown = await response.json();
  expect(manifest).toMatchObject({
    name: 'Taskmaster',
    display: 'standalone',
    start_url: '/list',
    theme_color: '#111413',
  });
  for (const [name, size] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['maskable-512.png', 512],
  ] as const) {
    const icon = await request.get(`/icons/${name}`);
    expect(icon.ok()).toBe(true);
    const png = await icon.body();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
});
