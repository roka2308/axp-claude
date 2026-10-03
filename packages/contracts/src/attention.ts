import type { AttentionSeverity } from './states';

/**
 * Attention Center (Master Spec §15).
 *
 * Operational, never analytical. Every kind below is something about how the
 * product runs - a report that failed, a mapping to check, a link about to
 * expire, an account nobody uses - and none of them is about what a metric did.
 * There is deliberately no kind, no field and no route for "a value crossed a
 * threshold": analytics alerting is outside the MVP (Master Spec §29), and an
 * operational inbox that also cried wolf about numbers would stop being read.
 */
export const ATTENTION_KINDS = [
  'report_failed',
  'report_recipient_without_access',
  'share_expiring',
  'mapping_review',
  'inactivity_review',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/*
 * Severities live in `states.ts` (highest first). Mail goes out for
 * `action_required` only, once per group.
 */

export const ATTENTION_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AttentionStatus = (typeof ATTENTION_STATUSES)[number];

/**
 * One problem, however often it happened.
 *
 * Repeated occurrences of the same problem update one item - its count and
 * when it was last seen - instead of filling the list (grouping).
 */
export interface AttentionItem {
  readonly id: string;
  readonly kind: AttentionKind;
  readonly severity: AttentionSeverity;
  readonly status: Exclude<AttentionStatus, 'resolved'>;
  readonly messageKey: string;
  readonly messageParams: Readonly<Record<string, string | number>>;
  /** Where the problem is fixed. */
  readonly href?: string;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly tenantName: string;
  readonly projectName?: string;
}

export interface AttentionOverview {
  readonly items: readonly AttentionItem[];
  readonly counts: Readonly<Record<AttentionSeverity, number>>;
}
