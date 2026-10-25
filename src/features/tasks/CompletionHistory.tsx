import { memo, useMemo, useState } from 'react';
import type { CompletionEvent } from '../../domain/task';

// Query changes must not rebuild a potentially large, independent event ledger.
export const CompletionHistory = memo(function CompletionHistory({
  events,
}: {
  events: CompletionEvent[];
}) {
  const [open, setOpen] = useState(false);
  const titles = useMemo(
    () =>
      new Map(
        events
          .filter((event) => event.kind === 'completion')
          .map((event) => [event.id, event.snapshot.title]),
      ),
    [events],
  );
  return (
    <details
      className="border-t border-line px-5 py-3 sm:px-8"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="inline-flex min-h-11 cursor-pointer items-center">
        Completion history
      </summary>
      {open && (
        <>
          <p className="py-2 text-xs text-muted">
            All completion records; current task filters do not change this
            ledger.
          </p>
          {events.length === 0 ? (
            <p className="py-3 text-xs text-muted">
              No completion records yet.
            </p>
          ) : (
            <ul
              aria-label="Completion records"
              className="divide-y divide-line"
            >
              {events.map((event) => (
                <li key={event.id} className="py-3 text-xs leading-6">
                  {event.kind === 'completion' ? (
                    <>
                      <span>Completed: {event.snapshot.title}</span>
                      {event.recurrence && (
                        <p className="text-muted">
                          {event.recurrence.frequency} · Scheduled{' '}
                          {event.recurrence.occurrenceDate} · Next{' '}
                          {event.recurrence.successorDate} ·{' '}
                          {event.recurrence.timeZone}
                        </p>
                      )}
                      {event.snapshot.description && (
                        <p className="whitespace-pre-wrap text-muted">
                          {event.snapshot.description}
                        </p>
                      )}
                    </>
                  ) : (
                    <span>
                      Reopened:{' '}
                      {titles.get(event.reversesEventId) ??
                        'Earlier completion'}
                    </span>
                  )}
                  <p className="text-muted">
                    <time dateTime={event.occurredAt}>
                      {new Date(event.occurredAt).toLocaleString()}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
});
