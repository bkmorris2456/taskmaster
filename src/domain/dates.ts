import type { Task } from './task';
import { TaskError } from './task';

export type DateMode = 'due' | 'created' | 'completed';

export function validDueDate(value: string | null) {
  if (value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new TaskError('Choose a valid due date.');
  const [year, month, day] = value.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    year < 1900 ||
    year > 9999 ||
    month < 1 ||
    month > 12
  )
    throw new TaskError('Choose a due date between 1900 and 9999.');
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const max = days[month - 1];
  if (max === undefined || day < 1 || day > max)
    throw new TaskError('Choose a valid due date.');
  return value;
}

export function civilDateFormatter(zone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (instant: string | Date): string => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
}
export function civilDate(
  instant: string | Date,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  return civilDateFormatter(zone)(instant);
}

export function groupByDate(
  tasks: Task[],
  mode: DateMode,
  now = new Date(),
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  today = civilDate(now, zone),
) {
  const day = civilDateFormatter(zone);
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.deletedAt || (mode === 'completed' && !task.completed)) continue;
    const key =
      mode === 'due'
        ? (task.dueDate ?? '')
        : mode === 'created'
          ? day(task.createdAt)
          : task.completedAt
            ? day(task.completedAt)
            : '';
    const rows = grouped.get(key) ?? [];
    rows.push(task);
    grouped.set(key, rows);
  }
  return [...grouped]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([date, rows]) => ({
      date,
      label:
        date === '' ? 'No due date' : date === today ? `${date} · Today` : date,
      overdue:
        mode === 'due' &&
        date !== '' &&
        date < today &&
        rows.some((task) => !task.completed),
      tasks: rows,
    }));
}
