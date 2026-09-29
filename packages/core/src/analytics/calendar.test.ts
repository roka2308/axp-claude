import { describe, expect, it } from 'vitest';
import { AppError } from '@axp/contracts';
import {
  startOfDayInstant,
  addDays,
  addYears,
  daysBetween,
  enumeratePeriods,
  granularityFor,
  isoWeekday,
  resolveComparison,
  resolveTimeRange,
  startOfWeek,
  todayIn,
} from './calendar';

/**
 * The analytics calendar decides what a number is about. These tests guard the
 * two properties acceptance depends on: the calendar follows the Matomo site
 * time zone, and a comparison period is always the same length as the range it
 * is compared against (Master Spec §19 and §27).
 */

// 2026-09-20T00:30:00Z is still 2026-09-20 in Berlin (02:30 local) but
// 2026-09-19 in Los Angeles (17:30 the previous day).
const NOW = new Date('2026-09-20T00:30:00.000Z');

describe('site time zone', () => {
  it('resolves "today" in the site time zone, not the server time zone', () => {
    expect(todayIn('Europe/Berlin', NOW)).toBe('2026-09-20');
    expect(todayIn('America/Los_Angeles', NOW)).toBe('2026-09-19');
    expect(todayIn('UTC', NOW)).toBe('2026-09-20');
  });

  it('rejects an unknown time zone instead of silently falling back to UTC', () => {
    expect(() => todayIn('Mars/Olympus_Mons', NOW)).toThrow(AppError);
  });
});

describe('time range presets', () => {
  const resolve = (preset: Parameters<typeof resolveTimeRange>[0]['preset']) =>
    resolveTimeRange({ preset, timezone: 'Europe/Berlin', now: NOW });

  it('ends "last N days" yesterday, so no partial day skews the total', () => {
    // Including today would compare seven full days against six plus a fragment.
    expect(resolve('last_7_days')).toMatchObject({ from: '2026-09-13', to: '2026-09-19' });
    expect(resolve('last_30_days')).toMatchObject({ from: '2026-08-21', to: '2026-09-19' });
    expect(resolve('yesterday')).toMatchObject({ from: '2026-09-19', to: '2026-09-19' });
  });

  it('includes today for the current-period presets', () => {
    // "Current month" means month-to-date; excluding today would be surprising.
    expect(resolve('today')).toMatchObject({ from: '2026-09-20', to: '2026-09-20' });
    expect(resolve('current_month')).toMatchObject({ from: '2026-09-01', to: '2026-09-20' });
    expect(resolve('current_year')).toMatchObject({ from: '2026-01-01', to: '2026-09-20' });
  });

  it('resolves complete previous periods', () => {
    expect(resolve('previous_month')).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(resolve('previous_quarter')).toMatchObject({ from: '2026-04-01', to: '2026-06-30' });
    expect(resolve('previous_year')).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('starts weeks on Monday', () => {
    // 2026-09-20 is a Sunday, so the current week began on the 14th.
    expect(isoWeekday('2026-09-20')).toBe(7);
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14');
    expect(resolve('previous_week')).toMatchObject({ from: '2026-09-07', to: '2026-09-13' });
  });

  it('refuses an incomplete or inverted custom range', () => {
    expect(() =>
      resolveTimeRange({ preset: 'custom', timezone: 'UTC', now: NOW, from: '2026-01-01' }),
    ).toThrow(AppError);

    expect(() =>
      resolveTimeRange({
        preset: 'custom',
        timezone: 'UTC',
        now: NOW,
        from: '2026-02-01',
        to: '2026-01-01',
      }),
    ).toThrow(AppError);
  });
});

describe('comparison', () => {
  it('gives the previous period exactly the same length as the range', () => {
    // This is what makes a comparison semantically valid (Master Spec §27).
    for (const preset of ['last_7_days', 'last_30_days', 'previous_month'] as const) {
      const range = resolveTimeRange({ preset, timezone: 'Europe/Berlin', now: NOW });
      const comparison = resolveComparison(range, 'previous_period');

      expect(daysBetween(comparison.from!, comparison.to!)).toBe(daysBetween(range.from, range.to));
      // And it ends immediately before the range starts, with no gap or overlap.
      expect(addDays(comparison.to!, 1)).toBe(range.from);
    }
  });

  it('shifts the calendar dates by a year for the prior-year comparison', () => {
    const range = resolveTimeRange({ preset: 'last_30_days', timezone: 'UTC', now: NOW });
    const comparison = resolveComparison(range, 'prior_year');

    expect(comparison).toMatchObject({ from: '2025-08-21', to: '2025-09-19' });
  });

  it('maps 29 February onto 28 February rather than sliding into March', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });

  it('returns no dates when no comparison was requested', () => {
    const range = resolveTimeRange({ preset: 'last_7_days', timezone: 'UTC', now: NOW });
    expect(resolveComparison(range, 'none')).toEqual({ mode: 'none' });
  });
});

describe('granularity and periods', () => {
  it('keeps a chart readable by widening the bucket with the range', () => {
    const range = (from: string, to: string) => ({ preset: 'custom' as const, from, to });

    expect(granularityFor(range('2026-09-01', '2026-09-30'))).toBe('day');
    expect(granularityFor(range('2026-06-01', '2026-09-30'))).toBe('week');
    expect(granularityFor(range('2025-01-01', '2026-09-30'))).toBe('month');
  });

  it('enumerates one period per bucket, covering the whole range', () => {
    const days = enumeratePeriods(
      { preset: 'custom', from: '2026-09-01', to: '2026-09-07' },
      'day',
    );
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-09-01');
    expect(days.at(-1)).toBe('2026-09-07');

    const months = enumeratePeriods(
      { preset: 'custom', from: '2026-01-15', to: '2026-04-02' },
      'month',
    );
    expect(months).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  });
});

describe('date arithmetic', () => {
  it('counts inclusive days', () => {
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(1);
    expect(daysBetween('2026-09-01', '2026-09-07')).toBe(7);
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is unaffected by daylight saving transitions', () => {
    // Europe/Berlin changes clocks on 2026-03-29; a Date-based implementation
    // would lose or gain an hour and could slip a day here.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(3);
  });
});

describe('start of a day in a time zone', () => {
  it('finds midnight in the zone, in summer and in winter', () => {
    expect(startOfDayInstant('2026-07-15', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-14T22:00:00.000Z',
    );
    expect(startOfDayInstant('2026-12-15', 'Europe/Berlin').toISOString()).toBe(
      '2026-12-14T23:00:00.000Z',
    );
    expect(startOfDayInstant('2026-07-15', 'UTC').toISOString()).toBe('2026-07-15T00:00:00.000Z');
    expect(startOfDayInstant('2026-07-15', 'America/New_York').toISOString()).toBe(
      '2026-07-15T04:00:00.000Z',
    );
  });

  it('handles the days daylight saving time starts and ends', () => {
    expect(startOfDayInstant('2026-03-29', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(startOfDayInstant('2026-03-30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    expect(startOfDayInstant('2026-10-26', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });
});
