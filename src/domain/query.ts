import { civilDateFormatter, validDueDate } from './dates';
import type { DateMode } from './dates';
import type { Category, Group } from './organization';
import type { Priority, Task } from './task';

export const sorts = [
  'newest',
  'oldest',
  'title-asc',
  'title-desc',
  'due-asc',
  'due-desc',
  'priority',
  'status',
] as const;
export type Sort = (typeof sorts)[number];
export const presets = [
  'all',
  'today',
  'yesterday',
  '7',
  '14',
  '30',
  'custom',
  'missing',
] as const;
export type DatePreset = (typeof presets)[number];
export interface DateFilter {
  preset: DatePreset;
  start: string;
  end: string;
}
export interface FilterSpec {
  version: 1;
  status: 'active' | 'completed' | 'all';
  statusExplicit: boolean;
  category: string; // '*' all, '' uncategorized, otherwise UUID
  group: string; // '*' all, '' no group, otherwise UUID
  priority: '*' | Priority | '';
  search: string;
  dates: Record<DateMode, DateFilter>;
  sort: Sort;
  dateMode: DateMode;
}
export function defaultQuery(): FilterSpec {
  const date = (): DateFilter => ({ preset: 'all', start: '', end: '' });
  return {
    version: 1,
    status: 'active',
    statusExplicit: false,
    category: '*',
    group: '*',
    priority: '*',
    search: '',
    dates: { created: date(), due: date(), completed: date() },
    sort: 'newest',
    dateMode: 'due',
  };
}
export function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase();
}
function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
// UTC is used only as a Gregorian calendar calculator, never for interpreting a deadline.
function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function dateBounds(
  filter: DateFilter,
  today: string,
): [string, string] | null {
  if (filter.preset === 'all' || filter.preset === 'missing') return null;
  if (filter.preset === 'custom') return [filter.start, filter.end];
  if (filter.preset === 'yesterday') {
    const day = shiftDay(today, -1);
    return [day, day];
  }
  const days = filter.preset === 'today' ? 1 : Number(filter.preset);
  return [shiftDay(today, 1 - days), today];
}
export function queryIssue(
  query: FilterSpec,
  categories: Category[],
  groups: Group[],
): string | null {
  const category = categories.find(
    (row) => row.id === query.category && !row.deletedAt,
  );
  const group = groups.find((row) => row.id === query.group && !row.deletedAt);
  if (query.category !== '*' && query.category !== '' && !category)
    return 'The selected category is unavailable. Reset filters or choose another category.';
  if (query.group !== '*' && query.group !== '' && !group)
    return 'The selected group is unavailable. Reset filters or choose another group.';
  if (group && query.category !== '*' && group.categoryId !== query.category)
    return 'The selected group does not belong to the selected category.';
  for (const filter of Object.values(query.dates)) {
    if (
      filter.preset === 'custom' &&
      (!filter.start || !filter.end || filter.start > filter.end)
    )
      return 'Choose both range endpoints, with the start on or before the end.';
  }
  return null;
}
export function effectiveStatus(query: FilterSpec, completionMode: boolean) {
  return completionMode && !query.statusExplicit ? 'completed' : query.status;
}
export function queryTasks(
  tasks: readonly Task[],
  query: FilterSpec,
  context: {
    today: string;
    zone: string;
    completionMode?: boolean;
    deleted?: boolean;
  },
): Task[] {
  const search = normalizeText(query.search.trim());
  const status = effectiveStatus(query, context.completionMode ?? false);
  const day = civilDateFormatter(context.zone);
  const dates = (['created', 'due', 'completed'] as const)
    .filter((field) => query.dates[field].preset !== 'all')
    .map((field) => ({
      field,
      filter: query.dates[field],
      bounds: dateBounds(query.dates[field], context.today),
    }));
  const priority = (value: Priority | null) =>
    value === 'high' ? 0 : value === 'normal' ? 1 : value === 'low' ? 2 : 3;
  const titleKeys = new Map<string, string>();
  const result = tasks.filter((task) => {
    if (context.deleted ? !task.deletedAt : task.deletedAt) return false;
    if (
      !context.deleted &&
      status !== 'all' &&
      task.completed !== (status === 'completed')
    )
      return false;
    if (!context.deleted && context.completionMode && !task.completed)
      return false;
    if (query.category !== '*' && task.categoryId !== (query.category || null))
      return false;
    if (query.group !== '*' && task.groupId !== (query.group || null))
      return false;
    if (query.priority !== '*' && task.priority !== (query.priority || null))
      return false;
    if (
      search &&
      !normalizeText(task.title).includes(search) &&
      !normalizeText(task.description ?? '').includes(search)
    )
      return false;
    for (const { field, filter, bounds } of dates) {
      const value =
        field === 'due'
          ? task.dueDate
          : field === 'created'
            ? day(task.createdAt)
            : task.completedAt
              ? day(task.completedAt)
              : null;
      if (filter.preset === 'missing') {
        if (value !== null) return false;
      } else if (
        !value ||
        !bounds ||
        !bounds[0] ||
        !bounds[1] ||
        value < bounds[0] ||
        value > bounds[1]
      )
        return false;
    }
    if (query.sort.startsWith('title'))
      titleKeys.set(task.id, normalizeText(task.title));
    return true;
  });
  return result.sort((a, b) => {
    let order = 0;
    switch (query.sort) {
      case 'newest':
        order = compare(b.createdAt, a.createdAt);
        break;
      case 'oldest':
        order = compare(a.createdAt, b.createdAt);
        break;
      case 'title-asc':
      case 'title-desc':
        order =
          compare(titleKeys.get(a.id) ?? '', titleKeys.get(b.id) ?? '') *
          (query.sort === 'title-desc' ? -1 : 1);
        break;
      case 'due-asc':
      case 'due-desc':
        order =
          a.dueDate === null
            ? b.dueDate === null
              ? 0
              : 1
            : b.dueDate === null
              ? -1
              : compare(a.dueDate, b.dueDate) *
                (query.sort === 'due-desc' ? -1 : 1);
        break;
      case 'priority':
        order = priority(a.priority) - priority(b.priority);
        break;
      case 'status':
        order = Number(a.completed) - Number(b.completed);
        break;
    }
    return order || compare(a.id, b.id);
  });
}
// The type predicate validates every known field; callers receive a fresh known-field
// object so future/unknown keys never become query behavior.
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFilterSpec(value: unknown): value is FilterSpec {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.statusExplicit !== 'boolean'
  )
    return false;
  if (
    typeof value.status !== 'string' ||
    !['active', 'completed', 'all'].includes(value.status)
  )
    return false;
  if (
    !sorts.some((sort) => sort === value.sort) ||
    typeof value.dateMode !== 'string' ||
    !['due', 'created', 'completed'].includes(value.dateMode)
  )
    return false;
  for (const key of ['category', 'group', 'priority', 'search'])
    if (typeof value[key] !== 'string') return false;
  if (
    typeof value.priority !== 'string' ||
    !['*', '', 'low', 'normal', 'high'].includes(value.priority)
  )
    return false;
  if (!record(value.dates)) return false;
  for (const field of ['created', 'due', 'completed']) {
    const range = value.dates[field];
    if (
      !record(range) ||
      !presets.some((preset) => preset === range.preset) ||
      typeof range.start !== 'string' ||
      typeof range.end !== 'string'
    )
      return false;
    try {
      if (range.start) validDueDate(range.start);
      if (range.end) validDueDate(range.end);
    } catch {
      return false;
    }
  }
  return true;
}
export function parseQuery(value: unknown): FilterSpec | null {
  if (!isFilterSpec(value)) return null;
  const {
    version,
    status,
    statusExplicit,
    category,
    group,
    priority,
    search,
    sort,
    dateMode,
  } = value;
  const copy = (date: DateFilter): DateFilter => ({
    preset: date.preset,
    start: date.start,
    end: date.end,
  });
  return {
    version,
    status,
    statusExplicit,
    category,
    group,
    priority,
    search,
    sort,
    dateMode,
    dates: {
      created: copy(value.dates.created),
      due: copy(value.dates.due),
      completed: copy(value.dates.completed),
    },
  };
}
