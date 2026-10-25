import type { RecurrenceSeries, Frequency } from '../../domain/recurrence';
import { nextOccurrence } from '../../domain/recurrence';
import { civilDate } from '../../domain/dates';
import type { Category, Group } from '../../domain/organization';
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskInput, Priority } from '../../domain/task';

interface Props {
  task?: Task;
  series?: RecurrenceSeries;
  busy: boolean;
  save: (input: TaskInput) => Promise<boolean>;
  cancel?: () => void;
  dirtyChanged: (dirty: boolean) => void;
  categories?: Category[];
  groups?: Group[];
  initialCategoryId?: string | null;
  initialGroupId?: string | null;
  focusOnMount?: boolean;
}

export function TaskForm({
  task,
  series,
  busy,
  save,
  cancel,
  dirtyChanged,
  categories = [],
  groups = [],
  initialCategoryId = null,
  initialGroupId = null,
  focusOnMount = false,
}: Props) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [categoryId, setCategoryId] = useState(
    task?.categoryId ?? initialCategoryId,
  );
  const [groupId, setGroupId] = useState(task?.groupId ?? initialGroupId);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [priority, setPriority] = useState<Priority | null>(
    task?.priority ?? null,
  );
  const initialFrequency =
    task?.seriesId && series?.enabled && series.activeTaskId === task.id
      ? series.frequency
      : '';
  const initialAnchor = initialFrequency ? (series?.anchorDate ?? '') : '';
  const initialZone =
    series?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [frequency, setFrequency] = useState<Frequency | ''>(initialFrequency);
  const [anchorDate, setAnchorDate] = useState(initialAnchor);
  const [timeZone, setTimeZone] = useState(initialZone);
  const recurrenceChanged =
    frequency !== initialFrequency ||
    (frequency !== '' &&
      (anchorDate !== initialAnchor || timeZone !== initialZone));
  let preview = '';
  if (frequency && anchorDate) {
    try {
      preview = nextOccurrence(
        { frequency, anchorDate, timeZone },
        recurrenceChanged ? anchorDate : (task?.occurrenceDate ?? anchorDate),
        civilDate(new Date(), timeZone),
      );
    } catch {
      preview = 'Choose a valid schedule within 1900–9999.';
    }
  }
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty =
    title !== (task?.title ?? '') ||
    description !== (task?.description ?? '') ||
    categoryId !== (task?.categoryId ?? initialCategoryId) ||
    groupId !== (task?.groupId ?? initialGroupId) ||
    dueDate !== (task?.dueDate ?? '') ||
    priority !== (task?.priority ?? null) ||
    recurrenceChanged;
  useEffect(() => {
    dirtyChanged(dirty);
    return () => dirtyChanged(false);
  }, [dirty, dirtyChanged]);
  useEffect(() => {
    if (task || focusOnMount) titleRef.current?.focus();
  }, [task, focusOnMount]);

  return (
    <form
      aria-label={task ? `Edit ${task.title}` : 'Create task'}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          title,
          ...(recurrenceChanged
            ? {
                recurrence: frequency
                  ? { frequency, anchorDate, timeZone }
                  : null,
              }
            : {}),
          priority,
          description,
          categoryId,
          groupId,
          dueDate: dueDate || null,
        }).then((saved) => {
          if (saved && !task) {
            setTitle('');
            setDescription('');
            setDueDate('');
            setPriority(null);
            setFrequency('');
            setAnchorDate('');
            setTimeZone(initialZone);
            setCategoryId(initialCategoryId);
            setGroupId(initialGroupId);
            titleRef.current?.focus();
          }
        });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          if (!dirty || window.confirm('Discard this unsaved draft?')) {
            if (cancel) cancel();
            else {
              setTitle('');
              setDescription('');
              setDueDate('');
              setPriority(null);
              setFrequency('');
              setAnchorDate('');
              setTimeZone(initialZone);
              setCategoryId(initialCategoryId);
              setGroupId(initialGroupId);
            }
          }
        }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 basis-full text-xs text-muted sm:flex-1 sm:basis-0">
          {task ? 'Edit title' : 'Task title'}
          <input
            ref={titleRef}
            className="field mt-1 w-full"
            value={title}
            maxLength={240}
            readOnly={busy}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={task ? undefined : 'What needs doing?'}
          />
        </label>
        <button className="action" type="submit" disabled={busy}>
          {task ? 'Save changes' : 'Create task'}
        </button>
        {cancel && (
          <button
            className="action"
            type="button"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm('Discard this unsaved draft?'))
                cancel();
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {task ? (
        <label className="block text-xs text-muted">
          Edit description
          <textarea
            className="field mt-1 w-full"
            rows={3}
            maxLength={10_000}
            value={description}
            readOnly={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      ) : (
        <details>
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted">
            Optional description
          </summary>
          <label className="block text-xs text-muted">
            Description
            <textarea
              className="field mt-1 w-full"
              rows={3}
              maxLength={10_000}
              value={description}
              readOnly={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </details>
      )}
      <details open={task ? true : undefined}>
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted">
          Organization and due date
        </summary>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="min-w-0 text-xs text-muted">
            Category
            <select
              aria-label="Category"
              className="field mt-1 w-full"
              value={categoryId ?? ''}
              disabled={busy}
              onChange={(event) => {
                setCategoryId(event.target.value || null);
                setGroupId(null);
              }}
            >
              <option value="">Uncategorized</option>
              {categoryId &&
                !categories.some(
                  (row) => row.id === categoryId && !row.deletedAt,
                ) && (
                  <option value={categoryId}>
                    Unavailable category — choose another
                  </option>
                )}
              {categories
                .filter((row) => !row.deletedAt)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted">
            Group
            <select
              aria-label="Group"
              className="field mt-1 w-full"
              value={groupId ?? ''}
              disabled={busy || !categoryId}
              onChange={(event) => setGroupId(event.target.value || null)}
            >
              <option value="">No group</option>
              {groupId &&
                !groups.some(
                  (row) =>
                    row.id === groupId &&
                    !row.deletedAt &&
                    row.categoryId === categoryId,
                ) && (
                  <option value={groupId}>
                    Unavailable group — choose another
                  </option>
                )}
              {groups
                .filter(
                  (row) => !row.deletedAt && row.categoryId === categoryId,
                )
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted">
            Due date
            <input
              className="field mt-1 w-full"
              type="date"
              min="1900-01-01"
              max="9999-12-31"
              value={dueDate}
              readOnly={busy}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </label>
          <label className="min-w-0 text-xs text-muted">
            Priority
            <select
              className="field mt-1 w-full"
              aria-label="Priority"
              value={priority ?? ''}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === '' ||
                  value === 'low' ||
                  value === 'normal' ||
                  value === 'high'
                )
                  setPriority(value || null);
              }}
            >
              <option value="">No priority</option>
              <option value="low">Low</option>
              <option value="normal">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted">
            Repeat
            <select
              aria-label="Repeat"
              className="field mt-1 w-full"
              value={frequency}
              disabled={busy || task?.completed === true}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === '' ||
                  value === 'daily' ||
                  value === 'weekly' ||
                  value === 'monthly'
                ) {
                  setFrequency(value);
                  if (value !== frequency && value) setAnchorDate(dueDate);
                }
              }}
            >
              <option value="">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {frequency && (
            <>
              <label className="min-w-0 text-xs text-muted">
                Schedule anchor
                <input
                  aria-label="Schedule anchor"
                  type="date"
                  min="1900-01-01"
                  max="9999-12-31"
                  className="field mt-1 w-full"
                  value={anchorDate}
                  disabled={busy}
                  onChange={(event) => setAnchorDate(event.target.value)}
                />
              </label>
              <label className="min-w-0 text-xs text-muted">
                Recurrence time zone
                <input
                  aria-label="Recurrence time zone"
                  className="field mt-1 w-full"
                  value={timeZone}
                  readOnly={busy}
                  onChange={(event) => setTimeZone(event.target.value)}
                />
              </label>
            </>
          )}
        </div>
        {frequency && (
          <p className="py-2 text-xs leading-6 text-muted">
            {recurrenceChanged
              ? `Starting due date: ${anchorDate || 'required'}. Changing the schedule replaces the current occurrence; completed history stays intact.`
              : `Current scheduled date: ${task?.occurrenceDate ?? anchorDate}. Due-date edits alone do not reanchor the schedule.`}{' '}
            Next after completion today: {preview || 'choose a starting date'}.
            Zone: {timeZone}.
          </p>
        )}
      </details>
    </form>
  );
}
