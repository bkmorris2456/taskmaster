import { installFailureProbe } from './storageProbe';
import { chromium, expect, test } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.use({ timezoneId: 'America/Los_Angeles' });

const dbName = 'taskmaster:local-preview:00000000-0000-4000-8000-000000000002';
const ownerId = '00000000-0000-4000-8000-000000000002';

async function open(page: Page, path = '/categories') {
  await page.goto(path);
  await expect(page.getByText(/changes retained locally/)).toBeVisible();
}
async function category(page: Page, name: string) {
  await page.getByRole('button', { name: 'New category', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Category name', exact: true })
    .fill(name);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(
    page.getByLabel(`Category: ${name}`, { exact: true }),
  ).toBeVisible();
}
async function group(page: Page, parent: string, name: string) {
  await page
    .getByLabel(`Category: ${parent}`, { exact: true })
    .getByRole('button', { name: 'New group', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: `Group name in ${parent}`, exact: true })
    .fill(name);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(
    page.getByLabel(`Group: ${name}`, { exact: true }),
  ).toBeVisible();
}
async function addTask(page: Page, container: Locator, name: string) {
  await container
    .getByRole('button', { name: 'Add task', exact: true })
    .first()
    .click();
  const field = page.getByRole('textbox', { name: 'Task title', exact: true });
  await field.fill(name);
  await field.press('Enter');
  await expect(
    container.getByRole('checkbox', { name: `Complete ${name}`, exact: true }),
  ).toBeVisible();
}
async function rawState(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<{ version: number; stores: Record<string, unknown[]> }>(
        (resolve, reject) => {
          const request = indexedDB.open(name);
          request.onerror = () => reject(new Error('Read failed'));
          request.onsuccess = () => {
            const db = request.result;
            const names = [
              'tasks',
              'categories',
              'groups',
              'completionEvents',
              'outbox',
              'meta',
            ];
            const tx = db.transaction(names);
            const requests = names.map((key) => ({
              key,
              request: tx.objectStore(key).getAll(),
            }));
            tx.oncomplete = () => {
              resolve({
                version: db.version,
                stores: Object.fromEntries(
                  requests.map((item) => [item.key, item.request.result]),
                ),
              });
              db.close();
            };
            tx.onerror = () => {
              reject(new Error('Read failed'));
              db.close();
            };
          };
        },
      ),
    dbName,
  );
}
async function confirmDelete(page: Page, button: Locator) {
  page.once('dialog', (dialog) => dialog.accept());
  await button.click();
}

test('hierarchy creates, renames, collapses and moves tasks with shared editing and counts', async ({
  page,
}) => {
  await open(page);
  await category(page, 'Work');
  await group(page, 'Work', 'Inbox');
  await category(page, 'Personal');
  await group(page, 'Personal', 'Errands');
  const inbox = page.getByLabel('Group: Inbox', { exact: true });
  await addTask(page, inbox, 'Organized task');
  await expect(inbox.locator('summary')).toContainText('0/1 completed (shown)');
  await inbox.locator('summary').click();
  await expect(inbox.getByRole('checkbox')).not.toBeVisible();
  await inbox.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(inbox.getByRole('checkbox')).toBeVisible();
  await inbox
    .getByRole('button', { name: 'Rename group', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Rename name', exact: true })
    .fill('Actions');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page
    .getByLabel('Category: Work', { exact: true })
    .getByRole('button', { name: 'Rename category', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Rename name', exact: true })
    .fill('Office');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.getByRole('link', { name: 'Big List', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('form', {
    name: 'Edit Organized task',
    exact: true,
  });
  await edit
    .getByLabel('Category', { exact: true })
    .selectOption({ label: 'Personal' });
  await edit
    .getByLabel('Group', { exact: true })
    .selectOption({ label: 'Errands' });
  await edit.getByLabel('Due date', { exact: true }).fill('2020-02-29');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('link', { name: 'Categories', exact: true }).click();
  const errands = page.getByLabel('Group: Errands', { exact: true });
  await expect(
    errands.getByRole('checkbox', {
      name: 'Complete Organized task',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Group: Actions', { exact: true }).getByRole('checkbox'),
  ).toHaveCount(0);
  await errands.getByRole('checkbox').click();
  await expect(errands.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(errands.locator('summary')).toContainText(
    '1/1 completed (shown)',
  );
  await expect(
    errands.getByRole('checkbox', {
      name: 'Reopen Organized task',
      exact: true,
    }),
  ).toBeChecked();
  expect((await rawState(page)).stores.tasks).toHaveLength(1);
});

test('group/category deletion confirms, preserves history and atomically clears assignments including tombstones', async ({
  page,
}) => {
  await open(page);
  await category(page, 'Parent');
  await group(page, 'Parent', 'Child');
  const parent = page.getByLabel('Category: Parent', { exact: true });
  const child = page.getByLabel('Group: Child', { exact: true });
  await addTask(page, parent, 'Direct');
  await addTask(page, child, 'Grouped');
  await child.getByRole('checkbox').click();
  await expect(child.getByRole('checkbox')).toHaveCount(0);
  const before = await rawState(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await child
    .getByRole('button', { name: 'Delete group', exact: true })
    .click();
  expect(await rawState(page)).toEqual(before);
  await confirmDelete(
    page,
    child.getByRole('button', { name: 'Delete group', exact: true }),
  );
  await expect(child).toHaveCount(0);
  const groupDeleted = await rawState(page);
  expect(groupDeleted.stores.tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: 'Grouped',
        groupId: null,
        categoryId: expect.any(String),
        completed: true,
      }),
    ]),
  );
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await page
    .getByRole('listitem', { name: 'Task: Grouped', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await confirmDelete(
    page,
    parent.getByRole('button', { name: 'Delete category', exact: true }),
  );
  await expect(parent).toHaveCount(0);
  const after = await rawState(page);
  expect(after.stores.tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: 'Grouped',
        categoryId: null,
        groupId: null,
        deletedAt: expect.any(String),
      }),
      expect.objectContaining({
        title: 'Direct',
        categoryId: null,
        groupId: null,
      }),
    ]),
  );
  expect(after.stores.completionEvents).toEqual(before.stores.completionEvents);
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(
    page
      .getByLabel('Uncategorized', { exact: true })
      .getByRole('checkbox', { name: 'Reopen Grouped', exact: true }),
  ).toBeVisible();
});

test('chronological due/creation/completion modes share data and deadline strings do not shift timezones', async ({
  page,
}) => {
  await open(page, '/list');
  const title = page.getByRole('textbox', { name: 'Task title', exact: true });
  await title.fill('No deadline');
  await title.press('Enter');
  await expect(
    page.getByRole('checkbox', { name: 'Complete No deadline', exact: true }),
  ).toBeVisible();
  await title.fill('Overdue task');
  await page
    .getByText('Organization and due date', { exact: true })
    .first()
    .click();
  await page
    .getByRole('form', { name: 'Create task', exact: true })
    .getByLabel('Due date', { exact: true })
    .fill('2020-02-29');
  await title.press('Enter');
  await expect(
    page.getByRole('checkbox', { name: 'Complete Overdue task', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Date', exact: true }).click();
  await expect(
    page.getByLabel('Date: 2020-02-29', { exact: true }),
  ).toContainText('Overdue');
  await expect(
    page.getByLabel('Date: No due date', { exact: true }),
  ).toContainText('No deadline');
  await page
    .getByRole('checkbox', { name: 'Complete Overdue task', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Complete Overdue task', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('Group dates by', { exact: true })
    .selectOption('completed');
  await expect(
    page.getByRole('button', { name: 'Completed', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('checkbox', { name: 'Reopen Overdue task', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('form', {
    name: 'Edit Overdue task',
    exact: true,
  });
  await expect(edit.getByLabel('Due date', { exact: true })).toHaveValue(
    '2020-02-29',
  );
  await edit.getByLabel('Due date', { exact: true }).fill('2030-12-31');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Reopen Overdue task', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page
    .getByLabel('Group dates by', { exact: true })
    .selectOption('created');
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await page.getByLabel('Group dates by', { exact: true }).selectOption('due');
  await expect(
    page.getByLabel('Date: 2030-12-31', { exact: true }),
  ).toContainText('Overdue task');
});

test('duplicate and blank names retain drafts and do not add commands', async ({
  page,
}) => {
  await open(page);
  await category(page, 'Unique');
  const before = await rawState(page);
  await page.getByRole('button', { name: 'New category', exact: true }).click();
  const field = page.getByRole('textbox', {
    name: 'Category name',
    exact: true,
  });
  await field.fill('   ');
  await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Enter a name');
  await field.fill(' unique ');
  await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('already exists');
  await expect(field).toHaveValue(' unique ');
  expect(await rawState(page)).toEqual(before);
});

test('offline organizational CRUD persists across reloads and a full browser restart', async ({
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), 'taskmaster-phase3-'));
  let context = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  try {
    let page = await context.newPage();
    await page.goto(`${baseURL ?? 'http://127.0.0.1:4173'}/categories`);
    await expect(
      page
        .getByRole('complementary', { name: 'Application availability' })
        .getByRole('status'),
    ).toHaveText('Application shell ready offline.');
    await expect(page.getByText(/changes retained locally/)).toBeVisible();
    await context.setOffline(true);
    await category(page, 'Offline category');
    await group(page, 'Offline category', 'Offline group');
    await addTask(
      page,
      page.getByLabel('Group: Offline group', { exact: true }),
      'Offline organized',
    );
    await page.reload();
    await expect(
      page
        .getByLabel('Group: Offline group', { exact: true })
        .getByRole('checkbox'),
    ).toBeVisible();
    const before = await rawState(page);
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
    });
    await context.setOffline(true);
    page = await context.newPage();
    await page.goto(`${baseURL ?? 'http://127.0.0.1:4173'}/categories`);
    await expect(
      page
        .getByLabel('Group: Offline group', { exact: true })
        .getByRole('checkbox'),
    ).toBeVisible();
    expect(await rawState(page)).toEqual(before);
    await page.getByRole('link', { name: 'Date', exact: true }).click();
    await expect(
      page
        .getByLabel('Date: No due date', { exact: true })
        .getByRole('checkbox'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const offlineEdit = page.getByRole('form', {
      name: 'Edit Offline organized',
      exact: true,
    });
    await offlineEdit
      .getByLabel('Due date', { exact: true })
      .fill('2030-03-31');
    await offlineEdit
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      page
        .getByLabel('Date: 2030-03-31', { exact: true })
        .getByRole('checkbox'),
    ).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByLabel('Date: 2030-03-31', { exact: true })
        .getByRole('checkbox'),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Categories', exact: true }).click();
    await confirmDelete(
      page,
      page
        .getByLabel('Category: Offline category', { exact: true })
        .getByRole('button', { name: 'Delete category', exact: true }),
    );
    await expect(
      page.getByLabel('Category: Offline category', { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByLabel('Uncategorized', { exact: true }).getByRole('checkbox'),
    ).toBeVisible();
    const after = await rawState(page);
    expect(after.stores.outbox).toHaveLength(5);
    expect(after.stores.outbox).toEqual(
      expect.arrayContaining(before.stores.outbox ?? []),
    );
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('real browser v1 migration retains tasks, history, metadata and exact queued payloads', async ({
  page,
}) => {
  // Seed native schema v1 before the application is loaded. These are legacy
  // data, not an IndexedDB mock; the application performs its real v2 migration.
  await page.goto('/icons/taskmaster.svg');
  const fixture = await page.evaluate(
    async ({ name, owner }) => {
      const task = {
        id: '10000000-0000-4000-8000-000000000001',
        ownerId: owner,
        title: 'Legacy v1 task',
        description: 'Keep this note',
        dueDate: null,
        priority: null,
        categoryId: null,
        groupId: null,
        seriesId: null,
        occurrenceDate: null,
        completed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        completedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        revision: null,
        localRevision: 2,
        timestampsProvisional: true,
        currentCompletionId: 'legacy-event',
        lastOperationId: 'legacy-complete',
      };
      const event = {
        id: 'legacy-event',
        ownerId: owner,
        taskId: task.id,
        operationId: 'legacy-complete',
        occurredAt: task.completedAt,
        timeZone: 'UTC',
        kind: 'completion',
        snapshot: {
          title: task.title,
          description: task.description,
          dueDate: null,
          priority: null,
          categoryId: null,
          groupId: null,
          seriesId: null,
          occurrenceDate: null,
        },
      };
      const command = {
        id: 'legacy-complete',
        protocolVersion: 1,
        ownerId: owner,
        deviceId: 'legacy-device',
        taskId: task.id,
        createdAt: task.updatedAt,
        sequence: 1,
        dependsOn: null,
        expectedRevision: null,
        base: null,
        result: task,
        payload: {
          kind: 'complete',
          event,
          legacyExtension: 'must remain byte-for-byte',
        },
        status: 'pending',
      };
      const meta = {
        key: 'workspace',
        ownerId: owner,
        deviceId: 'legacy-device',
        sequence: 1,
      };
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 10);
        request.onupgradeneeded = () => {
          for (const [store, key, indexes] of [
            ['tasks', 'id', ['ownerId', 'createdAt']],
            ['canonicalTasks', 'id', ['ownerId']],
            ['completionEvents', 'id', ['taskId', 'ownerId']],
            ['outbox', 'id', ['sequence', 'taskId']],
            ['meta', 'key', []],
          ] as const) {
            const table = request.result.createObjectStore(store, {
              keyPath: key,
            });
            for (const index of indexes)
              table.createIndex(index, index, { unique: index === 'sequence' });
          }
        };
        request.onerror = () => reject(new Error('Legacy fixture failed'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(
            ['tasks', 'completionEvents', 'outbox', 'meta'],
            'readwrite',
          );
          tx.objectStore('tasks').add(task);
          tx.objectStore('completionEvents').add(event);
          tx.objectStore('outbox').add(command);
          tx.objectStore('meta').add(meta);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(new Error('Legacy fixture write failed'));
          };
        };
      });
      return { task, event, command, meta };
    },
    { name: dbName, owner: ownerId },
  );
  await open(page, '/list');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Reopen Legacy v1 task', exact: true }),
  ).toBeChecked();
  const after = await rawState(page);
  expect(after.version).toBe(30);
  expect(after.stores.tasks).toEqual([fixture.task]);
  expect(after.stores.completionEvents).toEqual([fixture.event]);
  expect(after.stores.outbox).toEqual([fixture.command]);
  expect(after.stores.meta).toEqual([fixture.meta]);
  expect(after.stores.categories).toEqual([]);
  expect(after.stores.groups).toEqual([]);
  await page
    .getByRole('checkbox', { name: 'Reopen Legacy v1 task', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const reopened = await rawState(page);
  expect(reopened.stores.outbox).toHaveLength(2);
  expect(reopened.stores.outbox).toEqual(
    expect.arrayContaining([
      fixture.command,
      expect.objectContaining({
        protocolVersion: 2,
        dependencies: ['legacy-complete'],
        sequence: 2,
      }),
    ]),
  );
});

test('real IndexedDB rolls back complete organizational cascades on queue failure', async ({
  page,
}) => {
  await installFailureProbe(page);
  await open(page);
  await category(page, 'Atomic parent');
  await group(page, 'Atomic parent', 'Atomic group');
  await addTask(
    page,
    page.getByLabel('Group: Atomic group', { exact: true }),
    'Atomic task',
  );
  const before = await rawState(page);
  await page.evaluate(() => {
    window.failOutbox = true;
  });
  for (const [container, button] of [
    ['Group: Atomic group', 'Delete group'],
    ['Category: Atomic parent', 'Delete category'],
  ]) {
    await confirmDelete(
      page,
      page
        .getByLabel(container ?? '', { exact: true })
        .getByRole('button', { name: button ?? '', exact: true }),
    );
    await expect(page.getByRole('alert')).toContainText('Storage is full');
    expect(await rawState(page)).toEqual(before);
  }
  await page.evaluate(() => {
    window.failOutbox = false;
  });
  await confirmDelete(
    page,
    page
      .getByLabel('Category: Atomic parent', { exact: true })
      .getByRole('button', { name: 'Delete category', exact: true }),
  );
  await expect(
    page.getByLabel('Category: Atomic parent', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Uncategorized', { exact: true }).getByRole('checkbox'),
  ).toBeVisible();
});

test('quick-add organization selections reset after commit and do not produce a false unsaved-draft prompt', async ({
  page,
}) => {
  await open(page);
  await category(page, 'Capture');
  await group(page, 'Capture', 'Today');
  await page.getByRole('link', { name: 'Big List', exact: true }).click();
  const form = page.getByRole('form', { name: 'Create task', exact: true });
  await form.getByText('Organization and due date', { exact: true }).click();
  await form
    .getByLabel('Category', { exact: true })
    .selectOption({ label: 'Capture' });
  await form
    .getByLabel('Group', { exact: true })
    .selectOption({ label: 'Today' });
  const title = form.getByRole('textbox', { name: 'Task title', exact: true });
  await title.fill('Captured in a group');
  await title.press('Enter');
  await expect(
    page.getByRole('checkbox', {
      name: 'Complete Captured in a group',
      exact: true,
    }),
  ).toBeVisible();
  await expect(form.getByLabel('Category', { exact: true })).toHaveValue('');
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole('link', { name: 'Categories', exact: true }).click();
  await expect(page).toHaveURL(/categories$/);
  await expect(
    page.getByLabel('Group: Today', { exact: true }).getByRole('checkbox'),
  ).toBeVisible();
  expect(dialogs).toEqual([]);
});
