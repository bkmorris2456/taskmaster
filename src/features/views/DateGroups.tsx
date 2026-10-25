import type { ReactNode } from 'react';
import type { Task } from '../../domain/task';
import { groupByDate } from '../../domain/dates';
import type { DateMode } from '../../domain/dates';

export function DateGroups({
  tasks,
  mode,
  rows,
  today,
  zone,
}: {
  today: string;
  zone: string;
  tasks: Task[];
  mode: DateMode;
  rows: (tasks: Task[]) => ReactNode;
}) {
  const groups = groupByDate(
    tasks,
    mode,
    new Date(`${today}T12:00:00Z`),
    zone,
    today,
  );
  return (
    <div>
      {groups.length ? (
        groups.map((group) => (
          <section
            key={group.date}
            aria-label={`Date: ${group.label}`}
            className="border-b border-line"
          >
            <h2 className="px-4 py-3 text-sm">
              {group.label}
              {group.overdue && (
                <span className="ml-3 text-xs text-error">Overdue</span>
              )}
            </h2>
            {rows(group.tasks)}
          </section>
        ))
      ) : (
        <p className="p-4 text-sm text-muted">No tasks for this date mode.</p>
      )}
    </div>
  );
}
