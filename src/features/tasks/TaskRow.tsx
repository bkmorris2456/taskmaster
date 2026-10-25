import type { RecurrenceSeries } from '../../domain/recurrence';
import type { Task } from '../../domain/task';

export type TaskAction =
  'complete' | 'reopen' | 'delete' | 'restore' | 'reopenStandalone';

interface Props {
  task: Task;
  series?: RecurrenceSeries | undefined;
  busy: boolean;
  act: (task: Task, action: TaskAction) => Promise<boolean>;
  startEdit: (task: Task) => void;
}

export function TaskRow({ task, series, busy, act, startEdit }: Props) {
  return (
    <li
      className="border-b border-line px-4 py-2"
      aria-label={`Task: ${task.title}`}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-2">
        {!task.deletedAt && (
          <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={task.completed}
              disabled={busy}
              aria-label={`${task.completed ? 'Reopen' : 'Complete'} ${task.title}`}
              className="size-5 accent-accent"
              onChange={() => {
                void act(task, task.completed ? 'reopen' : 'complete');
              }}
            />
          </label>
        )}
        <div className="min-w-0 flex-1 self-center py-2">
          <p
            className={
              task.completed ? 'text-sm text-muted line-through' : 'text-sm'
            }
          >
            {task.title}
          </p>
          {task.description && (
            <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-muted">
              {task.description}
            </p>
          )}
          {task.priority && (
            <p className="mt-1 text-xs text-muted">
              Priority:{' '}
              {task.priority === 'normal'
                ? 'Medium'
                : task.priority === 'high'
                  ? 'High'
                  : 'Low'}
            </p>
          )}
          {task.seriesId && (
            <p className="mt-1 text-xs text-muted">
              {!task.completed &&
              series?.enabled &&
              series.activeTaskId === task.id
                ? `Repeats ${series.frequency} · ${series.timeZone} · Scheduled ${task.occurrenceDate}`
                : `Recurring occurrence · Scheduled ${task.occurrenceDate}`}{' '}
              {series?.enabled && series.activeTaskId === task.id
                ? task.dueDate
                  ? `· Next due ${task.dueDate}`
                  : '· No due date'
                : ''}
            </p>
          )}
          {task.dueDate && (
            <p className="mt-1 text-xs text-muted">
              Due <time dateTime={task.dueDate}>{task.dueDate}</time>
            </p>
          )}
          {task.completedAt && (
            <p className="mt-1 text-xs text-muted">
              Completed{' '}
              <time dateTime={task.completedAt}>
                {new Date(task.completedAt).toLocaleString()}
              </time>
            </p>
          )}
        </div>
        <div className="ml-auto flex w-full flex-wrap justify-end gap-1 sm:w-auto">
          {task.deletedAt ? (
            <button
              className="row-action"
              disabled={busy}
              onClick={() => {
                void act(task, 'restore');
              }}
            >
              {task.seriesId && !task.completed
                ? 'Restore as standalone'
                : 'Restore'}
            </button>
          ) : (
            <>
              {task.completed && task.seriesId && (
                <button
                  className="row-action"
                  disabled={busy}
                  onClick={() => {
                    void act(task, 'reopenStandalone');
                  }}
                >
                  Reopen as standalone
                </button>
              )}
              <button
                className="row-action"
                disabled={busy}
                onClick={() => startEdit(task)}
              >
                Edit
              </button>
              <button
                className="row-action"
                disabled={busy}
                onClick={() => {
                  void act(task, 'delete');
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
