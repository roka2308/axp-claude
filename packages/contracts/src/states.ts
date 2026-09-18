import { z } from 'zod';

/**
 * Value / UI states (Master Spec §17 "D10", contracts/state_model.md).
 *
 * The hard rule behind this file: missing, unknown, not-applicable,
 * not-tracked and unavailable are NEVER silently rendered as numeric zero.
 * `zero` is a real measured value and a state of its own.
 */
export const VALUE_STATES = [
  'loading',
  'ready',
  'empty',
  'zero',
  'missing',
  'unknown',
  'not_applicable',
  'not_tracked',
  'unavailable',
  'warning',
] as const;

export const valueStateSchema = z.enum(VALUE_STATES);
export type ValueState = z.infer<typeof valueStateSchema>;

/**
 * Product cause states. The UI must not collapse these into one generic
 * "forbidden" or "error" screen (contracts/state_model.md).
 */
export const PRODUCT_CAUSE_STATES = [
  'permission_denied',
  'entitlement_required',
  'setup_required',
  'capability_unsupported',
  'temporarily_unavailable',
] as const;

export const productCauseStateSchema = z.enum(PRODUCT_CAUSE_STATES);
export type ProductCauseState = z.infer<typeof productCauseStateSchema>;

/** Recurring setup language across project/connection/template surfaces (§13). */
export const SETUP_READINESS_STATES = [
  'ready',
  'setup_required',
  'ready_with_limitations',
  'not_available',
] as const;

export const setupReadinessSchema = z.enum(SETUP_READINESS_STATES);
export type SetupReadiness = z.infer<typeof setupReadinessSchema>;

/** Attention Center severities (§15). Operational, never analytics alerting. */
export const ATTENTION_SEVERITIES = ['action_required', 'warning', 'information'] as const;
export const attentionSeveritySchema = z.enum(ATTENTION_SEVERITIES);
export type AttentionSeverity = z.infer<typeof attentionSeveritySchema>;

/** Data quality severities (§18). "Expected behaviour" is explicitly not an error. */
export const DATA_QUALITY_SEVERITIES = ['problem', 'warning', 'information', 'expected'] as const;
export const dataQualitySeveritySchema = z.enum(DATA_QUALITY_SEVERITIES);
export type DataQualitySeverity = z.infer<typeof dataQualitySeveritySchema>;

export interface DataQualityNote {
  readonly severity: DataQualitySeverity;
  /** i18n key; never a raw vendor message. */
  readonly messageKey: string;
  readonly details?: Readonly<Record<string, string | number>>;
}

/** Why an expected value is absent. `not_calculable` is the score case (§13). */
export type ValueMissingCause =
  | { readonly kind: 'not_calculable'; readonly missingInputs: readonly string[] }
  | { readonly kind: 'no_mapping'; readonly requirement: string }
  | { readonly kind: 'source_field_absent'; readonly requirement: string }
  | { readonly kind: 'other'; readonly messageKey: string };

export type SourceUnavailableCause =
  | { readonly kind: 'source_unreachable' }
  | { readonly kind: 'source_timeout' }
  | { readonly kind: 'source_error' }
  | { readonly kind: 'rate_limited' };

/**
 * Every numeric value that reaches the UI travels in this envelope.
 *
 * Modelled as a discriminated union on purpose: it is a type error to read
 * `.value` off a `missing` or `unavailable` result, which makes the
 * "never null -> zero" invariant enforceable by the compiler rather than by
 * review discipline alone.
 */
export type ValueEnvelope =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: number }
  | { readonly state: 'zero'; readonly value: 0 }
  | { readonly state: 'empty' }
  | { readonly state: 'missing'; readonly cause: ValueMissingCause }
  | { readonly state: 'unknown'; readonly messageKey?: string }
  | { readonly state: 'not_applicable'; readonly messageKey?: string }
  | { readonly state: 'not_tracked'; readonly messageKey?: string }
  | { readonly state: 'unavailable'; readonly cause: SourceUnavailableCause }
  | {
      readonly state: 'warning';
      readonly value: number;
      readonly notes: readonly DataQualityNote[];
    };

export const valueEnvelope = {
  loading: (): ValueEnvelope => ({ state: 'loading' }),
  empty: (): ValueEnvelope => ({ state: 'empty' }),
  missing: (cause: ValueMissingCause): ValueEnvelope => ({ state: 'missing', cause }),
  unknown: (messageKey?: string): ValueEnvelope => ({ state: 'unknown', messageKey }),
  notApplicable: (messageKey?: string): ValueEnvelope => ({ state: 'not_applicable', messageKey }),
  notTracked: (messageKey?: string): ValueEnvelope => ({ state: 'not_tracked', messageKey }),
  unavailable: (cause: SourceUnavailableCause): ValueEnvelope => ({ state: 'unavailable', cause }),
  notCalculable: (missingInputs: readonly string[]): ValueEnvelope => ({
    state: 'missing',
    cause: { kind: 'not_calculable', missingInputs },
  }),
  warning: (value: number, notes: readonly DataQualityNote[]): ValueEnvelope => ({
    state: 'warning',
    value,
    notes,
  }),
  /**
   * The only supported way to turn a number into a displayable value.
   *
   * A measured 0 becomes state `zero`, never `missing`. Null/undefined/NaN are
   * refused rather than coerced - callers must decide which absence state
   * applies, because the product may not guess.
   */
  measured: (value: number): ValueEnvelope => {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        'valueEnvelope.measured() refuses non-finite input. Choose an explicit absence state ' +
          '(missing / unknown / not_tracked / unavailable) instead of coercing to zero.',
      );
    }
    return value === 0 ? { state: 'zero', value: 0 } : { state: 'ready', value };
  },
} as const;

/** True when the envelope carries a number that may be displayed or charted. */
export function hasNumericValue(
  envelope: ValueEnvelope,
): envelope is Extract<ValueEnvelope, { value: number }> {
  return envelope.state === 'ready' || envelope.state === 'zero' || envelope.state === 'warning';
}
