import { beforeEach, afterEach, expect, it } from 'vitest';
import { TaskDatabase } from '../../src/data/local/database';
import { TaskRepository } from '../../src/data/local/taskRepository';
import { OrganizationRepository } from '../../src/data/local/organizationRepository';
import { successorId } from '../../src/domain/recurrence';
import type { TaskInput } from '../../src/domain/task';

const owner = '00000000-0000-4000-8000-000000000002';
let db: TaskDatabase;
let repo: TaskRepository;
let organizations: OrganizationRepository;
let now: string;
let id: number;
function runtime(offset = 0) {
  let deviceId = offset;
  return {
    uuid: () =>
      `00000000-0000-4000-8000-${String(offset ? ++deviceId : ++id).padStart(12, '0')}`,
    now: () => new Date(now),
    timeZone: () => 'America/New_York',
  };
}
beforeEach(() => {
  now = '2026-10-24T12:00:00Z';
  id = 0;
  db = new TaskDatabase(`recurrence:${crypto.randomUUID()}`);
  repo = new TaskRepository(db, owner, runtime());
  organizations = new OrganizationRepository(db, owner, runtime());
});
afterEach(async () => {
  await db.delete();
});
function create(input: Partial<TaskInput> = {}) {
  return repo.create({
    title: 'Recurring',
    recurrence: {
      frequency: 'daily',
      anchorDate: '2026-10-21',
      timeZone: 'America/New_York',
    },
    ...input,
  });
}
async function active() {
  return (await repo.read()).tasks.filter(
    (task) => !task.completed && !task.deletedAt,
  );
}
async function next() {
  const task = (await active())[0];
  if (!task) throw new Error('Missing active task');
  return task;
}
async function all() {
  return {
    tasks: await db.tasks.toArray(),
    series: await db.recurrenceSeries.toArray(),
    events: await db.completionEvents.toArray(),
    outbox: await db.outbox.toArray(),
    meta: await db.meta.toArray(),
  };
}

it('creates one active occurrence and stable series/template in a single queued command', async () => {
  const task = await create({ description: 'Notes', priority: 'high' });
  const series = await db.recurrenceSeries.get(task.seriesId ?? '');
  expect(task).toMatchObject({
    dueDate: '2026-10-21',
    occurrenceDate: '2026-10-21',
  });
  expect(series).toMatchObject({
    activeTaskId: task.id,
    enabled: true,
    scheduleRevision: 1,
    localRevision: 1,
    revision: null,
    template: { title: 'Recurring', description: 'Notes', priority: 'high' },
  });
  const command = await db.outbox.get(task.lastOperationId);
  expect(
    command?.protocolVersion === 2 &&
      command.changes.map((change) => change.kind),
  ).toEqual(['task', 'series']);
  expect(await db.outbox.count()).toBe(1);
  expect(await active()).toHaveLength(1);
});
it('completion skips missed slots and atomically records full frozen intent, successor and revision reads', async () => {
  const original = await create();
  const completed = await repo.complete(original);
  const successor = await next();
  expect(successor.dueDate).toBe('2026-10-25');
  expect(successor.occurrenceDate).toBe('2026-10-25');
  expect(successor.seriesId).toBe(original.seriesId);
  expect(successor.id).toBe(
    successorId(
      original.seriesId ?? '',
      '2026-10-25',
      completed.lastOperationId,
    ),
  );
  const event = await db.completionEvents.get(
    completed.currentCompletionId ?? '',
  );
  expect(event).toMatchObject({
    kind: 'completion',
    snapshot: { dueDate: '2026-10-21', seriesId: original.seriesId },
    recurrence: {
      successorId: successor.id,
      completionDate: '2026-10-24',
      timeZone: 'America/New_York',
      scheduleRevision: 1,
    },
  });
  const command = await db.outbox.get(completed.lastOperationId);
  if (command?.protocolVersion !== 2) throw new Error('Missing command');
  expect(command.changes.map((change) => change.kind)).toEqual([
    'task',
    'task',
    'series',
  ]);
  expect(command.reads.map((read) => read.kind)).toEqual(['task', 'series']);
  expect(command.dependencies).toContain(original.lastOperationId);
  expect(
    (await db.recurrenceSeries.get(original.seriesId ?? ''))?.activeTaskId,
  ).toBe(successor.id);
  expect(await db.completionEvents.count()).toBe(1);
  expect(await db.outbox.count()).toBe(2);
});
it('simultaneous tabs retry the same frozen completion without extra history, commands or advancement', async () => {
  const task = await create();
  const second = new TaskRepository(db, owner, runtime(500));
  const [a, b] = await Promise.all([
    repo.complete(task),
    second.complete(task),
  ]);
  expect(a).toEqual(b);
  expect(await repo.complete(task)).toEqual(a);
  expect(await active()).toHaveLength(1);
  expect(await db.tasks.count()).toBe(2);
  expect(await db.completionEvents.count()).toBe(1);
  expect(await db.outbox.count()).toBe(2);
});
it('undo tombstones the untouched successor, retains history, and recompletion gets a new identity', async () => {
  const task = await create();
  const completed = await repo.complete(task);
  const successor = await next();
  const reopened = await repo.reopen(completed);
  expect((await next()).id).toBe(task.id);
  expect((await db.tasks.get(successor.id))?.deletedAt).not.toBeNull();
  expect(await db.completionEvents.count()).toBe(2);
  await expect(repo.complete(task)).rejects.toThrow(/changed/);
  await repo.complete(reopened);
  expect((await next()).id).not.toBe(successor.id);
  expect(await db.completionEvents.count()).toBe(3);
  expect(await active()).toHaveLength(1);
});
it('edited successor blocks undo; explicit standalone reopening preserves the active series', async () => {
  const completed = await repo.complete(await create());
  const successor = await next();
  const edited = await repo.edit(successor, { title: 'Updated successor' });
  const before = await all();
  await expect(repo.reopen(completed)).rejects.toThrow(/Undo is blocked/);
  expect(await all()).toEqual(before);
  const standalone = await repo.reopenStandalone(completed);
  expect(standalone.seriesId).toBeNull();
  expect((await db.tasks.get(edited.id))?.completed).toBe(false);
  expect(await active()).toHaveLength(2);
  await repo.complete(standalone);
  expect(await active()).toHaveLength(1);
  expect(await db.tasks.count()).toBe(2);
});
it('historical reopening after another completion cannot corrupt the current occurrence', async () => {
  const first = await repo.complete(await create());
  await repo.complete(await next());
  const current = await next();
  await expect(repo.reopen(first)).rejects.toThrow(/Undo is blocked/);
  await repo.reopenStandalone(first);
  expect(
    (await db.recurrenceSeries.get(first.seriesId ?? ''))?.activeTaskId,
  ).toBe(current.id);
});
it('metadata edits update only the current template and future occurrence, never past snapshots', async () => {
  const completed = await repo.complete(await create());
  const history = await db.completionEvents.toArray();
  await repo.edit(completed, { title: 'Historical title' });
  const current = await repo.edit(await next(), {
    title: 'Future title',
    description: 'Template',
  });
  await repo.complete(current);
  expect((await next()).title).toBe('Future title');
  expect(await db.completionEvents.get(history[0]?.id ?? '')).toEqual(
    history[0],
  );
});
it('due-date-only edits preserve anchor and occurrence identity; explicit schedule changes reanchor', async () => {
  let task = await create({
    recurrence: {
      frequency: 'monthly',
      anchorDate: '2026-01-31',
      timeZone: 'UTC',
    },
  });
  task = await repo.edit(task, { title: task.title, dueDate: '2026-10-30' });
  expect(task.occurrenceDate).toBe('2026-01-31');
  expect((await db.recurrenceSeries.get(task.seriesId ?? ''))?.anchorDate).toBe(
    '2026-01-31',
  );
  const oldId = task.id;
  task = await repo.edit(task, {
    title: task.title,
    recurrence: {
      frequency: 'weekly',
      anchorDate: '2026-10-26',
      timeZone: 'Asia/Tokyo',
    },
  });
  expect(task.id).not.toBe(oldId);
  const retired = await db.tasks.get(oldId);
  expect(retired?.occurrenceDate).toBe('2026-01-31');
  expect(retired?.deletedAt).not.toBeNull();
  expect(task.dueDate).toBe('2026-10-26');
  expect(task.occurrenceDate).toBe('2026-10-26');
  expect(
    (await db.recurrenceSeries.get(task.seriesId ?? ''))?.scheduleRevision,
  ).toBe(2);
  await repo.complete(task);
  expect((await next()).dueDate).toBe('2026-11-02');
});
it('disabling leaves the current occurrence standalone and preserves prior events', async () => {
  await repo.complete(await create());
  const task = await next();
  const seriesId = task.seriesId;
  const detached = await repo.edit(task, {
    title: task.title,
    recurrence: null,
  });
  expect(detached.seriesId).toBeNull();
  expect(await db.recurrenceSeries.get(seriesId ?? '')).toMatchObject({
    enabled: false,
    activeTaskId: null,
  });
  await repo.complete(detached);
  expect(await active()).toHaveLength(0);
  expect(await db.completionEvents.count()).toBe(2);
});
it('deleting an active occurrence disables its series and restore is standalone', async () => {
  const task = await create();
  const deleted = await repo.delete(task);
  expect(await db.recurrenceSeries.get(task.seriesId ?? '')).toMatchObject({
    enabled: false,
    activeTaskId: null,
  });
  const restored = await repo.restore(deleted);
  expect(restored.seriesId).toBeNull();
  expect(await active()).toHaveLength(1);
});
it('deleting a historical occurrence leaves the live series alone and restore cannot duplicate it', async () => {
  const completed = await repo.complete(await create());
  const series = await db.recurrenceSeries.get(completed.seriesId ?? '');
  const deleted = await repo.delete(completed);
  await repo.restore(deleted);
  expect(await db.recurrenceSeries.get(completed.seriesId ?? '')).toEqual(
    series,
  );
  expect(await active()).toHaveLength(1);
});
it('an undone successor can be restored only as a standalone task', async () => {
  const completed = await repo.complete(await create());
  const successor = await next();
  await repo.reopen(completed);
  const tombstone = await db.tasks.get(successor.id);
  if (!tombstone) throw new Error('Missing tombstone');
  const restored = await repo.restore(tombstone);
  expect(restored.seriesId).toBeNull();
  expect(
    (await db.recurrenceSeries.get(completed.seriesId ?? ''))?.activeTaskId,
  ).toBe(completed.id);
});
it('container cascades clear template references atomically while retaining history', async () => {
  const category = await organizations.createCategory('Work');
  const group = await organizations.createGroup(category, 'Core');
  const task = await create({ categoryId: category.id, groupId: group.id });
  await repo.complete(task);
  const events = await db.completionEvents.toArray();
  await organizations.deleteGroup(group);
  const afterGroup = await next();
  expect(afterGroup.categoryId).toBe(category.id);
  expect(afterGroup.groupId).toBeNull();
  expect(
    (await db.recurrenceSeries.get(task.seriesId ?? ''))?.template,
  ).toMatchObject({ categoryId: category.id, groupId: null });
  await organizations.deleteCategory(category);
  const current = await next();
  await repo.complete(current);
  expect((await next()).categoryId).toBeNull();
  expect(await db.completionEvents.get(events[0]?.id ?? '')).toEqual(events[0]);
});
it('outbox failure rolls back completion, successor, series, history and metadata', async () => {
  const task = await create();
  const before = await all();
  function fail() {
    throw new DOMException('Injected', 'QuotaExceededError');
  }
  db.outbox.hook('creating', fail);
  await expect(repo.complete(task)).rejects.toThrow();
  db.outbox.hook('creating').unsubscribe(fail);
  expect(await all()).toEqual(before);
  await repo.complete(task);
  expect(await active()).toHaveLength(1);
});
it('outbox failure rolls back undo and template cascade too', async () => {
  const category = await organizations.createCategory('Work');
  const task = await create({ categoryId: category.id });
  const completed = await repo.complete(task);
  const before = await all();
  function fail() {
    throw new Error('Injected');
  }
  db.outbox.hook('creating', fail);
  await expect(repo.reopen(completed)).rejects.toThrow();
  await expect(organizations.deleteCategory(category)).rejects.toThrow();
  db.outbox.hook('creating').unsubscribe(fail);
  expect(await all()).toEqual(before);
  expect((await db.categories.get(category.id))?.deletedAt).toBeNull();
});
it('invalid settings and date overflow preserve every existing record', async () => {
  await expect(
    create({
      recurrence: { frequency: 'daily', anchorDate: '', timeZone: 'UTC' },
    }),
  ).rejects.toThrow();
  expect(await db.tasks.count()).toBe(0);
  const task = await create({
    recurrence: {
      frequency: 'daily',
      anchorDate: '9999-12-31',
      timeZone: 'UTC',
    },
  });
  const before = await all();
  await expect(repo.complete(task)).rejects.toThrow(/date range/);
  expect(await all()).toEqual(before);
});
it('completed occurrences cannot acquire or change a recurrence configuration', async () => {
  const completed = await repo.complete(await create());
  const before = await all();
  await expect(
    repo.edit(completed, { title: completed.title, recurrence: null }),
  ).rejects.toThrow(/historical/);
  expect(await all()).toEqual(before);
});
it('completion uses the frozen device instant, not monotonic display metadata, on clock reversal', async () => {
  const task = await create();
  now = '2026-10-22T02:00:00Z';
  const completed = await repo.complete(task);
  const event = await db.completionEvents.get(
    completed.currentCompletionId ?? '',
  );
  expect(completed.updatedAt > (completed.completedAt ?? '')).toBe(true);
  expect(event).toMatchObject({
    occurredAt: now.replace('Z', '.000Z'),
    recurrence: { completionDate: '2026-10-21', successorDate: '2026-10-22' },
  });
});
it('two isolated offline replicas retain separate candidate commands for one logical occurrence without pretending to resolve cloud conflicts', async () => {
  const task = await create();
  const clone = new TaskDatabase(`replica:${crypto.randomUUID()}`);
  try {
    await clone.tasks.bulkPut(await db.tasks.toArray());
    await clone.recurrenceSeries.bulkPut(await db.recurrenceSeries.toArray());
    await clone.outbox.bulkPut(await db.outbox.toArray());
    await clone.meta.bulkPut(await db.meta.toArray());
    const other = new TaskRepository(clone, owner, runtime(1000));
    const [a, b] = await Promise.all([
      repo.complete(task),
      other.complete(task),
    ]);
    const eventA = await db.completionEvents.get(a.currentCompletionId ?? '');
    const eventB = await clone.completionEvents.get(
      b.currentCompletionId ?? '',
    );
    expect(eventA?.taskId).toBe(eventB?.taskId);
    expect(eventA?.id).not.toBe(eventB?.id);
    if (eventA?.kind !== 'completion' || eventB?.kind !== 'completion')
      throw new Error('Missing events');
    expect(eventA.recurrence?.occurrenceDate).toBe(
      eventB.recurrence?.occurrenceDate,
    );
    expect(eventA.recurrence?.successorId).not.toBe(
      eventB.recurrence?.successorId,
    );
    expect((await active()).length).toBe(1);
    expect(
      (await other.read()).tasks.filter(
        (row) => !row.completed && !row.deletedAt,
      ),
    ).toHaveLength(1);
    expect(await clone.outbox.count()).toBe(2);
    expect(await db.outbox.count()).toBe(2);
  } finally {
    await clone.delete();
  }
});

it('clearing a deadline keeps the immutable schedule and still advances on completion', async () => {
  const task = await create();
  const edited = await repo.edit(task, { title: task.title, dueDate: null });
  expect(edited.dueDate).toBeNull();
  expect(edited.occurrenceDate).toBe('2026-10-21');
  await repo.complete(edited);
  expect((await next()).dueDate).toBe('2026-10-25');
});
