import { z } from 'zod';

/**
 * Context Profile (Master Spec §13, Requirements Baseline §15).
 *
 * "Kontext vor Interpretation": what the project is for, and for whom, before
 * anyone reads a number from it. A small required core - the use case and the
 * audience - plus optional fields. Plain text, written by the customer, never
 * auto-translated and never interpreted by the product.
 */
export const CONTEXT_PROFILE_CORE_FIELDS = ['useCase', 'audience'] as const;

export const CONTEXT_PROFILE_OPTIONAL_FIELDS = [
  'goals',
  'content',
  'success',
  'actions',
  'tracking',
  'events',
  'limits',
  'terms',
] as const;

export const CONTEXT_PROFILE_FIELDS = [
  ...CONTEXT_PROFILE_CORE_FIELDS,
  ...CONTEXT_PROFILE_OPTIONAL_FIELDS,
] as const;

export type ContextProfileField = (typeof CONTEXT_PROFILE_FIELDS)[number];

const profileText = z.string().trim().max(2000);

export const contextProfileSchema = z
  .object(
    Object.fromEntries(CONTEXT_PROFILE_FIELDS.map((field) => [field, profileText.optional()])) as {
      [K in ContextProfileField]: z.ZodOptional<typeof profileText>;
    },
  )
  .strict();

export type ContextProfile = Partial<Record<ContextProfileField, string>>;

/** The core is complete when every core field has text. */
export function contextProfileComplete(profile: ContextProfile | null | undefined): boolean {
  return CONTEXT_PROFILE_CORE_FIELDS.every((field) => Boolean(profile?.[field]?.trim()));
}

export function contextProfileStarted(profile: ContextProfile | null | undefined): boolean {
  return CONTEXT_PROFILE_FIELDS.some((field) => Boolean(profile?.[field]?.trim()));
}

/**
 * The setup checklist (Master Spec §13).
 *
 * Five states, the resumable non-linear checklist's vocabulary. `category`
 * says how much a step matters: core steps block readiness, conditional ones
 * only when they apply, optional ones never.
 */
export const SETUP_STEP_STATES = [
  'open',
  'in_progress',
  'done',
  'review_required',
  'not_relevant',
] as const;
export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

export const SETUP_STEP_CATEGORIES = ['core', 'conditional', 'optional'] as const;
export type SetupStepCategory = (typeof SETUP_STEP_CATEGORIES)[number];

export const SETUP_STEP_KEYS = [
  'context_profile',
  'matomo_connection',
  'site_assignment',
  'mapping',
  'first_dashboard',
  'reporting',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export interface SetupStep {
  /** i18n key, `setupStep.<step>`. */
  readonly key: string;
  readonly step: SetupStepKey;
  readonly state: SetupStepState;
  readonly category: SetupStepCategory;
  /** Whether the step currently blocks readiness. */
  readonly required: boolean;
  /** A person marked it not relevant; they can take that back. */
  readonly markedNotRelevant?: boolean;
  readonly detail?: string;
}

/** Steps a person may mark "not relevant": never one that readiness depends on. */
export const DISMISSABLE_SETUP_STEPS: readonly SetupStepKey[] = ['context_profile', 'reporting'];
