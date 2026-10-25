import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTaskQuery } from '../../src/features/query/useTaskQuery';
import { civilDate } from '../../src/domain/dates';
import type { WorkspaceSnapshot } from '../../src/data/local/taskRepository';
import { defaultQuery } from '../../src/domain/query';
import { readPreferences } from '../../src/features/query/preferences';

const empty: WorkspaceSnapshot = {
  tasks: [],
  categories: [],
  groups: [],
  events: [],
  pendingCount: 0,
  series: [],
};
afterEach(() => vi.useRealTimers());
it('refreshes relative-day context on midnight timer and focus/resume without changing queries', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
  const { result } = renderHook(() =>
    useTaskQuery('calendar-test', empty, false, false),
  );
  const query = result.current.query;
  const first = result.current.tasks;
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(result.current.tasks).toBe(first);
  act(() => {
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'));
    window.dispatchEvent(new Event('focus'));
  });
  expect(result.current.calendar.today).toBe(civilDate('2026-03-09T12:00:00Z'));
  expect(result.current.query).toBe(query);
  act(() => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(result.current.calendar.today).toBe(civilDate('2026-03-10T12:00:00Z'));
  act(() => {
    vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
    vi.advanceTimersByTime(60_000);
  });
  expect(result.current.calendar.today).toBe(civilDate('2026-03-11T12:01:00Z'));
});
it('does not clear references while loading, then repairs unavailable references and persists the repair', () => {
  localStorage.setItem(
    'repair-test',
    JSON.stringify({
      ...defaultQuery(),
      category: 'deleted',
      group: 'deleted-group',
    }),
  );
  const initialProps: { snapshot: WorkspaceSnapshot | null } = {
    snapshot: null,
  };
  const { result, rerender } = renderHook(
    ({ snapshot }: { snapshot: WorkspaceSnapshot | null }) =>
      useTaskQuery('repair-test', snapshot, false, false),
    { initialProps },
  );
  expect(result.current.query.category).toBe('deleted');
  rerender({ snapshot: empty });
  expect(result.current.query.category).toBe('*');
  expect(result.current.query.group).toBe('*');
  expect(result.current.preferenceNotice).toMatch(/filter was cleared/);
  expect(readPreferences('repair-test').query.category).toBe('*');
});
it('query changes reuse the snapshot, persist only preferences and leave task/history/outbox projections alone', () => {
  const snapshot = structuredClone(empty);
  const { result, rerender } = renderHook(() =>
    useTaskQuery('memo-test', snapshot, false, false),
  );
  const first = result.current.tasks;
  rerender();
  expect(result.current.tasks).toBe(first);
  act(() =>
    result.current.change({
      ...result.current.query,
      search: 'offline',
      sort: 'priority',
    }),
  );
  expect(readPreferences('memo-test').query.search).toBe('offline');
  expect(snapshot).toEqual(empty);
});
