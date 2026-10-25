import { successorId } from '../../domain/recurrence';
import type { RecurrenceSeries } from '../../domain/recurrence';
import {
  loadSeries,
  configureSeries,
  advanceSeries,
  undoSuccessor,
  assertSeriesInvariant,
  touchSeries,
} from './recurrenceMutations';
import { liveQuery } from 'dexie';
import { TaskError, snapshot, validateTaskInput } from '../../domain/task';
import type { Task, TaskInput, CompletionEvent } from '../../domain/task';
import { TaskDatabase } from './database';
import type { CommandPayload, EntityChange, EntityRead } from './database';
import type { Category, Group } from '../../domain/organization';
import { assignmentReads } from './organizationRepository';
import { validDueDate } from '../../domain/dates';
import { appendCommand, entityRead, localRuntime } from './localCommands';
import type { Runtime } from './localCommands';

export interface WorkspaceSnapshot {
  tasks: Task[];
  events: CompletionEvent[];
  pendingCount: number;
  categories: Category[];
  groups: Group[];
  series: RecurrenceSeries[];
}

export class TaskRepository {
  constructor(
    readonly db: TaskDatabase,
    readonly ownerId: string,
    private readonly clock: Runtime = localRuntime,
  ) {}

  async read(): Promise<WorkspaceSnapshot> {
    return this.db.transaction(
      'r',
      [
        this.db.tasks,
        this.db.completionEvents,
        this.db.outbox,
        this.db.categories,
        this.db.groups,
        this.db.recurrenceSeries,
      ],
      async () => {
        const series = await this.db.recurrenceSeries.toArray();
        const categories = await this.db.categories.toArray();
        const groups = await this.db.groups.toArray();
        const tasks = await this.db.tasks.toArray();
        const events = await this.db.completionEvents.toArray();
        const commands = await this.db.outbox.toArray();
        if (
          [
            ...tasks,
            ...events,
            ...commands,
            ...categories,
            ...groups,
            ...series,
          ].some((row) => row.ownerId !== this.ownerId)
        ) {
          throw new TaskError(
            'This workspace belongs to a different local identity. Its data has not been changed.',
          );
        }
        return {
          tasks: tasks.sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          ),
          events: events.sort(
            (a, b) =>
              b.occurredAt.localeCompare(a.occurredAt) ||
              a.id.localeCompare(b.id),
          ),
          pendingCount: commands.length,
          categories,
          groups,
          series,
        };
      },
    );
  }

  observe(
    next: (state: WorkspaceSnapshot) => void,
    error: (error: unknown) => void,
  ) {
    let stopped = false;
    let subscription: { unsubscribe: () => void } | undefined;
    const closed = () => {
      if (!stopped)
        error(
          new TaskError(
            'Local storage was closed by a database update. Reload to reopen it; stored records have not been removed.',
          ),
        );
    };
    this.db.on('close', closed);
    // liveQuery intentionally idles without an IndexedDB API, so surface opening
    // failures explicitly before subscribing rather than leaving the UI loading.
    void this.db
      .open()
      .then(() => {
        if (!stopped)
          subscription = liveQuery(() => this.read()).subscribe({
            next,
            error,
          });
      })
      .catch((failure: unknown) => {
        if (!stopped) error(failure);
      });
    return {
      unsubscribe: () => {
        stopped = true;
        subscription?.unsubscribe();
        this.db.on('close').unsubscribe(closed);
      },
    };
  }

  create(input: TaskInput): Promise<Task> {
    const content = validateTaskInput(input);
    return this.mutate(null, null, {
      kind: 'create',
      input: { ...input, ...content },
    });
  }

  edit(task: Task, input: TaskInput): Promise<Task> {
    const content = validateTaskInput(input);
    return this.mutate(task.id, task.localRevision, {
      kind: 'edit',
      input: { ...input, ...content },
    });
  }

  complete(task: Task): Promise<Task> {
    return this.mutate(task.id, task.localRevision, 'complete');
  }

  reopen(task: Task): Promise<Task> {
    return this.mutate(task.id, task.localRevision, 'reopen');
  }

  reopenStandalone(task: Task): Promise<Task> {
    return this.mutate(task.id, task.localRevision, 'reopen-standalone');
  }

  delete(task: Task): Promise<Task> {
    return this.mutate(task.id, task.localRevision, { kind: 'delete' });
  }

  restore(task: Task): Promise<Task> {
    return this.mutate(task.id, task.localRevision, { kind: 'restore' });
  }

  private async mutate(
    id: string | null,
    expectedLocalRevision: number | null,
    intent: CommandPayload | 'complete' | 'reopen' | 'reopen-standalone',
  ): Promise<Task> {
    return this.db.transaction(
      'rw',
      [
        this.db.tasks,
        this.db.completionEvents,
        this.db.outbox,
        this.db.meta,
        this.db.categories,
        this.db.groups,
        this.db.recurrenceSeries,
      ],
      async () => {
        const previous = id === null ? undefined : await this.db.tasks.get(id);
        if (id !== null && (!previous || previous.ownerId !== this.ownerId))
          throw new TaskError(
            'This task is unavailable. No changes were saved.',
          );
        const series = await loadSeries(this.db, this.ownerId, previous);
        const kind = typeof intent === 'string' ? intent : intent.kind;
        // A retry of the same frozen active occurrence returns the committed result.
        // After undo/recompletion the original base revision no longer matches.
        if (
          kind === 'complete' &&
          previous?.completed &&
          previous.seriesId &&
          previous.currentCompletionId
        ) {
          const event = await this.db.completionEvents.get(
            previous.currentCompletionId,
          );
          const command = event
            ? await this.db.outbox.get(event.operationId)
            : undefined;
          if (
            !previous.deletedAt &&
            event?.kind === 'completion' &&
            event.recurrence &&
            event.ownerId === this.ownerId &&
            event.taskId === previous.id &&
            event.recurrence.seriesId === previous.seriesId &&
            command?.base?.localRevision === expectedLocalRevision &&
            previous.lastOperationId === event.operationId &&
            series?.lastOperationId === event.operationId
          )
            return previous;
        }
        if (previous && previous.localRevision !== expectedLocalRevision)
          throw new TaskError(
            'This task changed in another tab. Your draft is kept. Cancel to review the latest task, then edit again.',
          );
        const changes: EntityChange[] = [];
        const reads: EntityRead[] = series
          ? [entityRead('series', series)]
          : [];
        let changedSeries: RecurrenceSeries | null = null;
        let retiredOccurrence: Task | null = null;
        if (previous?.deletedAt && kind !== 'restore')
          throw new TaskError(
            'This task was deleted. Restore it before editing.',
          );
        if (kind === 'restore' && !previous?.deletedAt)
          throw new TaskError('This task is not deleted.');
        if (kind === 'complete' && previous?.completed)
          throw new TaskError('This task is already completed.');
        if (
          (kind === 'reopen' || kind === 'reopen-standalone') &&
          !previous?.completed
        )
          throw new TaskError('This task is already active.');
        const nowMs = this.clock.now().getTime();
        if (!Number.isFinite(nowMs))
          throw new TaskError(
            'The device clock is invalid. Nothing was saved.',
          );
        // Monotonic local display metadata, never a cloud conflict clock.
        const time = new Date(
          Math.max(
            nowMs,
            previous ? Date.parse(previous.updatedAt) + 1 : nowMs,
          ),
        ).toISOString();
        const operationId = this.clock.uuid();
        const task: Task = previous
          ? {
              ...previous,
              updatedAt: time,
              localRevision: previous.localRevision + 1,
              lastOperationId: operationId,
            }
          : {
              id: this.clock.uuid(),
              ownerId: this.ownerId,
              title: '',
              description: null,
              completed: false,
              completedAt: null,
              createdAt: time,
              updatedAt: time,
              deletedAt: null,
              revision: null,
              localRevision: 1,
              timestampsProvisional: true,
              currentCompletionId: null,
              dueDate: null,
              priority: null,
              categoryId: null,
              groupId: null,
              seriesId: null,
              occurrenceDate: null,
              lastOperationId: operationId,
            };
        let payload: CommandPayload;
        if (typeof intent !== 'string') {
          payload = intent;
          if (intent.kind === 'create' || intent.kind === 'edit') {
            Object.assign(task, validateTaskInput(intent.input));
            if (intent.input.dueDate !== undefined)
              task.dueDate = validDueDate(intent.input.dueDate);
            if (intent.input.priority !== undefined)
              task.priority = intent.input.priority;
            const requestedGroup = intent.input.groupId;
            const requestedCategory = intent.input.categoryId;
            if (requestedCategory !== undefined) {
              task.categoryId = requestedCategory;
              if (requestedCategory !== previous?.categoryId)
                task.groupId = null;
            }
            if (requestedGroup !== undefined) {
              task.groupId = requestedGroup;
              if (requestedGroup) {
                const group = await this.db.groups.get(requestedGroup);
                if (!group || group.deletedAt || group.ownerId !== this.ownerId)
                  throw new TaskError('This group is unavailable.');
                if (
                  requestedCategory !== undefined &&
                  requestedCategory !== group.categoryId
                )
                  throw new TaskError(
                    'This group does not belong to the selected category.',
                  );
                task.categoryId = group.categoryId;
              }
            }
            changedSeries = configureSeries(
              series,
              task,
              intent.input,
              time,
              operationId,
              this.clock.uuid,
            );
            if (
              series &&
              previous &&
              changedSeries &&
              intent.input.recurrence
            ) {
              // Scheduled occurrence identity never changes. A reanchor replaces the
              // active occurrence atomically; its old identity remains a tombstone.
              retiredOccurrence = {
                ...previous,
                deletedAt: time,
                updatedAt: time,
                localRevision: previous.localRevision + 1,
                lastOperationId: operationId,
              };
              task.id = successorId(
                series.id,
                intent.input.recurrence.anchorDate,
                operationId,
              );
              task.createdAt = time;
              task.localRevision = 1;
              task.revision = null;
              changedSeries.activeTaskId = task.id;
              changes.push({ kind: 'task', base: null, result: task });
            }
          }
          if (intent.kind === 'delete') task.deletedAt = time;
          if (
            intent.kind === 'delete' &&
            series?.enabled &&
            series.activeTaskId === task.id
          )
            changedSeries = {
              ...touchSeries(series, time, operationId),
              enabled: false,
              activeTaskId: null,
              deletedAt: time,
            };
          if (intent.kind === 'restore') {
            task.deletedAt = null;
            if (task.seriesId && !task.completed) {
              task.seriesId = null;
              task.occurrenceDate = null;
            }
          }
        } else {
          const eventBase = {
            id: this.clock.uuid(),
            ownerId: this.ownerId,
            taskId: task.id,
            operationId,
            occurredAt:
              series && intent === 'complete'
                ? new Date(nowMs).toISOString()
                : time,
            timeZone: this.clock.timeZone(),
          };
          if (intent === 'complete') {
            const event: CompletionEvent = {
              ...eventBase,
              kind: 'completion',
              snapshot: snapshot(task),
            };
            if (task.seriesId) {
              const advancement = advanceSeries(
                series,
                task,
                event.occurredAt,
                time,
                operationId,
              );
              event.recurrence = advancement.recurrence;
              event.timeZone = advancement.recurrence.timeZone;
              changedSeries = advancement.series;
              changes.push({
                kind: 'task',
                base: null,
                result: advancement.successor,
              });
              reads.push(
                ...(await assignmentReads(
                  this.db,
                  this.ownerId,
                  advancement.successor.categoryId,
                  advancement.successor.groupId,
                )),
              );
            }
            task.completed = true;
            task.completedAt = event.occurredAt;
            task.currentCompletionId = event.id;
            payload = { kind: 'complete', event };
          } else {
            if (!task.currentCompletionId)
              throw new TaskError(
                'Completion history is missing. The task was not changed.',
              );
            const completion = await this.db.completionEvents.get(
              task.currentCompletionId,
            );
            if (
              !completion ||
              completion.kind !== 'completion' ||
              completion.taskId !== task.id ||
              completion.ownerId !== this.ownerId
            ) {
              throw new TaskError(
                'Completion history is inconsistent. The task was not changed.',
              );
            }
            if (task.seriesId && intent === 'reopen') {
              const undo = await undoSuccessor(
                this.db,
                series,
                completion,
                time,
                operationId,
              );
              changes.push(...undo.changes);
              reads.push(...undo.reads);
              if (!series) throw new TaskError('Series unavailable.');
              changedSeries = {
                ...touchSeries(series, time, operationId),
                activeTaskId: task.id,
              };
            }
            if (intent === 'reopen-standalone') {
              if (!task.seriesId)
                throw new TaskError('This task is already standalone.');
              task.seriesId = null;
              task.occurrenceDate = null;
            }
            const event: CompletionEvent = {
              ...eventBase,
              kind: 'reversal',
              reversesEventId: completion.id,
            };
            task.completed = false;
            task.completedAt = null;
            task.currentCompletionId = null;
            payload = {
              kind:
                intent === 'reopen-standalone' ? 'reopen-standalone' : 'reopen',
              event,
            };
          }
          if (!('event' in payload))
            throw new TaskError('Invalid completion command.');
          await this.db.completionEvents.add(payload.event);
        }
        const parentReads = await assignmentReads(
          this.db,
          this.ownerId,
          task.categoryId,
          task.groupId,
        );
        changes.unshift({
          kind: 'task',
          base: previous ?? null,
          result: retiredOccurrence ?? task,
        });
        if (changedSeries)
          changes.push({ kind: 'series', base: series, result: changedSeries });
        for (const change of changes) {
          if (change.kind === 'task' && 'title' in change.result)
            await this.db.tasks.put(change.result);
          else if (change.kind === 'series' && 'template' in change.result)
            await this.db.recurrenceSeries.put(change.result);
          else throw new TaskError('Invalid recurrence mutation.');
        }
        if (changedSeries ?? series) {
          const checked = changedSeries ?? series;
          if (checked) await assertSeriesInvariant(this.db, checked);
        }
        await appendCommand(
          this.db,
          this.ownerId,
          this.clock,
          operationId,
          time,
          payload,
          changes,
          [
            ...(previous ? [entityRead('task', previous)] : []),
            ...reads,
            ...parentReads,
          ],
          previous?.id ?? task.id,
        );
        return task;
      },
    );
  }
}
