import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  LocalCommand,
  LocalCommandV2,
} from '../../src/data/local/database';
import { TaskDatabase, schemaV1 } from '../../src/data/local/database';
import { TaskRepository } from '../../src/data/local/taskRepository';
import { OrganizationRepository } from '../../src/data/local/organizationRepository';

function v2(command: LocalCommand | undefined): LocalCommandV2 {
  if (command?.protocolVersion !== 2) throw new Error('Expected v2 command');
  return command;
}

const owner = 'owner-a';
let db: TaskDatabase;
let tasks: TaskRepository;
let organizations: OrganizationRepository;
beforeEach(() => {
  db = new TaskDatabase(`organization-test:${crypto.randomUUID()}`);
  tasks = new TaskRepository(db, owner);
  organizations = new OrganizationRepository(db, owner);
});
afterEach(async () => {
  await db.delete();
});

describe('organization invariants and command transactions', () => {
  it('creates and renames categories/groups with stable IDs and v2 intent', async () => {
    const category = await organizations.createCategory('  Work  ');
    const group = await organizations.createGroup(category, ' Inbox ');
    const renamed = await organizations.renameGroup(group, 'Actions');
    const renamedCategory = await organizations.renameCategory(
      category,
      'Office',
    );
    expect(category.name).toBe('Work');
    expect(renamed).toMatchObject({
      id: group.id,
      categoryId: category.id,
      name: 'Actions',
      localRevision: 2,
      revision: null,
      timestampsProvisional: true,
    });
    expect(renamed.createdAt).toBe(group.createdAt);
    expect(renamed.updatedAt > group.updatedAt).toBe(true);
    expect(renamedCategory.id).toBe(category.id);
    const commands = await db.outbox.orderBy('sequence').toArray();
    expect(commands).toHaveLength(4);
    expect(commands[1]).toMatchObject({
      protocolVersion: 2,
      dependencies: [category.lastOperationId],
    });
    expect(v2(commands[2]).dependencies).toEqual(
      expect.arrayContaining([group.lastOperationId, category.lastOperationId]),
    );
    expect(await db.canonicalCategories.count()).toBe(0);
    expect(await db.canonicalGroups.count()).toBe(0);
  });

  it.each(['', '   ', 'a'.repeat(81)])(
    'rejects invalid organizational names %j without queued changes',
    async (name) => {
      await expect(organizations.createCategory(name)).rejects.toThrow();
      expect(await db.categories.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
    },
  );

  it('rejects normalized duplicate category names and duplicate group names within a parent', async () => {
    const a = await organizations.createCategory('Café');
    await expect(organizations.createCategory(' CAFE\u0301 ')).rejects.toThrow(
      'already exists',
    );
    const b = await organizations.createCategory('Other');
    await organizations.createGroup(a, 'Inbox');
    await expect(organizations.createGroup(a, 'inbox')).rejects.toThrow(
      'already exists',
    );
    await organizations.createGroup(b, 'Inbox');
    await expect(organizations.renameCategory(b, 'CAFÉ')).rejects.toThrow(
      'already exists',
    );
  });

  it('serializes duplicate creation from separate database connections', async () => {
    const otherDb = new TaskDatabase(db.name);
    try {
      const other = new OrganizationRepository(otherDb, owner);
      const results = await Promise.allSettled([
        organizations.createCategory('Same'),
        other.createCategory('same'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await db.categories.count()).toBe(1);
      expect(await db.outbox.count()).toBe(1);
    } finally {
      otherDb.close();
    }
  });

  it('rejects stale edits/deletes and permits reusing a tombstoned name with a new UUID', async () => {
    const category = await organizations.createCategory('Reusable');
    const renamed = await organizations.renameCategory(
      category,
      'Reusable again',
    );
    await expect(organizations.deleteCategory(category)).rejects.toThrow(
      'changed',
    );
    const deleted = await organizations.deleteCategory(renamed);
    expect(deleted.deletedAt).not.toBeNull();
    const recreated = await organizations.createCategory('Reusable again');
    expect(recreated.id).not.toBe(deleted.id);
    expect(await db.categories.count()).toBe(2);
  });

  it('assigns tasks directly, infers a group parent and moves/removes assignments', async () => {
    const a = await organizations.createCategory('A');
    const b = await organizations.createCategory('B');
    const ga = await organizations.createGroup(a, 'A group');
    const gb = await organizations.createGroup(b, 'B group');
    let task = await tasks.create({ title: 'Move', categoryId: a.id });
    task = await tasks.edit(task, { title: task.title, groupId: ga.id });
    expect(task).toMatchObject({ categoryId: a.id, groupId: ga.id });
    task = await tasks.edit(task, { title: task.title, groupId: gb.id });
    expect(task).toMatchObject({ categoryId: b.id, groupId: gb.id });
    task = await tasks.edit(task, { title: task.title, categoryId: a.id });
    expect(task.groupId).toBeNull();
    task = await tasks.edit(task, { title: task.title, categoryId: null });
    expect(task.categoryId).toBeNull();
    expect(task.groupId).toBeNull();
    const command = v2(await db.outbox.get(task.lastOperationId));
    expect(command.changes).toHaveLength(1);
    expect(command.changes[0]?.result).toMatchObject({
      categoryId: null,
      groupId: null,
    });
  });

  it('captures destination parent dependencies and keeps predecessor commands immutable', async () => {
    const category = await organizations.createCategory('Parent');
    const group = await organizations.createGroup(category, 'Group');
    const task = await tasks.create({ title: 'Child', groupId: group.id });
    const create = await db.outbox.get(task.lastOperationId);
    expect(v2(create).dependencies).toEqual(
      expect.arrayContaining([category.lastOperationId, group.lastOperationId]),
    );
    await tasks.edit(task, { title: 'Changed' });
    expect(await db.outbox.get(task.lastOperationId)).toEqual(create);
  });

  it('rejects mismatched, missing, deleted and cross-owner relationships atomically', async () => {
    const a = await organizations.createCategory('A');
    const b = await organizations.createCategory('B');
    const group = await organizations.createGroup(a, 'Group');
    const before = await db.outbox.count();
    await expect(
      tasks.create({ title: 'Invalid', categoryId: b.id, groupId: group.id }),
    ).rejects.toThrow('selected category');
    await expect(
      tasks.create({ title: 'Invalid', categoryId: 'missing' }),
    ).rejects.toThrow('unavailable');
    await expect(
      new TaskRepository(db, 'owner-b').create({
        title: 'Other owner',
        groupId: group.id,
      }),
    ).rejects.toThrow('unavailable');
    expect(await db.tasks.count()).toBe(0);
    expect(await db.outbox.count()).toBe(before);
    await organizations.deleteCategory(a);
    await expect(organizations.createGroup(a, 'Orphan')).rejects.toThrow();
    await expect(
      tasks.create({ title: 'Dead group', groupId: group.id }),
    ).rejects.toThrow('unavailable');
  });

  it('group deletion preserves category, tasks, history and one-command cascade dependencies', async () => {
    const category = await organizations.createCategory('Parent');
    const group = await organizations.createGroup(category, 'Child');
    const task = await tasks.complete(
      await tasks.create({ title: 'Completed', groupId: group.id }),
    );
    const history = await db.completionEvents.toArray();
    const count = await db.outbox.count();
    const deleted = await organizations.deleteGroup(group);
    expect(await db.tasks.get(task.id)).toMatchObject({
      categoryId: category.id,
      groupId: null,
      completed: true,
      localRevision: task.localRevision + 1,
      lastOperationId: deleted.lastOperationId,
    });
    expect(await db.outbox.count()).toBe(count + 1);
    const command = v2(await db.outbox.get(deleted.lastOperationId));
    const change = command.changes.find(
      (item) => item.kind === 'task' && item.result.id === task.id,
    );
    expect(change?.base).toEqual(task);
    expect(change?.result).toMatchObject({ groupId: null });
    expect(command.dependencies).toEqual(
      expect.arrayContaining([
        task.lastOperationId,
        group.lastOperationId,
        category.lastOperationId,
      ]),
    );
    expect(await db.completionEvents.toArray()).toEqual(history);
  });

  it('category deletion tombstones groups and unassigns direct, grouped, completed and deleted tasks', async () => {
    const category = await organizations.createCategory('Parent');
    const group = await organizations.createGroup(category, 'Child');
    const direct = await tasks.create({
      title: 'Direct',
      categoryId: category.id,
    });
    const done = await tasks.complete(
      await tasks.create({ title: 'Done', groupId: group.id }),
    );
    const deletedTask = await tasks.delete(
      await tasks.create({ title: 'Deleted', groupId: group.id }),
    );
    const history = await db.completionEvents.toArray();
    const count = await db.outbox.count();
    const deleted = await organizations.deleteCategory(category);
    expect((await db.groups.get(group.id))?.deletedAt).toBe(deleted.deletedAt);
    for (const task of [direct, done, deletedTask])
      expect(await db.tasks.get(task.id)).toMatchObject({
        id: task.id,
        categoryId: null,
        groupId: null,
        completed: task.completed,
        deletedAt: task.deletedAt,
      });
    expect(await db.outbox.count()).toBe(count + 1);
    const command = v2(await db.outbox.get(deleted.lastOperationId));
    expect(command.dependencies).toEqual(
      expect.arrayContaining([
        category.lastOperationId,
        group.lastOperationId,
        direct.lastOperationId,
        done.lastOperationId,
        deletedTask.lastOperationId,
      ]),
    );
    expect(command.changes).toHaveLength(5);
    expect(await db.completionEvents.toArray()).toEqual(history);
    const tombstone = await db.tasks.get(deletedTask.id);
    if (!tombstone) throw new Error('Missing tombstone');
    expect(await tasks.restore(tombstone)).toMatchObject({
      categoryId: null,
      groupId: null,
    });
  });

  it.each(['category', 'group'] as const)(
    'rolls back every %s cascade effect when outbox insertion fails',
    async (kind) => {
      const category = await organizations.createCategory('Parent');
      const group = await organizations.createGroup(category, 'Child');
      await tasks.create({ title: 'Child task', groupId: group.id });
      const before = {
        categories: await db.categories.toArray(),
        groups: await db.groups.toArray(),
        tasks: await db.tasks.toArray(),
        outbox: await db.outbox.toArray(),
        meta: await db.meta.toArray(),
      };
      const fail = () => {
        throw new Error('Injected failure');
      };
      db.outbox.hook('creating', fail);
      await expect(
        kind === 'category'
          ? organizations.deleteCategory(category)
          : organizations.deleteGroup(group),
      ).rejects.toThrow();
      db.outbox.hook('creating').unsubscribe(fail);
      expect({
        categories: await db.categories.toArray(),
        groups: await db.groups.toArray(),
        tasks: await db.tasks.toArray(),
        outbox: await db.outbox.toArray(),
        meta: await db.meta.toArray(),
      }).toEqual(before);
    },
  );

  it('rejects a stale task edit after parent deletion rather than resurrecting assignments', async () => {
    const category = await organizations.createCategory('Parent');
    const task = await tasks.create({
      title: 'Child',
      categoryId: category.id,
    });
    await organizations.deleteCategory(category);
    await expect(
      tasks.edit(task, { title: 'Stale', categoryId: category.id }),
    ).rejects.toThrow('changed');
    expect((await db.tasks.get(task.id))?.categoryId).toBeNull();
  });

  it.each(['move-first', 'delete-first'])(
    'serializes category deletion and a concurrent task move (%s)',
    async (order) => {
      const a = await organizations.createCategory('A');
      const b = await organizations.createCategory('B');
      const ga = await organizations.createGroup(a, 'GA');
      const gb = await organizations.createGroup(b, 'GB');
      const task = await tasks.create({ title: 'Race', groupId: ga.id });
      const secondDb = new TaskDatabase(db.name);
      const other = new TaskRepository(secondDb, owner);
      try {
        const move = () =>
          other.edit(task, { title: task.title, groupId: gb.id });
        const remove = () => organizations.deleteCategory(a);
        const results = await Promise.allSettled(
          order === 'move-first' ? [move(), remove()] : [remove(), move()],
        );
        expect(results.some((result) => result.status === 'fulfilled')).toBe(
          true,
        );
        const current = await db.tasks.get(task.id);
        expect(
          current?.categoryId === null || current?.categoryId === b.id,
        ).toBe(true);
        expect(current?.groupId === null || current?.groupId === gb.id).toBe(
          true,
        );
        expect((await db.categories.get(a.id))?.deletedAt).not.toBeNull();
        expect(await db.tasks.count()).toBe(1);
      } finally {
        secondDb.close();
      }
    },
  );

  it('migrates actual v1 data and queue without rewriting any legacy command', async () => {
    const name = db.name;
    db.close();
    const legacy = new Dexie(name);
    legacy.version(1).stores(schemaV1);
    const fixture = {
      id: 'legacy-command',
      protocolVersion: 1,
      ownerId: owner,
      sequence: 1,
      payload: { customUnknownField: 'retain' },
    };
    await legacy.table('outbox').add(fixture);
    legacy.close();
    db = new TaskDatabase(name);
    await db.open();
    expect(db.backendDB().version).toBe(30);
    expect(await db.outbox.get(fixture.id)).toEqual(fixture);
    expect(await db.categories.count()).toBe(0);
    expect(await db.groups.count()).toBe(0);
  });
});
