import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultQuery,
  dateBounds,
  parseQuery,
  queryIssue,
  queryTasks,
  sorts,
} from '../../src/domain/query';
import type { FilterSpec, Sort } from '../../src/domain/query';
import type { Task } from '../../src/domain/task';
import { snapshot } from '../../src/domain/task';
import type { Category, Group } from '../../src/domain/organization';
import { civilDate, groupByDate } from '../../src/domain/dates';
import {
  readPreferences,
  writePreferences,
} from '../../src/features/query/preferences';

const base: Task = {
  id: 'b',
  ownerId: 'owner',
  title: 'Beta',
  description: 'Synchronize notes',
  createdAt: '2026-03-08T05:00:00.000Z',
  updatedAt: '2026-03-08T05:00:00.000Z',
  dueDate: '2026-03-08',
  priority: 'high',
  categoryId: 'c',
  groupId: 'g',
  seriesId: null,
  occurrenceDate: null,
  completed: false,
  completedAt: null,
  currentCompletionId: null,
  deletedAt: null,
  revision: null,
  localRevision: 1,
  timestampsProvisional: true,
  lastOperationId: 'op',
};
const tasks: Task[] = [
  base,
  {
    ...base,
    id: 'a',
    title: 'alpha',
    description: null,
    dueDate: '2026-03-09',
    priority: 'normal',
    groupId: null,
    createdAt: '2026-03-07T12:00:00.000Z',
    completed: true,
    completedAt: '2026-03-08T07:30:00.000Z',
  },
  {
    ...base,
    id: 'c',
    title: 'Café',
    description: null,
    dueDate: null,
    priority: 'low',
    categoryId: null,
    groupId: null,
    createdAt: '2026-03-09T12:00:00.000Z',
  },
  {
    ...base,
    id: 'd',
    title: 'delta',
    priority: null,
    dueDate: null,
    categoryId: 'other',
    groupId: null,
  },
  { ...base, id: 'deleted', deletedAt: base.updatedAt },
];
const context = { today: '2026-03-08', zone: 'America/New_York' };
const all = (): FilterSpec => ({
  ...defaultQuery(),
  status: 'all',
  statusExplicit: true,
});
const ids = (query = all(), rows = tasks) =>
  queryTasks(rows, query, context).map((row) => row.id);

describe('shared task query', () => {
  it.each([
    ['active', ['c', 'b', 'd']],
    ['completed', ['a']],
    ['all', ['c', 'b', 'd', 'a']],
  ] as const)('status %s excludes tombstones', (status, expected) => {
    expect(ids({ ...defaultQuery(), status })).toEqual(expected);
  });
  it('deleted recovery ignores status but keeps other predicates', () => {
    expect(
      queryTasks(
        tasks,
        { ...defaultQuery(), search: 'beta' },
        { ...context, deleted: true },
      ).map((row) => row.id),
    ).toEqual(['deleted']);
  });
  it.each([
    ['*', '*', ['c', 'b', 'd', 'a']],
    ['c', '*', ['b', 'a']],
    ['', '*', ['c']],
    ['*', 'g', ['b']],
    ['c', '', ['a']],
    ['other', 'g', []],
  ] as const)(
    'category %s and group %s compose',
    (category, group, expected) => {
      expect(ids({ ...all(), category, group })).toEqual(expected);
    },
  );
  it.each([
    ['*', ['c', 'b', 'd', 'a']],
    ['high', ['b']],
    ['normal', ['a']],
    ['low', ['c']],
    ['', ['d']],
  ] as const)('priority %s includes null distinctly', (priority, expected) => {
    expect(ids({ ...all(), priority })).toEqual(expected);
  });
  it.each([
    ['  SYNC  ', ['b', 'd']],
    ['cafE\u0301', ['c']],
    ['ALP', ['a']],
    ['', ['c', 'b', 'd', 'a']],
    ['   ', ['c', 'b', 'd', 'a']],
    ['unmatched', []],
  ] as const)(
    'search %j matches normalized title/description',
    (search, expected) => {
      expect(ids({ ...all(), search })).toEqual(expected);
    },
  );
  it('ANDs every dimension including multiple independent date fields', () => {
    const query = {
      ...defaultQuery(),
      category: 'c',
      group: 'g',
      priority: 'high' as const,
      search: 'sync',
    };
    query.dates.created = { preset: '14', start: '', end: '' };
    query.dates.due = { preset: 'today', start: '', end: '' };
    expect(ids(query)).toEqual(['b']);
    expect(ids({ ...query, search: 'missing' })).toEqual([]);
  });
  it.each([
    ['newest', ['c', 'b', 'd', 'a']],
    ['oldest', ['a', 'b', 'd', 'c']],
    ['title-asc', ['a', 'b', 'c', 'd']],
    ['title-desc', ['d', 'c', 'b', 'a']],
    ['due-asc', ['b', 'a', 'c', 'd']],
    ['due-desc', ['a', 'b', 'c', 'd']],
    ['priority', ['b', 'a', 'c', 'd']],
    ['status', ['b', 'c', 'd', 'a']],
  ] satisfies [Sort, string[]][])(
    'sort %s is deterministic and nonmutating',
    (sort, expected) => {
      const before = structuredClone(tasks);
      expect(ids({ ...all(), sort })).toEqual(expected);
      expect(ids({ ...all(), sort }, [...tasks].reverse())).toEqual(expected);
      expect(tasks).toEqual(before);
    },
  );
  it.each(sorts)('UUID breaks ties for %s', (sort) => {
    expect(
      ids({ ...all(), sort }, [
        { ...base, id: 'z' },
        { ...base, id: 'a' },
      ]),
    ).toEqual(['a', 'z']);
  });
  it('Date grouping preserves query order within chronological groups', () => {
    const rows = queryTasks(
      [base, { ...base, id: 'a', title: 'Zebra' }],
      { ...all(), sort: 'title-desc' },
      context,
    );
    expect(groupByDate(rows, 'due')[0]?.tasks.map((row) => row.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('calendar date predicates', () => {
  it.each([
    ['today', '2026-03-08', '2026-03-08'],
    ['yesterday', '2026-03-07', '2026-03-07'],
    ['7', '2026-03-02', '2026-03-08'],
    ['14', '2026-02-23', '2026-03-08'],
    ['30', '2026-02-07', '2026-03-08'],
  ] as const)(
    '%s uses inclusive civil days across DST and month ends',
    (preset, start, end) => {
      expect(dateBounds({ preset, start: '', end: '' }, context.today)).toEqual(
        [start, end],
      );
    },
  );
  it('Last 14 Days includes both endpoints and excludes adjacent days and missing dates', () => {
    const query = all();
    query.dates.due.preset = '14';
    const dates = [
      '2026-02-22',
      '2026-02-23',
      '2026-03-08',
      '2026-03-09',
      null,
    ];
    expect(
      ids(
        query,
        dates.map((dueDate, index) => ({
          ...base,
          dueDate,
          id: String(index),
        })),
      ),
    ).toEqual(['1', '2']);
  });
  it('custom range includes all instants in local endpoint days, including a DST transition', () => {
    const query = all();
    query.dates.created = {
      preset: 'custom',
      start: '2026-03-08',
      end: '2026-03-08',
    };
    const instants = [
      '2026-03-08T04:59:59.999Z',
      '2026-03-08T05:00:00Z',
      '2026-03-09T03:59:59.999Z',
      '2026-03-09T04:00:00Z',
    ];
    expect(
      ids(
        query,
        instants.map((createdAt, index) => ({
          ...base,
          createdAt,
          id: String(index),
        })),
      ),
    ).toEqual(['2', '1']);
  });
  it('fall-back duplicated local hour is included twice without extending the next day', () => {
    const query = all();
    query.dates.completed = {
      preset: 'custom',
      start: '2026-11-01',
      end: '2026-11-01',
    };
    const instants = [
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:30:00Z',
      '2026-11-02T04:59:59Z',
      '2026-11-02T05:00:00Z',
    ];
    expect(
      ids(
        query,
        instants.map((completedAt, index) => ({
          ...base,
          completed: true,
          completedAt,
          id: String(index),
        })),
      ),
    ).toEqual(['0', '1', '2']);
  });
  it('due dates never shift, while timestamp filters use the supplied display zone', () => {
    const query = all();
    query.dates.created.preset = 'today';
    const row = { ...base, createdAt: '2026-03-08T04:30:00Z' };
    expect(queryTasks([row], query, context)).toEqual([]);
    expect(
      queryTasks([row], query, { ...context, zone: 'Asia/Tokyo' }),
    ).toEqual([row]);
    query.dates.created.preset = 'all';
    query.dates.due.preset = 'today';
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo'])
      expect(queryTasks([row], query, { ...context, zone })).toEqual([row]);
  });
  it('relative dates recalculate with new local day and leap-year calendar rules', () => {
    expect(
      dateBounds({ preset: '14', start: '', end: '' }, '2024-03-01'),
    ).toEqual(['2024-02-17', '2024-03-01']);
    const query = all();
    query.dates.due.preset = 'today';
    expect(ids(query)).toEqual(['b']);
    expect(
      queryTasks(tasks, query, { ...context, today: '2026-03-09' }).map(
        (row) => row.id,
      ),
    ).toEqual(['a']);
    expect(civilDate('2026-03-08T04:30:00Z', context.zone)).toBe('2026-03-07');
  });
  it('missing dates are explicit; reopened records have no current completion date', () => {
    const query = all();
    query.dates.due.preset = 'missing';
    expect(ids(query)).toEqual(['c', 'd']);
    query.dates.due.preset = 'all';
    query.dates.completed.preset = 'today';
    expect(ids(query)).toEqual(['a']);
    expect(
      ids(query, [
        {
          ...tasks[1],
          ...base,
          id: 'reopened',
          completed: false,
          completedAt: null,
        },
      ]),
    ).toEqual([]);
  });
  it('completion grouping defaults Completed but respects explicit Active and All', () => {
    expect(
      queryTasks(tasks, defaultQuery(), {
        ...context,
        completionMode: true,
      }).map((row) => row.id),
    ).toEqual(['a']);
    expect(
      queryTasks(
        tasks,
        { ...defaultQuery(), statusExplicit: true },
        { ...context, completionMode: true },
      ),
    ).toEqual([]);
    expect(
      queryTasks(tasks, all(), { ...context, completionMode: true }).map(
        (row) => row.id,
      ),
    ).toEqual(['a']);
  });
  it('invalid and incomplete ranges produce empty results and actionable validation', () => {
    for (const [start, end] of [
      ['', ''],
      ['2026-03-09', '2026-03-08'],
    ]) {
      const query = all();
      query.dates.due = {
        preset: 'custom',
        start: start ?? '',
        end: end ?? '',
      };
      expect(queryIssue(query, [], [])).toMatch(/endpoints/);
      expect(ids(query)).toEqual([]);
    }
  });
});

describe('preferences and hierarchy validation', () => {
  const category: Category = {
    id: 'c',
    ownerId: 'owner',
    name: 'Category',
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    deletedAt: null,
    revision: null,
    localRevision: 1,
    timestampsProvisional: true,
    lastOperationId: 'op',
  };
  const group: Group = { ...category, id: 'g', categoryId: 'c' };
  it('rejects impossible combinations and deleted references', () => {
    expect(
      queryIssue({ ...all(), category: '', group: 'g' }, [category], [group]),
    ).toMatch(/does not belong/);
    expect(
      queryIssue(
        { ...all(), category: 'c' },
        [{ ...category, deletedAt: base.createdAt }],
        [group],
      ),
    ).toMatch(/unavailable/);
    expect(
      queryIssue(
        { ...all(), group: 'g' },
        [category],
        [{ ...group, deletedAt: base.createdAt }],
      ),
    ).toMatch(/unavailable/);
    expect(
      queryIssue({ ...all(), category: 'c', group: 'g' }, [category], [group]),
    ).toBeNull();
  });
  it('roundtrips versioned preferences without accepting unknown behavior', () => {
    const query = { ...all(), search: 'sync', sort: 'priority' as const };
    expect(writePreferences('query-test', query)).toBe('');
    expect(readPreferences('query-test')).toEqual({ query, notice: '' });
    expect(parseQuery({ ...query, surprise: 'ignored' })).toEqual(query);
  });
  it.each([
    null,
    {},
    { ...all(), version: 2 },
    { ...all(), status: {} },
    { ...all(), sort: 'random' },
    { ...all(), priority: 'urgent' },
    {
      ...all(),
      dates: {
        ...all().dates,
        due: { preset: 'custom', start: '2026-02-30', end: '' },
      },
    },
  ])('rejects malformed preferences %j', (value) => {
    expect(parseQuery(value)).toBeNull();
  });
  it('malformed JSON resets preferences with feedback, never clears task storage', () => {
    localStorage.setItem('bad-query', '{');
    expect(readPreferences('bad-query').query).toEqual(defaultQuery());
    expect(readPreferences('bad-query').notice).toMatch(/could not be loaded/);
  });
  it('storage denial is visible and leaves preferences usable in memory', () => {
    const mock = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    expect(writePreferences('query-test', all())).toMatch(/could not be saved/);
    mock.mockRestore();
  });
});

it('benchmarks deterministic 10,000-task composed queries, without processing 20,000 history events', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    ...base,
    id: String(index).padStart(6, '0'),
    title: `Task ${index}`,
    description: index % 2 ? 'sync' : 'notes',
    createdAt: `2026-03-${String(1 + (index % 8)).padStart(2, '0')}T12:00:00Z`,
    dueDate: index % 3 ? '2026-03-08' : null,
  }));
  const query = {
    ...defaultQuery(),
    search: 'sync',
    priority: 'high' as const,
    sort: 'title-desc' as const,
  };
  query.dates.created.preset = '14';
  query.dates.due.preset = 'today';
  const history = Array.from({ length: 20_000 }, (_, index) => ({
    id: `event-${index}`,
    taskId: `task-${index % 10000}`,
    kind: 'completion' as const,
    snapshot: snapshot(base),
    occurredAt: base.createdAt,
  }));
  const workspace = { tasks: rows, events: history };
  const times: number[] = [];
  let result: Task[] = [];
  for (let run = 0; run < 21; run++) {
    const start = performance.now();
    result = queryTasks(workspace.tasks, query, context);
    if (run) times.push(performance.now() - start);
  }
  expect(result).toHaveLength(3333);
  expect(workspace.events).toHaveLength(20_000);
  expect(workspace.events[0]?.snapshot).toEqual(snapshot(base));
  expect(result.map((row) => row.id)).toEqual(
    queryTasks([...rows].reverse(), query, context).map((row) => row.id),
  );
  times.sort((a, b) => a - b);
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/query-benchmark.json',
    JSON.stringify({
      tasks: rows.length,
      residentHistoryEvents: workspace.events.length,
      measuredRuns: times.length,
      medianMs: times[10],
      p95Ms: times[18],
      matches: result.length,
      runtime: process.version,
    }),
  );
  // A generous regression ceiling avoids pretending shared-host timings certify mobile budgets.
  expect(times[18]).toBeLessThan(2000);
});
