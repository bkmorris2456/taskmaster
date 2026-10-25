import { touchSeries } from './recurrenceMutations';
import type {
  TaskDatabase,
  EntityChange,
  EntityRead,
  EntityRecord,
} from './database';
import type {
  Category,
  Group,
  OrganizationKind,
} from '../../domain/organization';
import { nameKey, organizationName } from '../../domain/organization';
import { TaskError } from '../../domain/task';
import {
  appendCommand,
  entityRead,
  localRuntime,
  mutationTime,
} from './localCommands';
import type { Runtime } from './localCommands';

export async function assignmentReads(
  db: TaskDatabase,
  ownerId: string,
  categoryId: string | null,
  groupId: string | null,
): Promise<EntityRead[]> {
  const reads: EntityRead[] = [];
  if (groupId && !categoryId)
    throw new TaskError('A group requires its parent category.');
  if (categoryId) {
    const category = await db.categories.get(categoryId);
    if (!category || category.deletedAt || category.ownerId !== ownerId)
      throw new TaskError(
        'This category is unavailable. Choose a live category or Uncategorized.',
      );
    reads.push(entityRead('category', category));
  }
  if (groupId) {
    const group = await db.groups.get(groupId);
    if (
      !group ||
      group.deletedAt ||
      group.ownerId !== ownerId ||
      group.categoryId !== categoryId
    )
      throw new TaskError(
        'This group does not belong to the selected category.',
      );
    reads.push(entityRead('group', group));
  }
  return reads;
}

export class OrganizationRepository {
  constructor(
    readonly db: TaskDatabase,
    readonly ownerId: string,
    private readonly clock: Runtime = localRuntime,
  ) {}

  createCategory(name: string) {
    return this.mutate('category', 'create', null, name, null);
  }
  createGroup(category: Category, name: string) {
    return this.mutate('group', 'create', null, name, category);
  }
  renameCategory(category: Category, name: string) {
    return this.mutate('category', 'rename', category, name, null);
  }
  renameGroup(group: Group, name: string) {
    return this.mutate('group', 'rename', group, name, null);
  }
  deleteCategory(category: Category) {
    return this.mutate('category', 'delete', category, null, null);
  }
  deleteGroup(group: Group) {
    return this.mutate('group', 'delete', group, null, null);
  }

  private mutate(
    kind: 'category',
    action: 'create' | 'rename' | 'delete',
    base: Category | Group | null,
    inputName: string | null,
    parent: Category | null,
  ): Promise<Category>;
  private mutate(
    kind: 'group',
    action: 'create' | 'rename' | 'delete',
    base: Category | Group | null,
    inputName: string | null,
    parent: Category | null,
  ): Promise<Group>;
  private async mutate(
    kind: OrganizationKind,
    action: 'create' | 'rename' | 'delete',
    base: Category | Group | null,
    inputName: string | null,
    parent: Category | null,
  ) {
    const name = action === 'delete' ? null : organizationName(inputName ?? '');
    return this.db.transaction(
      'rw',
      [
        this.db.categories,
        this.db.groups,
        this.db.tasks,
        this.db.outbox,
        this.db.meta,
        this.db.recurrenceSeries,
      ],
      async () => {
        const store = kind === 'category' ? this.db.categories : this.db.groups;
        const previous = base ? await store.get(base.id) : undefined;
        if (
          base &&
          (!previous ||
            previous.deletedAt ||
            previous.ownerId !== this.ownerId ||
            previous.localRevision !== base.localRevision)
        )
          throw new TaskError(
            'This container changed or was deleted. Your draft is kept. Cancel to review the latest version.',
          );
        const categoryId =
          kind === 'group'
            ? previous &&
              'categoryId' in previous &&
              typeof previous.categoryId === 'string'
              ? previous.categoryId
              : (parent?.id ?? null)
            : null;
        if (kind === 'group' && !categoryId)
          throw new TaskError('A group requires a live parent category.');
        const reads: EntityRead[] = [];
        if (kind === 'group')
          reads.push(
            ...(await assignmentReads(this.db, this.ownerId, categoryId, null)),
          );
        if (parent) {
          const current = await this.db.categories.get(parent.id);
          if (!current || current.localRevision !== parent.localRevision)
            throw new TaskError(
              'The parent category changed. Reopen this form before creating a group.',
            );
        }
        if (previous) reads.push(entityRead(kind, previous));
        const peers = await store.toArray();
        if (
          name &&
          peers.some(
            (row) =>
              row.id !== previous?.id &&
              !row.deletedAt &&
              row.ownerId === this.ownerId &&
              nameKey(row.name) === nameKey(name) &&
              (kind === 'category' ||
                ('categoryId' in row && row.categoryId === categoryId)),
          )
        )
          throw new TaskError(
            'A container with this name already exists here.',
          );
        const groups =
          action === 'delete' && kind === 'category' && previous
            ? await this.db.groups
                .where('categoryId')
                .equals(previous.id)
                .toArray()
            : [];
        const tasks =
          action === 'delete' && previous
            ? await (
                kind === 'category'
                  ? this.db.tasks.where('categoryId')
                  : this.db.tasks.where('groupId')
              )
                .equals(previous.id)
                .toArray()
            : [];
        if ([...groups, ...tasks].some((row) => row.ownerId !== this.ownerId))
          throw new TaskError(
            'Organizational ownership is inconsistent. Nothing was changed.',
          );
        const series =
          action === 'delete' && previous
            ? (await this.db.recurrenceSeries.toArray()).filter((row) =>
                kind === 'category'
                  ? row.template.categoryId === previous.id
                  : row.template.groupId === previous.id,
              )
            : [];
        if (series.some((row) => row.ownerId !== this.ownerId))
          throw new TaskError(
            'Series ownership is inconsistent. Nothing was changed.',
          );
        const time = mutationTime(this.clock, [
          ...(previous ? [previous] : []),
          ...groups,
          ...tasks,
          ...series,
        ]);
        const operationId = this.clock.uuid();
        const record: Category = previous
          ? {
              ...previous,
              name: name ?? previous.name,
              localRevision: previous.localRevision + 1,
              updatedAt: time,
              deletedAt: action === 'delete' ? time : null,
              lastOperationId: operationId,
            }
          : {
              id: this.clock.uuid(),
              ownerId: this.ownerId,
              name: name ?? '',
              createdAt: time,
              updatedAt: time,
              deletedAt: null,
              localRevision: 1,
              revision: null,
              timestampsProvisional: true,
              lastOperationId: operationId,
            };
        const result: Category | Group =
          kind === 'group'
            ? { ...record, categoryId: categoryId ?? '' }
            : record;
        const changes: EntityChange[] = [
          { kind, base: previous ?? null, result },
        ];
        const touch = (
          entityKind: EntityRead['kind'],
          old: EntityRecord,
          changed: EntityRecord,
        ) => {
          reads.push(entityRead(entityKind, old));
          changes.push({ kind: entityKind, base: old, result: changed });
        };
        for (const group of groups.filter((row) => !row.deletedAt))
          touch('group', group, {
            ...group,
            deletedAt: time,
            updatedAt: time,
            localRevision: group.localRevision + 1,
            lastOperationId: operationId,
          });
        // Include deleted tasks so restoring one cannot resurrect a dead assignment.
        for (const task of tasks)
          touch('task', task, {
            ...task,
            categoryId: kind === 'category' ? null : task.categoryId,
            groupId: null,
            updatedAt: time,
            localRevision: task.localRevision + 1,
            lastOperationId: operationId,
          });
        for (const row of series)
          touch('series', row, {
            ...touchSeries(row, time, operationId),
            template: {
              ...row.template,
              categoryId: kind === 'category' ? null : row.template.categoryId,
              groupId: null,
            },
          });
        for (const change of changes) {
          if (change.kind === 'series' && 'template' in change.result) {
            await this.db.recurrenceSeries.put(change.result);
            continue;
          }

          if (change.kind === 'task' && 'title' in change.result)
            await this.db.tasks.put(change.result);
          else if (
            change.kind === 'group' &&
            'categoryId' in change.result &&
            'name' in change.result
          )
            await this.db.groups.put(change.result);
          else if ('name' in change.result)
            await this.db.categories.put(change.result);
          else throw new TaskError('Invalid organizational change.');
        }
        await appendCommand(
          this.db,
          this.ownerId,
          this.clock,
          operationId,
          time,
          {
            kind: 'organization',
            entityKind: kind,
            action,
            entityId: result.id,
            name,
            categoryId,
          },
          changes,
          reads,
          null,
        );
        return result;
      },
    );
  }
}
