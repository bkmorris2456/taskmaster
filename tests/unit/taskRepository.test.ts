import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TaskDatabase,
  schemaV1,
  schemaV2,
  schemaV3,
} from '../../src/data/local/database';
import { TaskRepository } from '../../src/data/local/taskRepository';
import type { TaskInput } from '../../src/domain/task';
import { TaskError, persistenceMessage } from '../../src/domain/task';

const owner = '00000000-0000-4000-8000-000000000002';
let db: TaskDatabase;
let repository: TaskRepository;
let date: string;
let nextId: number;
beforeEach(() => {
  db = new TaskDatabase(`test:${crypto.randomUUID()}`);
  date = '2026-10-20T12:00:00.000Z';
  nextId = 0;
  repository = new TaskRepository(db, owner, {
    uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => new Date(date),
    timeZone: () => 'America/New_York',
  });
});
afterEach(async () => {
  await db.delete();
});

describe('transactional local tasks', () => {
  it('creates with stable identity, defaults, provisional metadata and a durable command', async () => {
    const task = await repository.create({
      title: '  Test task  ',
      description: 'Notes',
    });
    expect(task).toMatchObject({
      title: 'Test task',
      description: 'Notes',
      ownerId: owner,
      completed: false,
      completedAt: null,
      deletedAt: null,
      revision: null,
      localRevision: 1,
      timestampsProvisional: true,
      createdAt: date,
      updatedAt: date,
      categoryId: null,
      groupId: null,
      seriesId: null,
      dueDate: null,
      priority: null,
    });
    expect(task.id).toMatch(/^[\da-f-]{36}$/);
    const command = await db.outbox.get(task.lastOperationId);
    expect(command).toMatchObject({
      protocolVersion: 2,
      taskId: task.id,
      base: null,
      dependsOn: null,
      sequence: 1,
      expectedRevision: null,
      status: 'pending',
      result: task,
    });
    expect(await db.canonicalTasks.count()).toBe(0);
  });

  it.each(['', '   ', '\n\t', 'x'.repeat(241)])(
    'rejects invalid title %j atomically',
    async (title) => {
      expect(() => repository.create({ title })).toThrow(TaskError);
      expect(await db.tasks.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
      expect(await db.meta.count()).toBe(0);
    },
  );

  it('enforces description limits and preserves plain-text whitespace', async () => {
    expect(() =>
      repository.create({ title: 'Valid', description: 'x'.repeat(10001) }),
    ).toThrow(TaskError);
    const task = await repository.create({
      title: 'Valid',
      description: ' \n<script>plain text</script> ',
    });
    expect(task.description).toBe(' \n<script>plain text</script> ');
    const edited = await repository.edit(task, {
      title: 'Valid',
      description: '',
    });
    expect(edited.description).toBeNull();
  });

  it('edits title/description, keeps creation identity and links immutable operation dependencies', async () => {
    const task = await repository.create({ title: 'Before' });
    const firstCommand = await db.outbox.get(task.lastOperationId);
    date = '2026-10-20T13:00:00.000Z';
    const edited = await repository.edit(task, {
      title: 'After',
      description: 'Updated notes',
    });
    expect(edited).toMatchObject({
      id: task.id,
      createdAt: task.createdAt,
      updatedAt: date,
      title: 'After',
      localRevision: 2,
    });
    expect(await db.outbox.get(edited.lastOperationId)).toMatchObject({
      base: task,
      dependsOn: task.lastOperationId,
      sequence: 2,
      payload: { kind: 'edit' },
    });
    expect(await db.outbox.get(task.lastOperationId)).toEqual(firstCommand);
  });

  it('keeps modification timestamps increasing even when device time moves backwards', async () => {
    const task = await repository.create({ title: 'Clock' });
    date = '2020-01-01T00:00:00.000Z';
    const edited = await repository.edit(task, { title: 'Clock edited' });
    expect(edited.updatedAt).toBe('2026-10-20T12:00:00.001Z');
    expect(edited.createdAt).toBe(task.createdAt);
    expect(edited.revision).toBeNull();
  });

  it('rejects an invalid device clock without creating records', async () => {
    date = 'invalid';
    await expect(repository.create({ title: 'Clock' })).rejects.toThrow(
      'clock',
    );
    expect(await db.tasks.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('completes, undoes/reopens and completes again without erasing historical snapshots', async () => {
    const task = await repository.create({
      title: 'Original',
      description: 'Snapshot',
    });
    const done = await repository.complete(task);
    expect(done.completed).toBe(true);
    expect(done.completedAt).toBe(done.updatedAt);
    const completion = await db.completionEvents.get(
      done.currentCompletionId ?? '',
    );
    expect(completion).toMatchObject({
      kind: 'completion',
      snapshot: { title: 'Original', description: 'Snapshot' },
      timeZone: 'America/New_York',
    });
    const reopened = await repository.reopen(done);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.completed).toBe(false);
    const edited = await repository.edit(reopened, { title: 'New title' });
    await repository.complete(edited);
    const events = await db.completionEvents.toArray();
    expect(events.filter((event) => event.kind === 'completion')).toHaveLength(
      2,
    );
    expect(events.find((event) => event.kind === 'reversal')).toMatchObject({
      reversesEventId: completion?.id,
    });
    expect(await db.completionEvents.get(completion?.id ?? '')).toEqual(
      completion,
    );
  });

  it('rejects stale duplicate completions without duplicate history or commands', async () => {
    const task = await repository.create({ title: 'Once' });
    await repository.complete(task);
    await expect(repository.complete(task)).rejects.toThrow(
      'changed in another tab',
    );
    expect(await db.completionEvents.count()).toBe(1);
    expect(await db.outbox.count()).toBe(2);
  });

  it('retains tombstones, history and command identity through delete and restore', async () => {
    const task = await repository.complete(
      await repository.create({ title: 'Keep history' }),
    );
    const events = await db.completionEvents.toArray();
    const deleted = await repository.delete(task);
    expect(deleted.deletedAt).toBe(deleted.updatedAt);
    await expect(
      repository.edit(deleted, { title: 'Lost edit' }),
    ).rejects.toThrow('deleted');
    const restored = await repository.restore(deleted);
    expect(restored.id).toBe(task.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.completed).toBe(true);
    expect(await db.completionEvents.toArray()).toEqual(events);
    expect(await db.outbox.count()).toBe(4);
  });

  it('rolls back projection, history, metadata and command when outbox insertion fails', async () => {
    const task = await repository.create({ title: 'Atomic' });
    const beforeMeta = await db.meta.toArray();
    const failure = () => {
      throw new DOMException('No space', 'QuotaExceededError');
    };
    db.outbox.hook('creating', failure);
    await expect(repository.complete(task)).rejects.toThrow();
    db.outbox.hook('creating').unsubscribe(failure);
    expect(await db.tasks.get(task.id)).toEqual(task);
    expect(await db.completionEvents.count()).toBe(0);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.meta.toArray()).toEqual(beforeMeta);
    await repository.complete(task);
    expect(await db.outbox.count()).toBe(2);
  });

  it('detects concurrent tab edits instead of overwriting the winning change', async () => {
    const task = await repository.create({ title: 'Base' });
    const otherDb = new TaskDatabase(db.name);
    const other = new TaskRepository(otherDb, owner);
    try {
      const results = await Promise.allSettled([
        repository.edit(task, { title: 'First' }),
        other.edit(task, { title: 'Second' }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await db.outbox.count()).toBe(2);
    } finally {
      otherDb.close();
    }
  });

  it('survives closing and reopening the database, including durable outbox and device ID', async () => {
    const task = await repository.create({ title: 'Persist' });
    const meta = await db.meta.toArray();
    const commands = await db.outbox.toArray();
    const name = db.name;
    db.close();
    db = new TaskDatabase(name);
    const reopened = new TaskRepository(db, owner);
    expect((await reopened.read()).tasks).toEqual([task]);
    expect(await db.outbox.toArray()).toEqual(commands);
    expect(await db.meta.toArray()).toEqual(meta);
  });

  it('isolates database names and rejects mixed owner rows without discarding data', async () => {
    await repository.create({ title: 'Owner A' });
    const wrong = new TaskRepository(db, 'different-owner');
    await expect(wrong.read()).rejects.toThrow('different local identity');
    await expect(wrong.create({ title: 'Owner B' })).rejects.toThrow(
      'identity mismatch',
    );
    expect(await db.tasks.count()).toBe(1);
    const separate = new TaskDatabase(`${db.name}:other`);
    try {
      expect(
        (await new TaskRepository(separate, 'different-owner').read()).tasks,
      ).toEqual([]);
    } finally {
      await separate.delete();
    }
  });

  it('permits additive version upgrades without resetting data or queued intent', async () => {
    const task = await repository.create({ title: 'Migrate' });
    const commands = await db.outbox.toArray();
    const name = db.name;
    db.close();
    const upgraded = new Dexie(name);
    upgraded.version(1).stores(schemaV1);
    upgraded.version(2).stores(schemaV2);
    upgraded.version(3).stores(schemaV3);
    upgraded.version(4).stores({ tasks: 'id, ownerId, createdAt, updatedAt' });
    await upgraded.open();
    expect(await upgraded.table('tasks').get(task.id)).toEqual(task);
    expect(await upgraded.table('outbox').toArray()).toEqual(commands);
    upgraded.close();
    db = new TaskDatabase(name);
    // A rollback to an older application refuses the newer schema; it must not reset it.
    await expect(db.open()).rejects.toThrow();
    const recovery = new Dexie(name);
    await recovery.open();
    expect(await recovery.table('tasks').get(task.id)).toEqual(task);
    recovery.close();
  });

  it('aborts a failed migration and leaves the previous schema/data intact', async () => {
    const task = await repository.create({ title: 'Safe migration' });
    const name = db.name;
    db.close();
    const upgrade = new Dexie(name);
    upgrade.version(1).stores(schemaV1);
    upgrade.version(2).stores(schemaV2);
    upgrade.version(3).stores(schemaV3);
    upgrade
      .version(4)
      .stores({ tasks: 'id, updatedAt' })
      .upgrade(async (tx) => {
        await tx.table('tasks').clear();
        throw new Error('Migration failure');
      });
    await expect(upgrade.open()).rejects.toThrow('Migration failure');
    upgrade.close();
    db = new TaskDatabase(name);
    expect(await db.tasks.get(task.id)).toEqual(task);
    expect(await db.outbox.count()).toBe(1);
  });

  it('returns useful persistence errors without leaking internal data', () => {
    expect(
      persistenceMessage(
        new DOMException('private diagnostic', 'QuotaExceededError'),
      ),
    ).toContain('Storage is full');
    expect(persistenceMessage(new Error('secret'))).not.toContain('secret');
  });
});

it('persists optional priority changes atomically in task, command and completion snapshot', async () => {
  const task = await repository.create({
    title: 'Priority',
    priority: 'normal',
  });
  expect(task.priority).toBe('normal');
  const edited = await repository.edit(task, {
    title: task.title,
    priority: 'high',
  });
  const completed = await repository.complete(edited);
  expect((await db.tasks.get(task.id))?.priority).toBe('high');
  expect((await db.outbox.get(edited.lastOperationId))?.payload).toMatchObject({
    input: { priority: 'high' },
  });
  expect(
    await db.completionEvents.get(completed.currentCompletionId ?? ''),
  ).toMatchObject({ snapshot: { priority: 'high' } });
  const reopened = await repository.reopen(completed);
  expect(
    (await repository.edit(reopened, { title: task.title, priority: null }))
      .priority,
  ).toBeNull();
  expect(() =>
    repository.create(
      JSON.parse('{"title":"Bad","priority":"urgent"}') as TaskInput,
    ),
  ).toThrow('valid priority');
});
