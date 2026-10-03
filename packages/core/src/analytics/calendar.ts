import {
  AppError,
  type CalendarDate,
  type ComparisonMode,
  type ComparisonSpec,
  type TimeGranularity,
  type TimeRange,
  type TimeRangePreset,
} from '@axp/contracts';

/**
 * Analytics calendar (Master Spec §19).
 *
 * The analytics calendar follows the Matomo site time zone - not the server's
 * and not the browser's. "Yesterday" for a Berlin site is a different day than
 * for a Los Angeles site, and a dashboard shared between them must not silently
 * disagree about which day it means.
 *
 * Dates are handled as plain `YYYY-MM-DD` strings rather than Date objects:
 * a calendar day has no time zone once resolved, and keeping it a string
 * removes a whole class of off-by-one-day bugs.
 */

/** The calendar date "now" falls on in the given IANA time zone. */
export function todayIn(timezone: string, now: Date): CalendarDate {
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    throw new AppError('invalid_configuration', {
      code: 'unknown_timezone',
      messageKey: 'analytics.unknown_timezone',
      messageParams: { timezone },
      internalMessage: `Unknown IANA time zone: ${timezone}`,
    });
  }
}

export function parseCalendarDate(date: CalendarDate): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new AppError('validation_failed', {
      code: 'invalid_calendar_date',
      messageKey: 'analytics.invalid_date',
      internalMessage: `Expected YYYY-MM-DD, got "${date}".`,
    });
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The instant a calendar day begins in a time zone.
 *
 * For deadlines people set as a date - "valid until 15 October" means until
 * that day ends where the project lives, not where the server runs. Handles
 * daylight-saving days, where a day is 23 or 25 hours long.
 */
export function startOfDayInstant(date: CalendarDate, timezone: string): Date {
  return wallClockInstant(date, '00:00', timezone);
}

/**
 * The instant a local wall-clock time occurs on a day in a time zone.
 *
 * On the night clocks jump forward, a time that does not exist (02:30 in
 * Berlin) resolves to the hour after the jump; on the night they fall back, the
 * first of the two occurrences is taken.
 */
export function wallClockInstant(date: CalendarDate, time: string, timezone: string): Date {
  const { year, month, day } = parseCalendarDate(date);
  const [hours, minutes] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hours ?? 0, minutes ?? 0);
  let instant = wall;
  // Two rounds settle the offset even when the guess lands across a switch.
  for (let round = 0; round < 2; round += 1) {
    instant = wall - zoneOffsetMs(new Date(instant), timezone);
  }
  return new Date(instant);
}

function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function toUtcMillis(date: CalendarDate): number {
  const { year, month, day } = parseCalendarDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMillis(millis: number): CalendarDate {
  return new Date(millis).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromUtcMillis(toUtcMillis(date) + days * DAY_MS);
}

/** Inclusive day count: `from` and `to` on the same day is 1. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / DAY_MS) + 1;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return toUtcMillis(a) - toUtcMillis(b);
}

/** ISO weekday, Monday = 1 … Sunday = 7. */
export function isoWeekday(date: CalendarDate): number {
  const day = new Date(toUtcMillis(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Weeks start on Monday (ISO 8601), which is what DE/EN business reporting expects. */
export function startOfWeek(date: CalendarDate): CalendarDate {
  return addDays(date, -(isoWeekday(date) - 1));
}

export function startOfMonth(date: CalendarDate): CalendarDate {
  const { year, month } = parseCalendarDate(date);
  return `${pad4(year)}-${pad2(month)}-01`;
}

export function endOfMonth(date: CalendarDate): CalendarDate {
  const { year, month } = parseCalendarDate(date);
  return fromUtcMillis(Date.UTC(year, month, 0));
}

export function startOfQuarter(date: CalendarDate): CalendarDate {
  const { year, month } = parseCalendarDate(date);
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return `${pad4(year)}-${pad2(quarterStartMonth)}-01`;
}

export function startOfYear(date: CalendarDate): CalendarDate {
  return `${pad4(parseCalendarDate(date).year)}-01-01`;
}

/**
 * Shifts a date by whole years.
 *
 * 29 February has no counterpart in a non-leap year; it becomes 28 February,
 * which keeps the period aligned rather than silently sliding into March.
 */
export function addYears(date: CalendarDate, years: number): CalendarDate {
  const { year, month, day } = parseCalendarDate(date);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return `${pad4(targetYear)}-${pad2(month)}-${pad2(Math.min(day, lastDay))}`;
}

export interface ResolveTimeRangeInput {
  readonly preset: TimeRangePreset;
  readonly timezone: string;
  readonly now: Date;
  /** Required for the `custom` preset. */
  readonly from?: CalendarDate;
  readonly to?: CalendarDate;
}

/**
 * Turns a preset into concrete dates, in the site's calendar.
 *
 * "Last 7 days" ends yesterday: including a partial today would compare a full
 * week against six days plus a fragment, which is the kind of quiet
 * apples-to-oranges the product is supposed to prevent.
 */
export function resolveTimeRange(input: ResolveTimeRangeInput): TimeRange {
  const today = todayIn(input.timezone, input.now);
  const yesterday = addDays(today, -1);

  const range = (from: CalendarDate, to: CalendarDate): TimeRange => ({
    preset: input.preset,
    from,
    to,
  });

  switch (input.preset) {
    case 'today':
      return range(today, today);
    case 'yesterday':
      return range(yesterday, yesterday);
    case 'last_7_days':
      return range(addDays(yesterday, -6), yesterday);
    case 'last_14_days':
      return range(addDays(yesterday, -13), yesterday);
    case 'last_30_days':
      return range(addDays(yesterday, -29), yesterday);
    case 'current_week':
      return range(startOfWeek(today), today);
    case 'previous_week': {
      const start = addDays(startOfWeek(today), -7);
      return range(start, addDays(start, 6));
    }
    case 'current_month':
      return range(startOfMonth(today), today);
    case 'previous_month': {
      const previous = addDays(startOfMonth(today), -1);
      return range(startOfMonth(previous), previous);
    }
    case 'current_quarter':
      return range(startOfQuarter(today), today);
    case 'previous_quarter': {
      const previous = addDays(startOfQuarter(today), -1);
      return range(startOfQuarter(previous), previous);
    }
    case 'current_year':
      return range(startOfYear(today), today);
    case 'previous_year': {
      const previous = addDays(startOfYear(today), -1);
      return range(startOfYear(previous), previous);
    }
    case 'custom': {
      if (!input.from || !input.to) {
        throw new AppError('validation_failed', {
          code: 'custom_range_incomplete',
          messageKey: 'analytics.custom_range_incomplete',
          internalMessage: 'A custom time range needs both from and to.',
        });
      }
      if (compareDates(input.from, input.to) > 0) {
        throw new AppError('validation_failed', {
          code: 'custom_range_inverted',
          messageKey: 'analytics.custom_range_inverted',
          internalMessage: `Range start ${input.from} is after end ${input.to}.`,
        });
      }
      return range(input.from, input.to);
    }
  }
}

/**
 * Resolves the comparison period.
 *
 * `previous_period` uses the same number of days immediately before the range,
 * so the two sides are always the same length - the property that makes a
 * comparison semantically valid (Master Spec §27 "semantisch korrekte
 * Comparison"). `prior_year` keeps the calendar dates and shifts the year,
 * which is what people mean by "same period last year" even when weekday
 * alignment differs.
 */
export function resolveComparison(
  timeRange: TimeRange,
  mode: ComparisonMode,
  custom?: { from?: CalendarDate; to?: CalendarDate },
): ComparisonSpec {
  switch (mode) {
    case 'none':
      return { mode: 'none' };

    case 'previous_period': {
      const length = daysBetween(timeRange.from, timeRange.to);
      const to = addDays(timeRange.from, -1);
      return { mode, from: addDays(to, -(length - 1)), to };
    }

    case 'prior_year':
      return {
        mode,
        from: addYears(timeRange.from, -1),
        to: addYears(timeRange.to, -1),
      };

    case 'custom': {
      if (!custom?.from || !custom.to) {
        throw new AppError('validation_failed', {
          code: 'custom_comparison_incomplete',
          messageKey: 'analytics.custom_comparison_incomplete',
          internalMessage: 'A custom comparison needs both from and to.',
        });
      }
      return { mode, from: custom.from, to: custom.to };
    }
  }
}

/**
 * Picks a granularity that keeps a chart readable.
 *
 * Roughly: up to about a month daily, up to about half a year weekly, beyond
 * that monthly. A year of daily points is neither readable nor useful.
 */
export function granularityFor(timeRange: TimeRange): TimeGranularity {
  const days = daysBetween(timeRange.from, timeRange.to);
  if (days <= 31) return 'day';
  if (days <= 180) return 'week';
  return 'month';
}

/** Period start dates covering the range at the given granularity. */
export function enumeratePeriods(
  timeRange: TimeRange,
  granularity: TimeGranularity,
): CalendarDate[] {
  const periods: CalendarDate[] = [];
  let cursor =
    granularity === 'day'
      ? timeRange.from
      : granularity === 'week'
        ? startOfWeek(timeRange.from)
        : startOfMonth(timeRange.from);

  // Bounded so a malformed range cannot spin here.
  for (let guard = 0; guard < 4000 && compareDates(cursor, timeRange.to) <= 0; guard += 1) {
    periods.push(cursor);
    cursor =
      granularity === 'day'
        ? addDays(cursor, 1)
        : granularity === 'week'
          ? addDays(cursor, 7)
          : startOfMonth(addDays(endOfMonth(cursor), 1));
  }

  return periods;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}
