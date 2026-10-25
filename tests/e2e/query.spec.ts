import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ timezoneId: 'America/New_York' });
const database =
  'taskmaster:local-preview:00000000-0000-4000-8000-000000000002';
const preference = (view: string) =>
  `taskmaster:preferences:${database}:00000000-0000-4000-8000-000000000002:${view}:v1`;
async function open(page: Page, path = '/list') {
  await page.goto(path);
  await expect(page.getByText(/changes retained locally/)).toBeVisible();
}
async function navigate(page: Page, name: string) {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(
    page.getByRole('heading', { name, level: 1, exact: true }),
  ).toBeVisible();
}
async function add(page: Page, title: string, priority = '', description = '') {
  const form = page.getByRole('form', { name: 'Create task', exact: true });
  await form.getByLabel('Task title', { exact: true }).fill(title);
  await form
    .getByText('Organization and due date', { exact: true })
    .evaluate((element) => element.parentElement?.setAttribute('open', ''));
  await form.getByLabel('Priority', { exact: true }).selectOption(priority);
  if (description) {
    await form.getByText('Optional description', { exact: true }).click();
    await form.getByLabel('Description', { exact: true }).fill(description);
  }
  await form.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }),
  ).toBeVisible();
}
async function filters(page: Page) {
  const summary = page.getByText('Filter controls', { exact: true });
  if (
    !(await summary.evaluate((element) =>
      element.parentElement?.hasAttribute('open'),
    ))
  )
    await summary.click();
}
async function queue(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(new Error('open'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox');
          const read = tx.objectStore('outbox').getAll();
          tx.oncomplete = () => {
            resolve(read.result);
            db.close();
          };
          tx.onerror = () => reject(new Error('read'));
        };
      }),
    database,
  );
}
async function makeCategory(page: Page) {
  await page.getByRole('button', { name: 'New category', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Category name', exact: true })
    .fill('Development');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  const category = page.getByLabel('Category: Development', { exact: true });
  await expect(category).toBeVisible();
  return category;
}

test('composed queries share semantics across views and preserve separate preferences without outbox writes', async ({
  page,
}) => {
  await open(page, '/categories');
  const category = await makeCategory(page);
  await category
    .getByRole('button', { name: 'New group', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Group name in Development', exact: true })
    .fill('Core');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page
    .getByLabel('Group: Core', { exact: true })
    .getByRole('button', { name: 'Add task', exact: true })
    .click();
  await add(page, 'Engine', 'high', 'Reliable SYNC protocol');
  await navigate(page, 'Big List');
  await add(page, 'Other', 'low');
  const before = await queue(page);
  for (const label of ['Big List', 'Categories', 'Date']) {
    await navigate(page, label);
    await filters(page);
    await page
      .getByLabel('Filter category', { exact: true })
      .selectOption({ label: 'Development' });
    await page
      .getByLabel('Filter group', { exact: true })
      .selectOption({ label: 'Core' });
    await page
      .getByLabel('Filter priority', { exact: true })
      .selectOption('high');
    await page.getByLabel('Date range', { exact: true }).selectOption('14');
    await page
      .getByRole('searchbox', { name: 'Search tasks', exact: true })
      .fill('  sync  ');
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    await expect(
      page.getByRole('checkbox', { name: 'Complete Engine', exact: true }),
    ).toBeVisible();
    await page.getByRole('searchbox').fill('unmatched');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(
      page.getByText('No tasks match the current query.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('searchbox').fill('sync');
  }
  expect(await queue(page)).toEqual(before);
  await page.reload();
  await expect(page.getByRole('searchbox')).toHaveValue('sync');
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Reset filters', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await navigate(page, 'Big List');
  await expect(page.getByRole('searchbox')).toHaveValue('sync');
  expect(await queue(page)).toEqual(before);
});

test('offline query preferences survive reload; explicit Active is respected in completion-date mode and history survives reopen', async ({
  page,
  context,
}) => {
  await open(page);
  await add(page, 'Alpha');
  await add(page, 'Zulu');
  await page
    .getByRole('checkbox', { name: 'Complete Zulu', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Zulu', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await navigate(page, 'Date');
  await page
    .getByLabel('Group dates by', { exact: true })
    .selectOption('completed');
  await expect(
    page.getByRole('checkbox', { name: 'Reopen Zulu', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(
    page.getByText(/Active tasks have no current completion date/),
  ).toBeVisible();
  await page.getByLabel('Group dates by', { exact: true }).selectOption('due');
  await page
    .getByLabel('Group dates by', { exact: true })
    .selectOption('completed');
  await expect(
    page.getByRole('button', { name: 'Active', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Active', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Reopen Zulu', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByText('Completion history', { exact: true }).click();
  await expect(page.getByLabel('Completion records')).toContainText(
    'Completed: Zulu',
  );
  await expect(page.getByLabel('Completion records')).toContainText(
    'Reopened: Zulu',
  );
  await navigate(page, 'Big List');
  await page.getByRole('searchbox').fill(' alpha ');
  await page
    .getByLabel('Sort tasks', { exact: true })
    .selectOption('title-desc');
  const before = await queue(page);
  await page.reload();
  await expect(page.getByRole('searchbox')).toHaveValue(' alpha ');
  await expect(page.getByLabel('Sort tasks', { exact: true })).toHaveValue(
    'title-desc',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Complete Alpha', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  expect(await queue(page)).toEqual(before);
});

test('deleting filtered containers repairs references visibly while preserving assigned tasks', async ({
  page,
}) => {
  await open(page, '/categories');
  const category = await makeCategory(page);
  await category
    .getByRole('button', { name: 'New group', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Group name in Development', exact: true })
    .fill('Core');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  const group = page.getByLabel('Group: Core', { exact: true });
  await group.getByRole('button', { name: 'Add task', exact: true }).click();
  await add(page, 'Keep task');
  await filters(page);
  await page
    .getByLabel('Filter category', { exact: true })
    .selectOption({ label: 'Development' });
  await page
    .getByLabel('Filter group', { exact: true })
    .selectOption({ label: 'Core' });
  page.once('dialog', (dialog) => dialog.accept());
  await group
    .getByRole('button', { name: 'Delete group', exact: true })
    .click();
  await expect(
    page.getByText(/A deleted category or group filter was cleared/),
  ).toBeVisible();
  await expect(page.getByLabel('Filter group', { exact: true })).toHaveValue(
    '*',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Complete Keep task', exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await category
    .getByRole('button', { name: 'Delete category', exact: true })
    .click();
  await expect(page.getByLabel('Filter category', { exact: true })).toHaveValue(
    '*',
  );
  await page.reload();
  await filters(page);
  await expect(page.getByLabel('Filter category', { exact: true })).toHaveValue(
    '*',
  );
  await expect(page.getByLabel('Uncategorized', { exact: true })).toContainText(
    'Keep task',
  );
  expect(await queue(page)).toHaveLength(5);
});

test('query controls work with keyboard, custom and missing date ranges and optional Medium priority', async ({
  page,
}) => {
  await open(page);
  await add(page, 'Beta', 'normal');
  await add(page, 'Alpha');
  await page
    .getByLabel('Sort tasks', { exact: true })
    .selectOption('title-asc');
  await expect(page.getByRole('checkbox').first()).toHaveAccessibleName(
    'Complete Alpha',
  );
  await page
    .getByLabel('Sort tasks', { exact: true })
    .selectOption('title-desc');
  await expect(page.getByRole('checkbox').first()).toHaveAccessibleName(
    'Complete Beta',
  );
  await page.getByText('Filter controls', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByLabel('Filter priority', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Filter priority', { exact: true })
    .selectOption('normal');
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page
    .getByLabel('Filter date field', { exact: true })
    .selectOption('due');
  await page.getByLabel('Date range', { exact: true }).selectOption('missing');
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page
    .getByLabel('Filter date field', { exact: true })
    .selectOption('created');
  await page.getByLabel('Date range', { exact: true }).selectOption('custom');
  await expect(page.getByRole('alert')).toContainText('endpoints');
  await page.getByLabel('Range start', { exact: true }).fill('1900-01-01');
  await page.getByLabel('Range end', { exact: true }).fill('9999-12-31');
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('form', { name: 'Edit Beta', exact: true });
  await expect(editor.getByLabel('Priority', { exact: true })).toHaveValue(
    'normal',
  );
  await editor.getByLabel('Priority', { exact: true }).selectOption('high');
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    (await page.getByRole('searchbox').boundingBox())?.width,
  ).toBeGreaterThanOrEqual(200);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Reset filters', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('checkbox')).toHaveCount(2);
});

test('malformed preferences reset with feedback and blocked preference writes do not block task persistence', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(
    (key) => localStorage.setItem(key, '{"version":999}'),
    preference('list'),
  );
  await page.reload();
  await expect(
    page.getByText(/Outdated or invalid view preferences were reset/),
  ).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Denied', 'SecurityError');
    };
  });
  await page.getByRole('searchbox').fill('saved');
  await expect(
    page.getByText(/View preferences could not be saved/),
  ).toBeVisible();
  await add(page, 'Saved locally');
  expect(await queue(page)).toHaveLength(1);
});
