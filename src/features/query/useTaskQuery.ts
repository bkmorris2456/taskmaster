import { useEffect, useMemo, useRef, useState } from 'react';
import { civilDate } from '../../domain/dates';
import { effectiveStatus, queryIssue, queryTasks } from '../../domain/query';
import type { FilterSpec } from '../../domain/query';
import type { WorkspaceSnapshot } from '../../data/local/taskRepository';
import { readPreferences, writePreferences } from './preferences';

export function useTaskQuery(
  key: string,
  snapshot: WorkspaceSnapshot | null,
  completionView: boolean,
  deleted: boolean,
) {
  const [preferences, setPreferences] = useState(() => readPreferences(key));
  const [calendar, setCalendar] = useState(() => ({
    today: civilDate(new Date()),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  useEffect(() => {
    const refresh = () => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const today = civilDate(new Date(), zone);
      setCalendar((previous) =>
        previous.today === today && previous.zone === zone
          ? previous
          : { today, zone },
      );
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const query = preferences.query;
  const lastWritten = useRef<FilterSpec | null>(null);
  const change = (next: FilterSpec) => {
    lastWritten.current = next;
    setPreferences({ query: next, notice: writePreferences(key, next) });
  };
  // Reconcile only once a real snapshot exists, never against the loading empty state.
  // Repair references explicitly, with visible feedback and no task/outbox writes.
  if (snapshot) {
    const missingCategory =
      query.category !== '*' &&
      query.category !== '' &&
      !snapshot.categories.some(
        (row) => row.id === query.category && !row.deletedAt,
      );
    const missingGroup =
      query.group !== '*' &&
      query.group !== '' &&
      !snapshot.groups.some((row) => row.id === query.group && !row.deletedAt);
    if (missingCategory || missingGroup) {
      const repaired = {
        ...query,
        category: missingCategory ? '*' : query.category,
        group: '*',
      };
      setPreferences({
        query: repaired,
        notice:
          'A deleted category or group filter was cleared. Task assignments were not changed.',
      });
    }
  }
  useEffect(() => {
    if (lastWritten.current === query) return;
    lastWritten.current = query;
    const warning = writePreferences(key, query);
    // Failures are also surfaced immediately by explicit changes; initial blocked storage
    // is reported by readPreferences. Do not retry or write task storage here.
    if (warning) return;
  }, [key, query]);
  const issue = useMemo(
    () =>
      snapshot ? queryIssue(query, snapshot.categories, snapshot.groups) : null,
    [query, snapshot],
  );
  const tasks = useMemo(
    () =>
      !snapshot || issue
        ? []
        : queryTasks(snapshot.tasks, query, {
            ...calendar,
            completionMode: completionView && query.dateMode === 'completed',
            deleted,
          }),
    [snapshot, query, calendar, completionView, deleted, issue],
  );
  return {
    query,
    change,
    tasks,
    issue,
    preferenceNotice: preferences.notice,
    status: effectiveStatus(
      query,
      completionView && query.dateMode === 'completed',
    ),
    calendar,
  };
}
