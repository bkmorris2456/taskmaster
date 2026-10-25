import { chromium, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFailureProbe } from './storageProbe';

test.use({ timezoneId: 'America/New_York' });
const dbName = 'taskmaster:local-preview:00000000-0000-4000-8000-000000000002';
async function open(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-24T12:00:00Z'));
  await page.goto('/list');
  await expect(page.getByText(/changes retained locally/)).toBeVisible();
}
async function add(
  page: Page,
  name = 'Daily',
  frequency = 'daily',
  date = '2026-10-21',
) {
  const form = page.getByRole('form', { name: 'Create task', exact: true });
  await form.getByLabel('Task title', { exact: true }).fill(name);
  await form.getByText('Organization and due date', { exact: true }).click();
  await form.getByLabel('Due date', { exact: true }).fill(date);
  await form.getByLabel('Repeat', { exact: true }).selectOption(frequency);
  await expect(form.getByLabel('Schedule anchor', { exact: true })).toHaveValue(
    date,
  );
  await form
    .getByLabel('Recurrence time zone', { exact: true })
    .fill('America/New_York');
  await form.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: `Complete ${name}`, exact: true }),
  ).toBeVisible();
}
async function state(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<{ version: number; stores: Record<string, unknown[]> }>(
        (resolve, reject) => {
          const request = indexedDB.open(name);
          request.onerror = () => reject(new Error('open'));
          request.onsuccess = () => {
            const db = request.result;
            const names = Array.from(db.objectStoreNames);
            const tx = db.transaction(names);
            const reads = names.map(
              (name) => [name, tx.objectStore(name).getAll()] as const,
            );
            tx.oncomplete = () => {
              resolve({
                version: db.version,
                stores: Object.fromEntries(
                  reads.map(([name, request]) => [name, request.result]),
                ),
              });
              db.close();
            };
            tx.onerror = () => reject(new Error('read'));
          };
        },
      ),
    dbName,
  );
}
async function complete(page: Page, title: string, nextDue: string) {
  await page
    .getByRole('checkbox', { name: `Complete ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole('listitem', { name: `Task: ${title}`, exact: true }),
  ).toContainText(`Next due ${nextDue}`);
  await expect(page.getByRole('checkbox')).toHaveCount(1);
}

test('daily completion skips missed slots, exposes history across views and has keyboard undo', async ({
  page,
}) => {
  await open(page);
  await add(page);
  await page
    .getByRole('checkbox', { name: 'Complete Daily', exact: true })
    .focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
  ).toContainText('Next due 2026-10-25');
  await page
    .getByRole('button', { name: 'Undo completion: Daily', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
  ).toContainText('Next due 2026-10-21');
  await complete(page, 'Daily', '2026-10-25');
  for (const name of ['Categories', 'Date', 'Big List']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(
      page.getByRole('heading', { name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    await expect(
      page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
    ).toContainText('2026-10-25');
  }
  await page.getByRole('searchbox').fill('daily');
  await page.getByLabel('Sort tasks', { exact: true }).selectOption('due-desc');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page.getByText('Completion history', { exact: true }).click();
  await expect(
    page.getByLabel('Completion records', { exact: true }),
  ).toContainText('Scheduled 2026-10-21');
  const saved = await state(page);
  expect(saved.stores.completionEvents).toHaveLength(3);
  expect(saved.stores.outbox).toHaveLength(4);
  expect(saved.stores.tasks).toHaveLength(3);
});

test('monthly fallback restores the original day, skips overdue months, and preserves completion dates', async ({
  page,
}) => {
  await open(page);
  await page.clock.setFixedTime(new Date('2024-01-31T17:00:00Z'));
  await add(page, 'Monthly', 'monthly', '2024-01-31');
  await complete(page, 'Monthly', '2024-02-29');
  await page.clock.setFixedTime(new Date('2024-02-29T17:00:00Z'));
  await complete(page, 'Monthly', '2024-03-31');
  await page.clock.setFixedTime(new Date('2024-05-30T17:00:00Z'));
  await complete(page, 'Monthly', '2024-05-31');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(3);
  await page.getByRole('link', { name: 'Date', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Date', exact: true, level: 1 }),
  ).toBeVisible();
  await page
    .getByLabel('Group dates by', { exact: true })
    .selectOption('completed');
  await expect(page.getByRole('checkbox')).toHaveCount(3);
  const saved = await state(page);
  expect(saved.stores.recurrenceSeries).toEqual([
    expect.objectContaining({ anchorDate: '2024-01-31' }),
  ]);
  expect(saved.stores.completionEvents).toHaveLength(3);
});

test('changing recurrence reanchors only the active occurrence; disabling leaves it standalone', async ({
  page,
}) => {
  await open(page);
  await add(page);
  await complete(page, 'Daily', '2026-10-25');
  const before = await state(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const deadlineEdit = page.getByRole('form', {
    name: 'Edit Daily',
    exact: true,
  });
  await deadlineEdit.getByLabel('Due date', { exact: true }).fill('');
  await deadlineEdit
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(
    page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
  ).toContainText('No due date');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  let form = page.getByRole('form', { name: 'Edit Daily', exact: true });
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await form
        .getByLabel('Recurrence time zone', { exact: true })
        .boundingBox()
    )?.width,
  ).toBeGreaterThanOrEqual(200);
  await page.screenshot({
    path: test.info().outputPath('recurrence-editor-320.png'),
    fullPage: true,
  });

  await form.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await form.getByLabel('Schedule anchor', { exact: true }).fill('2026-10-26');
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
  ).toContainText('Repeats weekly');
  await complete(page, 'Daily', '2026-11-02');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  form = page.getByRole('form', { name: 'Edit Daily', exact: true });
  await form.getByLabel('Repeat', { exact: true }).selectOption('');
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText(/Repeats weekly/)).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: 'Complete Daily', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const after = await state(page);
  expect(after.stores.completionEvents).toHaveLength(3);
  expect(after.stores.completionEvents).toEqual(
    expect.arrayContaining(before.stores.completionEvents ?? []),
  );
  expect(after.stores.recurrenceSeries).toEqual([
    expect.objectContaining({ enabled: false, activeTaskId: null }),
  ]);
});

test('edited successor blocks undo and historical standalone reopening requires confirmation', async ({
  page,
}) => {
  await open(page);
  await add(page);
  await complete(page, 'Daily', '2026-10-25');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit Daily', exact: true });
  await form.getByLabel('Edit title', { exact: true }).fill('Edited successor');
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page
    .getByRole('button', { name: 'Undo completion: Daily', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Undo is blocked');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Reopen as standalone', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Reopen Daily', exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reopen as standalone', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await expect(
    page.getByRole('listitem', { name: 'Task: Edited successor', exact: true }),
  ).toContainText('Repeats daily');
  await expect(
    page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
  ).not.toContainText('Recurring occurrence');
});

test('native outbox failure rolls back every recurrence store for completion and undo', async ({
  page,
}) => {
  await installFailureProbe(page);
  await open(page);
  await add(page);
  const before = await state(page);
  await page.evaluate(() => {
    window.failOutbox = true;
  });
  await page
    .getByRole('checkbox', { name: 'Complete Daily', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  expect(await state(page)).toEqual(before);
  await page.evaluate(() => {
    window.failOutbox = false;
  });
  await complete(page, 'Daily', '2026-10-25');
  const completed = await state(page);
  await page.evaluate(() => {
    window.failOutbox = true;
  });
  await page
    .getByRole('button', { name: 'Undo completion: Daily', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  expect(await state(page)).toEqual(completed);
});

test('offline recurrence and exact queue/history survive a complete browser-process restart', async ({
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), 'taskmaster-phase5-'));
  let context = await chromium.launchPersistentContext(profile, {
    headless: true,
    timezoneId: 'America/New_York',
  });
  try {
    let page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-24T12:00:00Z'));
    await page.goto(`${baseURL ?? 'http://127.0.0.1:4173'}/list`);
    await expect(page.getByText(/changes retained locally/)).toBeVisible();
    await expect(
      page.getByText('Application shell ready offline.', { exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await add(page);
    await complete(page, 'Daily', '2026-10-25');
    await page.reload();
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    const before = await state(page);
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      timezoneId: 'America/New_York',
    });
    await context.setOffline(true);
    page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-26T12:00:00Z'));
    await page.goto(`${baseURL ?? 'http://127.0.0.1:4173'}/list`);
    await expect(
      page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
    ).toContainText('Next due 2026-10-25');
    expect(await state(page)).toEqual(before);
    await complete(page, 'Daily', '2026-10-27');
    await page
      .getByRole('button', { name: 'Undo completion: Daily', exact: true })
      .click();
    await expect(
      page.getByRole('listitem', { name: 'Task: Daily', exact: true }),
    ).toContainText('Next due 2026-10-25');
    await page.reload();
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    expect((await state(page)).stores.completionEvents).toHaveLength(3);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('real native schema v2 upgrades additively and keeps all legacy objects and unknown command fields', async ({
  page,
}) => {
  await page.goto('/icons/icon-192.png');
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 20);
        request.onupgradeneeded = () => {
          const db = request.result;
          const schemas: Record<string, string[]> = {
            tasks: ['ownerId', 'createdAt', 'categoryId', 'groupId', 'dueDate'],
            canonicalTasks: ['ownerId'],
            completionEvents: ['taskId', 'ownerId'],
            outbox: ['sequence', 'taskId'],
            meta: [],
            categories: ['ownerId'],
            groups: ['ownerId', 'categoryId'],
            canonicalCategories: ['ownerId'],
            canonicalGroups: ['ownerId', 'categoryId'],
          };
          for (const [store, indexes] of Object.entries(schemas)) {
            const table = db.createObjectStore(store, {
              keyPath: store === 'meta' ? 'key' : 'id',
            });
            for (const index of indexes)
              table.createIndex(index, index, {
                unique: store === 'outbox' && index === 'sequence',
              });
          }
          const ownerId = '00000000-0000-4000-8000-000000000002';
          const stamp = '2026-10-20T12:00:00.000Z';
          const task = {
            id: '00000000-0000-4000-8000-000000000101',
            ownerId,
            title: 'Legacy',
            description: null,
            dueDate: null,
            priority: null,
            categoryId: 'category',
            groupId: 'group',
            seriesId: null,
            occurrenceDate: null,
            completed: false,
            completedAt: null,
            createdAt: stamp,
            updatedAt: stamp,
            deletedAt: null,
            revision: null,
            localRevision: 1,
            timestampsProvisional: true,
            currentCompletionId: null,
            lastOperationId: 'legacy-command',
          };
          const container = {
            id: 'category',
            ownerId,
            name: 'Legacy category',
            createdAt: stamp,
            updatedAt: stamp,
            deletedAt: null,
            revision: null,
            localRevision: 1,
            timestampsProvisional: true,
            lastOperationId: 'legacy-command',
          };
          const tx = request.transaction;
          if (!tx) throw new Error('Missing migration transaction');
          tx.objectStore('tasks').add(task);
          tx.objectStore('categories').add(container);
          tx.objectStore('groups').add({
            ...container,
            id: 'group',
            name: 'Legacy group',
            categoryId: 'category',
          });
          tx.objectStore('completionEvents').add({
            id: 'history',
            ownerId,
            taskId: task.id,
            operationId: 'old',
            occurredAt: stamp,
            timeZone: 'UTC',
            kind: 'completion',
            snapshot: {
              title: 'Earlier title',
              description: null,
              dueDate: null,
              priority: null,
              categoryId: null,
              groupId: null,
              seriesId: null,
              occurrenceDate: null,
            },
          });
          tx.objectStore('outbox').add({
            id: 'legacy-command',
            protocolVersion: 2,
            ownerId,
            taskId: task.id,
            deviceId: 'legacy-device',
            sequence: 1,
            createdAt: stamp,
            status: 'pending',
            dependsOn: null,
            expectedRevision: null,
            base: null,
            result: task,
            payload: {
              kind: 'create',
              input: { title: 'Legacy' },
              future: 'retain',
            },
            changes: [{ kind: 'task', base: null, result: task }],
            reads: [],
            dependencies: [],
            futureField: { retain: true },
          });
          tx.objectStore('meta').add({
            key: 'workspace',
            ownerId,
            deviceId: 'legacy-device',
            sequence: 1,
          });
        };
        request.onerror = () => reject(new Error('seed'));
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      }),
    dbName,
  );
  const before = await state(page);
  await open(page);
  const after = await state(page);
  expect(after.version).toBe(30);
  for (const [name, rows] of Object.entries(before.stores))
    expect(after.stores[name]).toEqual(rows);
  expect(after.stores.recurrenceSeries).toEqual([]);
  expect(after.stores.canonicalSeries).toEqual([]);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit Legacy', exact: true });
  await form.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await form.getByLabel('Schedule anchor', { exact: true }).fill('2026-10-24');
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await complete(page, 'Legacy', '2026-10-25');
  expect((await state(page)).stores.outbox).toEqual(
    expect.arrayContaining(before.stores.outbox ?? []),
  );
});
