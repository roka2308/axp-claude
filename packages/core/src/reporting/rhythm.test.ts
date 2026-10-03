import { describe, expect, it } from 'vitest';
import { isKnownTimezone, nextOccurrence } from './rhythm';

const BERLIN = 'Europe/Berlin';
const at = (iso: string) => new Date(iso);

describe('next report occurrence', () => {
  it('runs daily at the local time, later today or tomorrow', () => {
    const rhythm = { frequency: 'daily', time: '07:00' } as const;
    // 05:00 UTC is 07:00 in Berlin summer time.
    expect(nextOccurrence(rhythm, BERLIN, at('2026-09-29T04:00:00Z')).toISOString()).toBe(
      '2026-09-29T05:00:00.000Z',
    );
    expect(nextOccurrence(rhythm, BERLIN, at('2026-09-29T05:00:00Z')).toISOString()).toBe(
      '2026-09-30T05:00:00.000Z',
    );
  });

  it('keeps the local time across the switch to winter time', () => {
    const rhythm = { frequency: 'daily', time: '07:00' } as const;
    // Sunday 25 October 2026 is the switch: 07:00 local is 06:00 UTC from then on.
    expect(nextOccurrence(rhythm, BERLIN, at('2026-10-24T06:00:00Z')).toISOString()).toBe(
      '2026-10-25T06:00:00.000Z',
    );
  });

  it('runs weekly on its weekday', () => {
    const rhythm = { frequency: 'weekly', time: '08:30', weekday: 1 } as const;
    // Tuesday 29 September 2026 -> Monday 5 October.
    expect(nextOccurrence(rhythm, BERLIN, at('2026-09-29T10:00:00Z')).toISOString()).toBe(
      '2026-10-05T06:30:00.000Z',
    );
  });

  it('runs on chosen weekdays for a custom rhythm', () => {
    const rhythm = { frequency: 'custom' as const, time: '09:00', weekdays: [1, 3, 5] };
    // Tuesday -> Wednesday.
    expect(nextOccurrence(rhythm, BERLIN, at('2026-09-29T10:00:00Z')).toISOString()).toBe(
      '2026-09-30T07:00:00.000Z',
    );
  });

  it('runs monthly on a day, or on the last day of each month', () => {
    expect(
      nextOccurrence(
        { frequency: 'monthly', time: '06:00', dayOfMonth: 1 },
        BERLIN,
        at('2026-09-29T10:00:00Z'),
      ).toISOString(),
    ).toBe('2026-10-01T04:00:00.000Z');
    expect(
      nextOccurrence(
        { frequency: 'monthly', time: '18:00', dayOfMonth: 'last' },
        BERLIN,
        at('2026-02-01T00:00:00Z'),
      ).toISOString(),
    ).toBe('2026-02-28T17:00:00.000Z');
  });

  it('runs quarterly in the first month of each quarter', () => {
    expect(
      nextOccurrence(
        { frequency: 'quarterly', time: '07:00', dayOfMonth: 2 },
        BERLIN,
        at('2026-09-29T10:00:00Z'),
      ).toISOString(),
    ).toBe('2026-10-02T05:00:00.000Z');
    expect(
      nextOccurrence(
        { frequency: 'quarterly', time: '07:00', dayOfMonth: 2 },
        BERLIN,
        at('2026-10-02T05:00:00Z'),
      ).toISOString(),
    ).toBe('2027-01-02T06:00:00.000Z');
  });

  it('decides "today" in the schedule time zone, not in UTC', () => {
    // 23:30 UTC on the 29th is already the 30th in Tokyo.
    expect(
      nextOccurrence(
        { frequency: 'daily', time: '09:00' },
        'Asia/Tokyo',
        at('2026-09-29T23:30:00Z'),
      ).toISOString(),
    ).toBe('2026-09-30T00:00:00.000Z');
  });

  it('knows real time zones from made-up ones', () => {
    expect(isKnownTimezone('Europe/Berlin')).toBe(true);
    expect(isKnownTimezone('Mars/Olympus_Mons')).toBe(false);
  });
});
