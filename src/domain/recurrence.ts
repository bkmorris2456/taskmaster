import { v5 } from 'uuid';
import { civilDate, validDueDate } from './dates';
import { TaskError } from './task';
import type { TaskContent } from './task';

export type Frequency = 'daily' | 'weekly' | 'monthly';
export interface RecurrenceInput {
  frequency: Frequency;
  anchorDate: string;
  timeZone: string;
}
export interface RecurrenceSeries extends RecurrenceInput {
  id: string;
  ownerId: string;
  template: Pick<
    TaskContent,
    'title' | 'description' | 'priority' | 'categoryId' | 'groupId'
  >;
  activeTaskId: string | null;
  enabled: boolean;
  scheduleRevision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number | null;
  localRevision: number;
  timestampsProvisional: boolean;
  lastOperationId: string;
}
export interface RecurringCompletion {
  seriesId: string;
  occurrenceDate: string;
  successorId: string;
  successorDate: string;
  frequency: Frequency;
  anchorDate: string;
  timeZone: string;
  completionDate: string;
  scheduleRevision: number;
}
export function validateRecurrence(input: RecurrenceInput): RecurrenceInput {
  if (!input || !['daily', 'weekly', 'monthly'].includes(input.frequency))
    throw new TaskError('Choose Daily, Weekly or Monthly recurrence.');
  if (!validDueDate(input.anchorDate))
    throw new TaskError('Recurrence requires a starting date.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).format();
  } catch {
    throw new TaskError('Choose a valid IANA recurrence time zone.');
  }
  if (!input.timeZone) throw new TaskError('Recurrence requires a time zone.');
  return {
    frequency: input.frequency,
    anchorDate: input.anchorDate,
    timeZone: input.timeZone,
  };
}
function parts(value: string): [number, number, number] {
  if (!validDueDate(value)) throw new TaskError('A schedule date is required.');
  const values = value.split('-').map(Number);
  const [year, month, day] = values;
  if (year === undefined || month === undefined || day === undefined)
    throw new TaskError('Invalid schedule date.');
  return [year, month, day];
}
function daysInMonth(year: number, month: number) {
  return month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;
}
function format(year: number, month: number, day: number) {
  if (year > 9999 || year < 1900)
    throw new TaskError(
      'The next occurrence exceeds the supported date range (1900–9999). Nothing was saved.',
    );
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function addDays(value: string, amount: number): string {
  let [year, month, day] = parts(value);
  for (let step = 0; step < amount; step++) {
    day++;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month++;
    }
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return format(year, month, day);
}
function weekday(value: string) {
  const [year, month, day] = parts(value);
  const previous = year - 1;
  let ordinal =
    365 * previous +
    Math.floor(previous / 4) -
    Math.floor(previous / 100) +
    Math.floor(previous / 400) +
    day;
  for (let m = 1; m < month; m++) ordinal += daysInMonth(year, m);
  return ordinal % 7;
}
// Pure Gregorian fields only: no duration arithmetic, clock, timers or time-zone conversion.
export function nextOccurrence(
  config: RecurrenceInput,
  occurrence: string,
  completionDate: string,
): string {
  validateRecurrence(config);
  parts(occurrence);
  parts(completionDate);
  const cutoff = occurrence > completionDate ? occurrence : completionDate;
  if (config.frequency === 'daily') return addDays(cutoff, 1);
  if (config.frequency === 'weekly')
    return addDays(
      cutoff,
      ((weekday(config.anchorDate) - weekday(cutoff) + 6) % 7) + 1,
    );
  const target = parts(config.anchorDate)[2];
  let [year, month] = parts(cutoff);
  let candidate = format(
    year,
    month,
    Math.min(target, daysInMonth(year, month)),
  );
  if (candidate <= cutoff) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    candidate = format(year, month, Math.min(target, daysInMonth(year, month)));
  }
  return candidate;
}
export function completionCivilDate(instant: string, zone: string) {
  return civilDate(instant, zone);
}
// UUID v5 / URL namespace, UTF-8 JSON tuple; shared fixtures freeze this wire identity rule.
export function successorId(
  seriesId: string,
  date: string,
  operationId: string,
) {
  return v5(
    JSON.stringify([
      'taskmaster',
      'occurrence',
      1,
      seriesId,
      date,
      operationId,
    ]),
    v5.URL,
  );
}
