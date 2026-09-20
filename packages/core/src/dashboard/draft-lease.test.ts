import { describe, expect, it } from 'vitest';
import { decideLease, holdsLease, isHeldByOther, type LeaseSnapshot } from './draft-lease';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const TTL = 120;

const unheld: LeaseSnapshot = { userId: null, expiresAt: null };
const heldByAnna = (expiresAt: string): LeaseSnapshot => ({
  userId: 'anna',
  expiresAt: new Date(expiresAt),
});

describe('acquiring a lease', () => {
  it('grants a free draft', () => {
    const decision = decideLease({
      current: unheld,
      requesterId: 'ben',
      now: NOW,
      ttlSeconds: TTL,
    });

    expect(decision).toMatchObject({ kind: 'granted', reason: 'unheld' });
    expect(decision.kind === 'granted' && decision.expiresAt.toISOString()).toBe(
      '2026-09-20T12:02:00.000Z',
    );
  });

  it('renews for the editor who already holds it', () => {
    // A heartbeat, not a second claim: the same person reconnecting must not
    // have to wait for their own lease to expire.
    const decision = decideLease({
      current: heldByAnna('2026-09-20T12:01:00.000Z'),
      requesterId: 'anna',
      now: NOW,
      ttlSeconds: TTL,
    });

    expect(decision).toMatchObject({ kind: 'granted', reason: 'renewed' });
  });

  it('refuses while someone else is actively editing', () => {
    const decision = decideLease({
      current: heldByAnna('2026-09-20T12:01:00.000Z'),
      requesterId: 'ben',
      now: NOW,
      ttlSeconds: TTL,
    });

    // Not an error - the caller is told who has it, so the UI can offer a
    // takeover instead of a dead end (D10).
    expect(decision).toMatchObject({ kind: 'held_by_other', userId: 'anna' });
  });

  it('grants once the other lease has expired', () => {
    const decision = decideLease({
      current: heldByAnna('2026-09-20T11:59:00.000Z'),
      requesterId: 'ben',
      now: NOW,
      ttlSeconds: TTL,
    });

    expect(decision).toMatchObject({ kind: 'granted', reason: 'expired' });
  });

  it('treats the expiry instant itself as expired', () => {
    // Otherwise a lease survives one more tick for no one's benefit, and the
    // boundary becomes a source of flaky behaviour.
    const decision = decideLease({
      current: heldByAnna(NOW.toISOString()),
      requesterId: 'ben',
      now: NOW,
      ttlSeconds: TTL,
    });

    expect(decision).toMatchObject({ kind: 'granted', reason: 'expired' });
  });
});

describe('taking over', () => {
  it('overrides a live lease when the takeover is deliberate', () => {
    const decision = decideLease({
      current: heldByAnna('2026-09-20T12:01:00.000Z'),
      requesterId: 'ben',
      now: NOW,
      ttlSeconds: TTL,
      force: true,
    });

    expect(decision).toMatchObject({ kind: 'granted', reason: 'taken_over' });
  });

  it('still reports a plain acquisition as such', () => {
    // `force` describes intent, not outcome: taking over a free draft is not
    // a takeover, and the audit trail should not claim it was.
    const decision = decideLease({
      current: unheld,
      requesterId: 'ben',
      now: NOW,
      ttlSeconds: TTL,
      force: true,
    });

    expect(decision).toMatchObject({ kind: 'granted', reason: 'unheld' });
  });
});

describe('who may write', () => {
  it('recognises the holder of a live lease', () => {
    expect(holdsLease(heldByAnna('2026-09-20T12:01:00.000Z'), 'anna', NOW)).toBe(true);
    expect(holdsLease(heldByAnna('2026-09-20T11:59:00.000Z'), 'anna', NOW)).toBe(false);
    expect(holdsLease(unheld, 'anna', NOW)).toBe(false);
  });

  it('recognises an active editor who is somebody else', () => {
    expect(isHeldByOther(heldByAnna('2026-09-20T12:01:00.000Z'), 'ben', NOW)).toBe(true);
    expect(isHeldByOther(heldByAnna('2026-09-20T12:01:00.000Z'), 'anna', NOW)).toBe(false);
    expect(isHeldByOther(heldByAnna('2026-09-20T11:59:00.000Z'), 'ben', NOW)).toBe(false);
  });
});
