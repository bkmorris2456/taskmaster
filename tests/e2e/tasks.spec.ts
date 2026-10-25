import { installFailureProbe } from './storageProbe';
import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/list');
  await expect(page.getByText(/changes retained locally/)).toBeVisible();
}

async function create(page: Page, title: string) {
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .fill(title);
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }),
  ).toBeVisible();
}

async function stored(page: Page) {
  return page.evaluate(async () => {
    const name =
      'taskmaster:local-preview:00000000-0000-4000-8000-000000000002';
    return new Promise<{
      tasks: unknown[];
      events: unknown[];
      commands: unknown[];
    }>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(new Error('Cannot inspect database'));
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['tasks', 'completionEvents', 'outbox']);
        const tasks = tx.objectStore('tasks').getAll();
        const events = tx.objectStore('completionEvents').getAll();
        const commands = tx.objectStore('outbox').getAll();
        tx.oncomplete = () => {
          resolve({
            tasks: tasks.result,
            events: events.result,
            commands: commands.result,
          });
          db.close();
        };
        tx.onerror = () => {
          reject(new Error('Inspection failed'));
          db.close();
        };
      };
    });
  });
}

test('title-only capture, inline editing, completion, persistent undo, deletion and restore', async ({
  page,
}) => {
  await ready(page);
  await create(page, 'Plan the day');
  await expect(
    page.getByRole('textbox', { name: 'Task title', exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('textbox', { name: 'Task title', exact: true }),
  ).toBeFocused();
  const row = page.getByRole('listitem', {
    name: 'Task: Plan the day',
    exact: true,
  });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .fill('Plan tomorrow');
  await page
    .getByRole('textbox', { name: 'Edit description', exact: true })
    .fill('A plain-text note');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('listitem', { name: 'Task: Plan tomorrow', exact: true }),
  ).toContainText('A plain-text note');
  await page.reload();
  await page
    .getByRole('checkbox', { name: 'Complete Plan tomorrow', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Plan tomorrow', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[aria-label="active tasks"]')).toBeFocused();
  await page
    .getByRole('button', {
      name: 'Undo completion: Plan tomorrow',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Plan tomorrow', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Plan tomorrow', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('checkbox', { name: 'Complete Plan tomorrow', exact: true })
    .click();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Reopen Plan tomorrow', exact: true }),
  ).toBeChecked();
  await page.getByText('Completion history', { exact: true }).click();
  await expect(
    page
      .getByRole('list', { name: 'Completion records' })
      .getByText('Completed: Plan tomorrow', { exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole('list', { name: 'Completion records' }),
  ).toContainText('Reopened: Plan tomorrow');
  await page
    .getByRole('checkbox', { name: 'Reopen Plan tomorrow', exact: true })
    .click();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page
    .getByRole('listitem', { name: 'Task: Plan tomorrow', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Plan tomorrow', exact: true }),
  ).toBeVisible();
  const data = await stored(page);
  expect(data.events).toHaveLength(4);
  expect(data.commands).toHaveLength(8);
});

test('all task operations persist offline through reload and a fresh application page', async ({
  page,
  context,
}) => {
  await ready(page);
  await expect(
    page
      .getByRole('complementary', { name: 'Application availability' })
      .getByRole('status'),
  ).toHaveText('Application shell ready offline.');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await create(page, 'Offline task');
  const initial = await stored(page);
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Offline task', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .fill('Offline edited');
  await page
    .getByRole('textbox', { name: 'Edit description', exact: true })
    .fill('Survives offline');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Complete Offline edited', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Complete Offline edited',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Reopen Offline edited', exact: true }),
  ).toBeChecked();
  await page.getByText('Completion history', { exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Completion records' }),
  ).toContainText('Completed: Offline edited');
  await page
    .getByRole('checkbox', { name: 'Reopen Offline edited', exact: true })
    .click();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await stored(page)).commands.length).toBe(5);
  await page.close();
  const restarted = await context.newPage();
  await restarted.goto('/list');
  await expect(
    restarted.getByRole('heading', { name: 'Nothing on your list.' }),
  ).toBeVisible();
  await restarted
    .getByRole('button', { name: 'Completed', exact: true })
    .click();
  await expect(restarted.getByRole('checkbox')).toHaveCount(0);
  await restarted.getByRole('button', { name: 'Deleted', exact: true }).click();
  await expect(
    restarted.getByRole('listitem', {
      name: 'Task: Offline edited',
      exact: true,
    }),
  ).toContainText('Survives offline');
  const data = await stored(restarted);
  expect(data.tasks).toHaveLength(1);
  expect(data.tasks[0]).toMatchObject({
    title: 'Offline edited',
    completed: false,
    localRevision: 5,
    deletedAt: expect.any(String),
  });
  expect(data.events).toHaveLength(2);
  expect(data.commands).toHaveLength(5);
  expect(data.commands).toEqual(expect.arrayContaining(initial.commands));
});

test('validation keeps input and draft navigation/cancellation requires explicit discard', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .fill('   ');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a task title');
  expect((await stored(page)).commands).toHaveLength(0);
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .fill('Draft stays');
  await expect(
    page.getByRole('button', { name: 'Create task', exact: true }),
  ).toBeEnabled();
  const navigationDialog = page.waitForEvent('dialog');
  page.once('dialog', async (dialog) => {
    await dialog.dismiss();
  });
  await page.getByRole('link', { name: 'Date', exact: true }).click();
  expect((await navigationDialog).message()).toBe(
    'Leave this view and discard unsaved drafts?',
  );
  await expect(page).toHaveURL(/\/list$/);
  await expect(
    page.getByRole('textbox', { name: 'Task title', exact: true }),
  ).toHaveValue('Draft stays');
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .press('Enter');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .fill('Unsaved edit');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Edit title', exact: true }),
  ).toHaveValue('Unsaved edit');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .press('Escape');
  await expect(
    page.getByRole('textbox', { name: 'Edit title', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: 'Complete Draft stays', exact: true }),
  ).toBeVisible();
});

test('quota failure keeps create/edit input and rolls back completion and history', async ({
  page,
}) => {
  await installFailureProbe(page);
  await ready(page);
  await page.evaluate(() => {
    window.failOutbox = true;
  });
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .fill('Keep draft');
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .press('Enter');
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await expect(
    page.getByRole('textbox', { name: 'Task title', exact: true }),
  ).toHaveValue('Keep draft');
  expect((await stored(page)).tasks).toHaveLength(0);
  await page.evaluate(() => {
    window.failOutbox = false;
  });
  await page
    .getByRole('textbox', { name: 'Task title', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('checkbox', { name: 'Complete Keep draft', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.failOutbox = true;
  });
  await page
    .getByRole('checkbox', { name: 'Complete Keep draft', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  const data = await stored(page);
  expect(data.tasks[0]).toMatchObject({ completed: false });
  expect(data.events).toHaveLength(0);
  expect(data.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .fill('Keep edit');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await expect(
    page.getByRole('textbox', { name: 'Edit title', exact: true }),
  ).toHaveValue('Keep edit');
  expect((await stored(page)).commands).toHaveLength(1);
  await page.evaluate(() => {
    window.failOutbox = false;
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Keep edit', exact: true }),
  ).toBeVisible();
});

test('concurrent tab edits preserve losing drafts and history snapshots', async ({
  page,
  context,
}) => {
  await ready(page);
  await create(page, 'Shared task');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .fill('My unsaved edit');
  const other = await context.newPage();
  await ready(other);
  await other.getByRole('button', { name: 'Edit', exact: true }).click();
  await other
    .getByRole('textbox', { name: 'Edit title', exact: true })
    .fill('Other tab wins');
  await other
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Complete Other tab wins',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed in another tab');
  await expect(
    page.getByRole('textbox', { name: 'Edit title', exact: true }),
  ).toHaveValue('My unsaved edit');
  expect((await stored(page)).commands).toHaveLength(2);
  // A deletion in another tab must not unmount and erase the open draft.
  await other.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Edit title', exact: true }),
  ).toHaveValue('My unsaved edit');
});

test('checkbox completion is keyboard accessible and optional descriptions remain plain text', async ({
  page,
}) => {
  await ready(page);
  await page.getByText('Optional description', { exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('<script>alert("no")</script>');
  await create(page, 'Keyboard task');
  const checkbox = page.getByRole('checkbox', {
    name: 'Complete Keyboard task',
    exact: true,
  });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toHaveCount(0);
  await expect(page.locator('[aria-label="active tasks"]')).toBeFocused();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(
    page.getByRole('listitem', { name: 'Task: Keyboard task', exact: true }),
  ).toContainText('<script>alert("no")</script>');
});

test('local tasks and pending commands survive a full browser-process restart offline', async ({
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), 'taskmaster-restart-'));
  let persistent = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  try {
    const page = await persistent.newPage();
    await page.goto(`${baseURL ?? 'http://127.0.0.1:4173'}/list`);
    await expect(page.getByText(/changes retained locally/)).toBeVisible();
    await expect(
      page
        .getByRole('complementary', { name: 'Application availability' })
        .getByRole('status'),
    ).toHaveText('Application shell ready offline.');
    await persistent.setOffline(true);
    await create(page, 'Browser restart task');
    const before = await stored(page);
    await persistent.close();
    persistent = await chromium.launchPersistentContext(profile, {
      headless: true,
    });
    await persistent.setOffline(true);
    const restarted = await persistent.newPage();
    await restarted.goto(`${baseURL ?? 'http://127.0.0.1:4173'}/list`);
    await expect(
      restarted.getByRole('checkbox', {
        name: 'Complete Browser restart task',
        exact: true,
      }),
    ).toBeVisible();
    expect(await stored(restarted)).toEqual(before);
  } finally {
    await persistent.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('unavailable IndexedDB produces an actionable error instead of an empty-list success', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get: () => undefined });
  });
  await page.goto('/list');
  await expect(page.getByRole('alert')).toContainText(
    'Local storage could not',
  );
  await expect(
    page.getByRole('button', { name: 'Retry storage' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create task', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Nothing on your list.' }),
  ).toHaveCount(0);
});

test('task text and inline editor remain usable at a 320px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await ready(page);
  const input = page.getByRole('textbox', { name: 'Task title', exact: true });
  expect((await input.boundingBox())?.width).toBeGreaterThan(180);
  await create(page, 'A readable task title on a narrow screen');
  expect(
    (
      await page
        .getByText('A readable task title on a narrow screen', { exact: true })
        .boundingBox()
    )?.width,
  ).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  expect(
    (
      await page
        .getByRole('textbox', { name: 'Edit title', exact: true })
        .boundingBox()
    )?.width,
  ).toBeGreaterThan(180);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
