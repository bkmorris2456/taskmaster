import { expect, test } from '@playwright/test';

test('cached shell opens and navigates offline in a fresh page without caching APIs', async ({
  page,
  context,
}) => {
  await page.goto('/list');
  await expect(
    page
      .getByRole('complementary', { name: 'Application availability' })
      .getByRole('status'),
  ).toHaveText('Application shell ready offline.');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        ),
      );
    }
  });
  // Real network response containing synthetic private data must never enter Cache Storage.
  await page.route('**/api/private-probe', (route) =>
    route.fulfill({ json: { private: 'synthetic-test-only' } }),
  );
  await page.evaluate(async () => {
    await fetch('/api/private-probe');
  });
  await context.setOffline(true);
  await page.close();
  const offlinePage = await context.newPage();
  const errors: string[] = [];
  offlinePage.on('pageerror', (error) => errors.push(error.message));
  await offlinePage.goto('/date');
  await expect(
    offlinePage.getByRole('heading', { name: 'Date', level: 1 }),
  ).toBeVisible();
  await offlinePage
    .getByRole('link', { name: 'Categories', exact: true })
    .click();
  await expect(
    offlinePage.getByRole('heading', { name: 'Categories', level: 1 }),
  ).toBeVisible();
  await offlinePage.reload();
  await expect(
    offlinePage.getByRole('heading', { name: 'Categories', level: 1 }),
  ).toBeVisible();
  const cacheUrls = await offlinePage.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map((request) => request.url));
    }
    return urls;
  });
  expect(cacheUrls.length).toBeGreaterThan(0);
  expect(
    cacheUrls.every((url) =>
      /\/(?:index\.html|manifest\.webmanifest|assets\/[^/]+\.(?:js|css)|icons\/[^/]+\.(?:png|svg))(?:\?|$)/.test(
        url,
      ),
    ),
  ).toBe(true);
  const apiUnavailable = await offlinePage.evaluate(async () => {
    try {
      await fetch('/api/private-probe');
      return false;
    } catch {
      return true;
    }
  });
  expect(apiUnavailable).toBe(true);
  expect(errors).toEqual([]);
});
