import { useState } from 'react';
import type { Category, Group } from '../../domain/organization';
import { defaultQuery, presets, sorts } from '../../domain/query';
import type { FilterSpec } from '../../domain/query';
import type { DateMode } from '../../domain/dates';

const sortLabels = [
  'Newest first',
  'Oldest first',
  'Title A–Z',
  'Title Z–A',
  'Due date ascending',
  'Due date descending',
  'Priority',
  'Completion status',
];
const presetLabels = [
  'All dates',
  'Today',
  'Yesterday',
  'Last 7 Days',
  'Last 14 Days',
  'Last 30 Days',
  'Custom range',
  'No date',
];
export function QueryControls({
  query,
  change,
  categories,
  groups,
}: {
  query: FilterSpec;
  change: (query: FilterSpec) => void;
  categories: Category[];
  groups: Group[];
}) {
  const [dateField, setDateField] = useState<DateMode>('created');
  const filter = query.dates[dateField];
  const indicator = [
    query.status !== 'active' ? `Status: ${query.status}` : '',
    query.category !== '*' ? 'Category' : '',
    query.group !== '*' ? 'Group' : '',
    query.priority !== '*' ? 'Priority' : '',
    query.search.trim() ? 'Search' : '',
    ...Object.entries(query.dates)
      .filter(([, value]) => value.preset !== 'all')
      .map(([key]) => `${key} date`),
  ].filter(Boolean);
  return (
    <div className="space-y-2 border-b border-line p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 basis-full text-xs text-muted sm:flex-1 sm:basis-0">
          Search tasks
          <input
            type="search"
            className="field mt-1 w-full"
            value={query.search}
            onChange={(event) =>
              change({ ...query, search: event.target.value })
            }
          />
        </label>
        <label className="min-w-0 text-xs text-muted">
          Sort tasks
          <select
            className="field mt-1 block max-w-full"
            aria-label="Sort tasks"
            value={query.sort}
            onChange={(event) => {
              const sort = sorts.find((value) => value === event.target.value);
              if (sort) change({ ...query, sort });
            }}
          >
            {sorts.map((sort, index) => (
              <option key={sort} value={sort}>
                {sortLabels[index]}
              </option>
            ))}
          </select>
        </label>
        <button className="action" onClick={() => change(defaultQuery())}>
          Reset filters
        </button>
      </div>
      <p className="text-xs text-muted" aria-live="polite">
        {indicator.length
          ? `Filters: ${indicator.join(' · ')}`
          : 'No additional filters'}{' '}
        · Sort: {sortLabels[sorts.indexOf(query.sort)]}
      </p>
      <details>
        <summary className="inline-flex min-h-11 cursor-pointer items-center">
          Filter controls
        </summary>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="min-w-0 text-xs text-muted">
            Filter category
            <select
              className="field mt-1 w-full"
              aria-label="Filter category"
              value={query.category}
              onChange={(event) =>
                change({ ...query, category: event.target.value, group: '*' })
              }
            >
              <option value="*">All categories</option>
              <option value="">Uncategorized</option>
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
            Filter group
            <select
              className="field mt-1 w-full"
              aria-label="Filter group"
              value={query.group}
              onChange={(event) =>
                change({ ...query, group: event.target.value })
              }
            >
              <option value="*">All groups</option>
              <option value="">No group / direct tasks</option>
              {groups.some(
                (row) =>
                  row.id === query.group &&
                  !row.deletedAt &&
                  query.category !== '*' &&
                  row.categoryId !== query.category,
              ) && (
                <option value={query.group}>
                  Incompatible group — choose another
                </option>
              )}
              {groups
                .filter(
                  (row) =>
                    !row.deletedAt &&
                    (query.category === '*' ||
                      row.categoryId === query.category),
                )
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {query.category === '*'
                      ? `${categories.find((category) => category.id === row.categoryId)?.name ?? 'Unavailable category'} / ${row.name}`
                      : row.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted">
            Filter priority
            <select
              className="field mt-1 w-full"
              aria-label="Filter priority"
              value={query.priority}
              onChange={(event) => {
                const priority = event.target.value;
                if (
                  priority === '*' ||
                  priority === '' ||
                  priority === 'low' ||
                  priority === 'normal' ||
                  priority === 'high'
                )
                  change({ ...query, priority });
              }}
            >
              <option value="*">All priorities</option>
              <option value="high">High</option>
              <option value="normal">Medium</option>
              <option value="low">Low</option>
              <option value="">No priority</option>
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted">
            Filter date field
            <select
              className="field mt-1 w-full"
              aria-label="Filter date field"
              value={dateField}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'due' ||
                  value === 'created' ||
                  value === 'completed'
                )
                  setDateField(value);
              }}
            >
              <option value="created">Created date</option>
              <option value="due">Due date</option>
              <option value="completed">Completed date</option>
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted">
            Date range
            <select
              className="field mt-1 w-full"
              aria-label="Date range"
              value={filter.preset}
              onChange={(event) => {
                const preset = presets.find(
                  (value) => value === event.target.value,
                );
                if (preset)
                  change({
                    ...query,
                    dates: {
                      ...query.dates,
                      [dateField]: { ...filter, preset },
                    },
                  });
              }}
            >
              {presets.map((preset, index) => (
                <option key={preset} value={preset}>
                  {presetLabels[index]}
                </option>
              ))}
            </select>
          </label>
          {filter.preset === 'custom' &&
            (['start', 'end'] as const).map((endpoint) => (
              <label key={endpoint} className="min-w-0 text-xs text-muted">
                {endpoint === 'start' ? 'Range start' : 'Range end'}
                <input
                  type="date"
                  min="1900-01-01"
                  max="9999-12-31"
                  className="field mt-1 w-full"
                  value={filter[endpoint]}
                  onChange={(event) =>
                    change({
                      ...query,
                      dates: {
                        ...query.dates,
                        [dateField]: {
                          ...filter,
                          [endpoint]: event.target.value,
                        },
                      },
                    })
                  }
                />
              </label>
            ))}
        </div>
        <p className="py-2 text-xs text-muted">
          All conditions must match. Date endpoints are inclusive in your local
          time zone. Date fields retain separate ranges.
        </p>
      </details>
    </div>
  );
}
