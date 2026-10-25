import type { TaskDatabase, EntityChange, EntityRead } from './database';
import type { Task, TaskInput, CompletionEvent } from '../../domain/task';
import { TaskError } from '../../domain/task';
import {
  validateRecurrence,
  nextOccurrence,
  successorId,
  completionCivilDate,
} from '../../domain/recurrence';
import type {
  RecurrenceSeries,
  RecurringCompletion,
} from '../../domain/recurrence';
import { entityRead } from './localCommands';

// Transaction-only helpers. TaskRepository owns the transaction and command insertion.
export async function loadSeries(
  db: TaskDatabase,
  ownerId: string,
  task: Task | undefined,
) {
  if (!task?.seriesId) return null;
  const series = await db.recurrenceSeries.get(task.seriesId);
  if (!series || series.ownerId !== ownerId)
    throw new TaskError(
      'Recurrence data is inconsistent. Nothing was changed.',
    );
  return series;
}
export function template(task: Task): RecurrenceSeries['template'] {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    categoryId: task.categoryId,
    groupId: task.groupId,
  };
}
export function touchSeries(
  series: RecurrenceSeries,
  time: string,
  operationId: string,
): RecurrenceSeries {
  return {
    ...series,
    updatedAt: time,
    localRevision: series.localRevision + 1,
    lastOperationId: operationId,
  };
}
export function configureSeries(
  previous: RecurrenceSeries | null,
  task: Task,
  input: TaskInput,
  time: string,
  operationId: string,
  newId: () => string,
): RecurrenceSeries | null {
  if (input.recurrence !== undefined && (task.completed || task.deletedAt))
    throw new TaskError(
      'Configure recurrence on an active task, not a historical occurrence.',
    );
  if (input.recurrence === null) {
    task.seriesId = null;
    task.occurrenceDate = null;
    return previous
      ? {
          ...touchSeries(previous, time, operationId),
          enabled: false,
          activeTaskId: null,
        }
      : null;
  }
  if (input.recurrence !== undefined) {
    const config = validateRecurrence(input.recurrence);
    if (
      previous &&
      (!previous.enabled ||
        previous.deletedAt ||
        previous.activeTaskId !== task.id)
    )
      throw new TaskError('This is not the current recurring occurrence.');
    const series: RecurrenceSeries = previous
      ? {
          ...touchSeries(previous, time, operationId),
          ...config,
          scheduleRevision: previous.scheduleRevision + 1,
        }
      : {
          ...config,
          id: newId(),
          ownerId: task.ownerId,
          template: template(task),
          enabled: true,
          activeTaskId: task.id,
          scheduleRevision: 1,
          createdAt: time,
          updatedAt: time,
          deletedAt: null,
          localRevision: 1,
          revision: null,
          timestampsProvisional: true,
          lastOperationId: operationId,
        };
    task.seriesId = series.id;
    task.occurrenceDate = config.anchorDate;
    task.dueDate = config.anchorDate;
    return { ...series, template: template(task) };
  }
  if (previous && !task.completed && !task.deletedAt) {
    if (
      !previous.enabled ||
      previous.deletedAt ||
      previous.activeTaskId !== task.id
    )
      throw new TaskError('This is not the current recurring occurrence.');
    return {
      ...touchSeries(previous, time, operationId),
      template: template(task),
    };
  }
  return null;
}
export function advanceSeries(
  series: RecurrenceSeries | null,
  task: Task,
  instant: string,
  time: string,
  operationId: string,
): {
  series: RecurrenceSeries;
  successor: Task;
  recurrence: RecurringCompletion;
} {
  if (
    !series ||
    !series.enabled ||
    series.deletedAt ||
    series.activeTaskId !== task.id ||
    !task.occurrenceDate
  )
    throw new TaskError(
      'Only the current active recurring occurrence can be completed.',
    );
  const completionDate = completionCivilDate(instant, series.timeZone);
  const date = nextOccurrence(series, task.occurrenceDate, completionDate);
  const id = successorId(series.id, date, operationId);
  const successor: Task = {
    ...task,
    ...series.template,
    id,
    dueDate: date,
    occurrenceDate: date,
    createdAt: time,
    updatedAt: time,
    completed: false,
    completedAt: null,
    currentCompletionId: null,
    deletedAt: null,
    revision: null,
    localRevision: 1,
    lastOperationId: operationId,
    timestampsProvisional: true,
  };
  return {
    series: { ...touchSeries(series, time, operationId), activeTaskId: id },
    successor,
    recurrence: {
      seriesId: series.id,
      occurrenceDate: task.occurrenceDate,
      successorId: id,
      successorDate: date,
      frequency: series.frequency,
      anchorDate: series.anchorDate,
      timeZone: series.timeZone,
      completionDate,
      scheduleRevision: series.scheduleRevision,
    },
  };
}
export async function undoSuccessor(
  db: TaskDatabase,
  series: RecurrenceSeries | null,
  completion: CompletionEvent,
  time: string,
  operationId: string,
): Promise<{ changes: EntityChange[]; reads: EntityRead[] }> {
  if (completion.kind !== 'completion' || !completion.recurrence || !series)
    throw new TaskError(
      'Recurring completion metadata is missing. Nothing was changed.',
    );
  const next = await db.tasks.get(completion.recurrence.successorId);
  const commands = await db.outbox.toArray();
  const completionSequence =
    commands.find((command) => command.id === completion.operationId)
      ?.sequence ?? Infinity;
  const dependent = commands.some(
    (command) =>
      command.id !== completion.operationId &&
      command.protocolVersion === 2 &&
      (command.dependencies.includes(completion.operationId) ||
        (command.reads.some(
          (read) =>
            (read.kind === 'task' && read.id === next?.id) ||
            (read.kind === 'series' && read.id === series.id),
        ) &&
          command.sequence > completionSequence)),
  );
  if (
    !series.enabled ||
    series.deletedAt ||
    series.activeTaskId !== next?.id ||
    series.lastOperationId !== completion.operationId ||
    !next ||
    next.ownerId !== series.ownerId ||
    next.seriesId !== series.id ||
    next.completed ||
    next.deletedAt ||
    next.localRevision !== 1 ||
    next.lastOperationId !== completion.operationId ||
    dependent
  )
    throw new TaskError(
      'This successor or series changed after completion. Undo is blocked. Use “Reopen as standalone” after reviewing the current series.',
    );
  return {
    changes: [
      {
        kind: 'task',
        base: next,
        result: {
          ...next,
          deletedAt: time,
          updatedAt: time,
          localRevision: next.localRevision + 1,
          lastOperationId: operationId,
        },
      },
    ],
    reads: [entityRead('task', next)],
  };
}
export async function assertSeriesInvariant(
  db: TaskDatabase,
  series: RecurrenceSeries,
) {
  const active = (
    await db.tasks.where('seriesId').equals(series.id).toArray()
  ).filter((task) => !task.deletedAt && !task.completed);
  if (
    active.some((task) => task.ownerId !== series.ownerId) ||
    (series.enabled && !series.deletedAt
      ? active.length !== 1 || active[0]?.id !== series.activeTaskId
      : active.length !== 0 || series.activeTaskId !== null)
  )
    throw new TaskError('Recurrence invariant failed. Nothing was saved.');
}
