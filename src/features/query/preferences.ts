import { defaultQuery, parseQuery } from '../../domain/query';
import type { FilterSpec } from '../../domain/query';

export function readPreferences(key: string): {
  query: FilterSpec;
  notice: string;
} {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { query: defaultQuery(), notice: '' };
    const query = parseQuery(JSON.parse(raw) as unknown);
    return query
      ? { query, notice: '' }
      : {
          query: defaultQuery(),
          notice:
            'Outdated or invalid view preferences were reset. Task data was not changed.',
        };
  } catch {
    return {
      query: defaultQuery(),
      notice:
        'View preferences could not be loaded. Task data was not changed.',
    };
  }
}
export function writePreferences(key: string, query: FilterSpec): string {
  try {
    localStorage.setItem(key, JSON.stringify(query));
    return '';
  } catch {
    return 'View preferences could not be saved; they will apply for this visit only.';
  }
}
