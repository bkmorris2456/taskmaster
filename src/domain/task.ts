import type { RecurrenceInput, RecurringCompletion } from './recurrence';
export type Priority = 'low' | 'normal' | 'high';

export interface TaskContent {
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: Priority | null;
  categoryId: string | null;
  groupId: string | null;
  // Recurrence configuration belongs to the series, not the occurrence.
  seriesId: string | null;
  occurrenceDate: string | null;
}

export interface Task extends TaskContent {
  id: string;
  ownerId: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  revision: number | null; // Unknown until acknowledged by a future server.
  localRevision: number; // Local compare-and-swap token, never a server revision.
  timestampsProvisional: boolean;
  currentCompletionId: string | null;
  lastOperationId: string;
}

interface EventBase {
  id: string;
  ownerId: string;
  taskId: string;
  operationId: string;
  occurredAt: string;
  timeZone: string;
}

export type CompletionEvent = EventBase &
  (
    | {
        kind: 'completion';
        snapshot: TaskContent;
        recurrence?: RecurringCompletion;
      }
    | { kind: 'reversal'; reversesEventId: string }
  );

export interface TaskInput {
  title: string;
  recurrence?: RecurrenceInput | null;
  description?: string | null;
  dueDate?: string | null;
  priority?: Priority | null;
  categoryId?: string | null;
  groupId?: string | null;
}

export class TaskError extends Error {}

export function validateTaskInput(
  input: TaskInput,
): Pick<TaskContent, 'title' | 'description'> {
  if (
    input.priority !== undefined &&
    input.priority !== null &&
    !['low', 'normal', 'high'].includes(input.priority)
  )
    throw new TaskError('Choose a valid priority.');
  const title = input.title.trim();
  if (!title) throw new TaskError('Enter a task title.');
  if (title.length > 240)
    throw new TaskError('Keep the title within 240 characters.');
  const description = input.description ?? null;
  if (description !== null && description.length > 10_000) {
    throw new TaskError('Keep the description within 10,000 characters.');
  }
  return { title, description: description === '' ? null : description };
}

export function snapshot(task: Task): TaskContent {
  const {
    title,
    description,
    dueDate,
    priority,
    categoryId,
    groupId,
    seriesId,
    occurrenceDate,
  } = task;
  return {
    title,
    description,
    dueDate,
    priority,
    categoryId,
    groupId,
    seriesId,
    occurrenceDate,
  };
}

export function persistenceMessage(error: unknown): string {
  if (error instanceof TaskError) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    /quota/i.test(error.name)
  ) {
    return 'Storage is full. Nothing was saved. Free device space and try again; your input is still here.';
  }
  return 'Local storage could not save or load this change. Your input is retained. Retry without clearing browser data.';
}
