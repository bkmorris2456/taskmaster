import { expect, it } from 'vitest';
import {
  nextOccurrence,
  completionCivilDate,
  successorId,
  validateRecurrence,
} from '../../src/domain/recurrence';
import {
  recurrenceCases,
  occurrenceIdentityCases,
} from '../fixtures/recurrence';

it.each(recurrenceCases)(
  '%s anchor %s occurrence %s completed %s → %s',
  (frequency, anchorDate, occurrence, completion, next) => {
    expect(
      nextOccurrence(
        { frequency, anchorDate, timeZone: 'America/New_York' },
        occurrence,
        completion,
      ),
    ).toBe(next);
  },
);
it.each([
  '2026-03-08T06:59:59Z',
  '2026-03-08T07:00:00Z',
  '2026-11-01T05:30:00Z',
  '2026-11-01T06:30:00Z',
])('DST instant %s uses series civil day, not 24 hours', (instant) => {
  const day = completionCivilDate(instant, 'America/New_York');
  const next = nextOccurrence(
    { frequency: 'daily', anchorDate: day, timeZone: 'America/New_York' },
    day,
    day,
  );
  expect(next).toBe(instant.includes('03-08') ? '2026-03-09' : '2026-11-02');
});
it('series zone fixes effective completion date across local display zones', () => {
  const instant = '2026-10-25T02:00:00Z';
  expect(completionCivilDate(instant, 'America/New_York')).toBe('2026-10-24');
  expect(completionCivilDate(instant, 'Asia/Tokyo')).toBe('2026-10-25');
});
it.each(['daily', 'weekly', 'monthly'] as const)(
  'overflow %s fails instead of wrapping',
  (frequency) => {
    expect(() =>
      nextOccurrence(
        { frequency, anchorDate: '9999-12-31', timeZone: 'UTC' },
        '9999-12-31',
        '9999-12-31',
      ),
    ).toThrow(/date range/);
  },
);
it.each(['', '2026-02-30', '1899-12-31'])(
  'rejects invalid anchor %j',
  (anchorDate) => {
    expect(() =>
      validateRecurrence({ frequency: 'daily', anchorDate, timeZone: 'UTC' }),
    ).toThrow();
  },
);
it('rejects invalid zone and produces operation-specific stable successor UUIDs', () => {
  expect(() =>
    validateRecurrence({
      frequency: 'weekly',
      anchorDate: '2026-10-19',
      timeZone: 'Invalid/Zone',
    }),
  ).toThrow(/time zone/);
  const id = successorId('series', '2026-10-25', 'operation');
  expect(id).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  expect(successorId('series', '2026-10-25', 'operation')).toBe(id);
  expect(successorId('series', '2026-10-25', 'after-undo')).not.toBe(id);
});

it.each(occurrenceIdentityCases)(
  'freezes successor identity for %s / %s / %s',
  (series, date, operation, expected) => {
    expect(successorId(series, date, operation)).toBe(expected);
  },
);
