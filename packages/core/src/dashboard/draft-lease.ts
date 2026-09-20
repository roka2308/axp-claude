/**
 * The one-editor-at-a-time rule (Master Spec §21, D3).
 *
 * A lease is a claim on the draft that expires by itself. It exists because
 * two people autosaving the same draft would otherwise take turns overwriting
 * each other, and the optimistic revision check would only tell the loser
 * afterwards.
 *
 * Three properties shape the design:
 *
 *   - it expires without anyone doing anything, so a closed laptop does not
 *     block a colleague forever;
 *   - it can be taken over deliberately before it expires, because waiting two
 *     minutes for someone who went home is not a workflow;
 *   - it is never a security control. Whether a user may edit at all is an
 *     authorization question, answered before this is consulted.
 *
 * The decision is a pure function so the interesting cases - expiry boundary,
 * same user reconnecting, takeover - can be tested without a database.
 */

export interface LeaseSnapshot {
  readonly userId: string | null;
  readonly expiresAt: Date | null;
}

export interface LeaseRequest {
  readonly current: LeaseSnapshot;
  readonly requesterId: string;
  readonly now: Date;
  readonly ttlSeconds: number;
  /** A deliberate takeover, which ignores a live lease held by someone else. */
  readonly force?: boolean;
}

export type LeaseDecision =
  | {
      readonly kind: 'granted';
      readonly expiresAt: Date;
      /** Why it was free: nothing held it, it expired, or the caller had it. */
      readonly reason: 'unheld' | 'expired' | 'renewed' | 'taken_over';
    }
  | {
      readonly kind: 'held_by_other';
      readonly userId: string;
      readonly expiresAt: Date;
    };

export function decideLease(request: LeaseRequest): LeaseDecision {
  const { current, requesterId, now, ttlSeconds, force } = request;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  if (!current.userId || !current.expiresAt) {
    return { kind: 'granted', expiresAt, reason: 'unheld' };
  }

  if (current.userId === requesterId) {
    return { kind: 'granted', expiresAt, reason: 'renewed' };
  }

  // Expiry is inclusive of the instant itself: a lease that expires now is
  // gone now. The alternative leaves a lease alive for one more tick with no
  // benefit to anybody.
  if (current.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'granted', expiresAt, reason: 'expired' };
  }

  if (force) {
    return { kind: 'granted', expiresAt, reason: 'taken_over' };
  }

  return { kind: 'held_by_other', userId: current.userId, expiresAt: current.expiresAt };
}

/** Whether this user may write to the draft right now. */
export function holdsLease(current: LeaseSnapshot, userId: string, now: Date): boolean {
  if (!current.userId || !current.expiresAt) return false;
  return current.userId === userId && current.expiresAt.getTime() > now.getTime();
}

/** Whether somebody else is actively editing. */
export function isHeldByOther(current: LeaseSnapshot, userId: string, now: Date): boolean {
  if (!current.userId || !current.expiresAt) return false;
  return current.userId !== userId && current.expiresAt.getTime() > now.getTime();
}
