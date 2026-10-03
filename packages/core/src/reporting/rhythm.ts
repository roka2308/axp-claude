import type { ReportRhythm } from '@axp/contracts';
import { addDays, endOfMonth, isoWeekday, todayIn, wallClockInstant } from '../analytics/calendar';

/**
 * When a report runs next (Master Spec §15: explicit time zone).
 *
 * Pure: the rhythm, the schedule's time zone and a moment in, the next due
 * instant out - strictly after that moment. "Monday 07:00 in Europe/Berlin"
 * stays 07:00 local across daylight saving time, which a fixed UTC interval
 * would not.
 */
export function nextOccurrence(rhythm: ReportRhythm, timezone: string, after: Date): Date {
  // Start the day before, in case the zone's "today" is behind UTC's.
  let date = addDays(todayIn(timezone, after), -1);
  // A quarterly report on the last day of a quarter's first month is at most
  // about 100 days away; a year is a generous upper bound.
  for (let step = 0; step < 400; step += 1, date = addDays(date, 1)) {
    if (!matches(rhythm, date)) continue;
    const candidate = wallClockInstant(date, rhythm.time, timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`No occurrence of ${JSON.stringify(rhythm)} within a year.`);
}

function matches(rhythm: ReportRhythm, date: string): boolean {
  switch (rhythm.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return isoWeekday(date) === rhythm.weekday;
    case 'custom':
      return (rhythm.weekdays ?? []).includes(isoWeekday(date));
    case 'monthly':
      return dayMatches(rhythm, date);
    case 'quarterly': {
      const month = Number(date.slice(5, 7));
      return [1, 4, 7, 10].includes(month) && dayMatches(rhythm, date);
    }
  }
}

function dayMatches(rhythm: ReportRhythm, date: string): boolean {
  if (rhythm.dayOfMonth === 'last') return endOfMonth(date) === date;
  return Number(date.slice(8, 10)) === rhythm.dayOfMonth;
}

/** Whether a string names a time zone this runtime knows. */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
