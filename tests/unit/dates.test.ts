import { describe, expect, it } from 'vitest';
import { civilDate, groupByDate, validDueDate } from '../../src/domain/dates';
import type { Task } from '../../src/domain/task';

const task: Task = {
  id: 't',
  ownerId: 'o',
  title: 'Task',
  description: null,
  dueDate: null,
  priority: null,
  categoryId: null,
  groupId: null,
  seriesId: null,
  occurrenceDate: null,
  completed: false,
  createdAt: '2026-03-08T04:30:00Z',
  updatedAt: '2026-03-08T04:30:00Z',
  completedAt: null,
  deletedAt: null,
  revision: null,
  localRevision: 1,
  timestampsProvisional: true,
  currentCompletionId: null,
  lastOperationId: 'op',
};

describe('civil-date task grouping', () => {
  it.each(['2024-02-29', '2000-02-29', '1900-01-01', '9999-12-31'])(
    'accepts date-only %s unchanged',
    (date) => expect(validDueDate(date)).toBe(date),
  );
  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '1899-12-31',
    '2026-1-02',
    '2026-01-01T00:00:00Z',
  ])('rejects invalid deadline %s', (date) =>
    expect(() => validDueDate(date)).toThrow(),
  );
  it('allows no deadline', () => {
    expect(validDueDate(null)).toBeNull();
    expect(validDueDate('')).toBeNull();
  });
  it('groups instants by display zone across midnight and DST', () => {
    expect(civilDate('2026-03-08T04:30:00Z', 'America/New_York')).toBe(
      '2026-03-07',
    );
    expect(civilDate('2026-03-08T07:30:00Z', 'America/New_York')).toBe(
      '2026-03-08',
    );
    expect(civilDate('2026-11-01T05:30:00Z', 'America/New_York')).toBe(
      '2026-11-01',
    );
    expect(civilDate('2026-11-01T06:30:00Z', 'America/New_York')).toBe(
      '2026-11-01',
    );
  });
  it('orders deadlines chronologically, labels overdue and puts null deadlines last without shifting zones', () => {
    const tasks = [
      { ...task, id: 'future', dueDate: '2026-03-10' },
      { ...task, id: 'past', dueDate: '2026-03-07' },
      task,
    ];
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo']) {
      const groups = groupByDate(
        tasks,
        'due',
        new Date('2026-03-09T12:00:00Z'),
        zone,
      );
      expect(groups.map((group) => group.date)).toEqual([
        '2026-03-07',
        '2026-03-10',
        '',
      ]);
      expect(groups[0]?.overdue).toBe(true);
      expect(groups[2]?.label).toBe('No due date');
    }
  });
  it('completion grouping includes completed rows, excludes reopened/deleted rows and uses completion instants', () => {
    const groups = groupByDate(
      [
        task,
        {
          ...task,
          id: 'done',
          completed: true,
          completedAt: '2026-03-08T04:30:00Z',
        },
        { ...task, id: 'deleted', deletedAt: '2026-03-10T00:00:00Z' },
      ],
      'completed',
      new Date('2026-03-09T12:00:00Z'),
      'America/New_York',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.date).toBe('2026-03-07');
    expect(groups[0]?.tasks.map((row) => row.id)).toEqual(['done']);
  });
});
