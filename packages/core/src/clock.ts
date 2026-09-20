/**
 * Injected clock.
 *
 * Session expiry, token lifetimes, lockout windows and scheduling all depend on
 * "now". Injecting it keeps those rules testable without sleeping, and the
 * lint rule `no-restricted-syntax` forbids bare `new Date()` in product code so
 * the seam cannot be bypassed by accident.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax -- the one legitimate source of time
  now: () => new Date(),
};

/** Test double: starts at a fixed instant and only moves when asked. */
export function fixedClock(
  start: Date,
): Clock & { advance(ms: number): void; set(at: Date): void } {
  let current = new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    set: (at: Date) => {
      current = new Date(at.getTime());
    },
  };
}

export const minutes = (n: number): number => n * 60_000;
export const hours = (n: number): number => n * 3_600_000;
export const days = (n: number): number => n * 86_400_000;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
