import { z } from 'zod';
import type { SemanticLifecycle } from './lifecycle.js';

/**
 * Semantic layer (Master Spec §13, Shared Contract §7).
 *
 * Four layers sit between Matomo and a dashboard:
 *   Matomo technical source -> local source binding -> semantic definition ->
 *   scores, widgets, dashboards.
 *
 * A definition has a stable identity and immutable versions. Published
 * dashboards pin version ids, so activating a new version never changes what a
 * published dashboard shows until someone deliberately updates and republishes.
 */

export const SEMANTIC_TYPES = ['native_metric', 'custom_metric', 'formula', 'score'] as const;
export const semanticTypeSchema = z.enum(SEMANTIC_TYPES);
export type SemanticType = z.infer<typeof semanticTypeSchema>;

/** How a number should be read. Units are validated across formula inputs. */
export const SEMANTIC_UNITS = [
  'count',
  'percent',
  'ratio',
  'seconds',
  'currency',
  'score',
] as const;
export const semanticUnitSchema = z.enum(SEMANTIC_UNITS);
export type SemanticUnit = z.infer<typeof semanticUnitSchema>;

/** What a metric is counted over. Combining incompatible scopes is blocked. */
export const SEMANTIC_SCOPES = ['visit', 'action', 'event', 'site'] as const;
export const semanticScopeSchema = z.enum(SEMANTIC_SCOPES);
export type SemanticScope = z.infer<typeof semanticScopeSchema>;

/** Whether a higher value is better. Drives comparison and evaluation display. */
export const SEMANTIC_DIRECTIONS = ['higher_is_better', 'lower_is_better', 'neutral'] as const;
export const semanticDirectionSchema = z.enum(SEMANTIC_DIRECTIONS);
export type SemanticDirection = z.infer<typeof semanticDirectionSchema>;

/**
 * A native metric maps directly onto something the connector normalises.
 *
 * `sourceMetric` is a normalised name owned by the connector, not a raw Matomo
 * API field: the mapping from Matomo's `nb_visits` to `visits` lives in the
 * connector, so the semantic layer never hard-codes vendor field names.
 */
export interface NativeMetricDefinition {
  readonly kind: 'native';
  readonly sourceMetric: string;
  readonly unit: SemanticUnit;
  readonly scope: SemanticScope;
  readonly direction: SemanticDirection;
  /** Decimal places for display. Rounding is explicit, never incidental. */
  readonly decimals: number;
}

/**
 * A custom metric binds to a source that needs local mapping - an event
 * category, a custom dimension. Resolved through a source binding.
 */
export interface CustomMetricDefinition {
  readonly kind: 'custom';
  readonly requirementKey: string;
  readonly unit: SemanticUnit;
  readonly scope: SemanticScope;
  readonly direction: SemanticDirection;
  readonly decimals: number;
}

/**
 * Formula AST (Shared Contract §7).
 *
 * A controlled tree, never SQL, JavaScript, regex or any other executable
 * string. There is no expression parser anywhere in the product: a formula is
 * built as a tree and stored as a tree, so there is nothing to escape and
 * nothing to sandbox.
 */
export type FormulaNode =
  | { readonly type: 'constant'; readonly value: number }
  | { readonly type: 'reference'; readonly semanticVersionId: string }
  | {
      readonly type: 'binary';
      readonly op: '+' | '-' | '*' | '/';
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    }
  | {
      readonly type: 'function';
      readonly name: 'MIN' | 'MAX' | 'AVG' | 'ROUND' | 'COALESCE';
      readonly args: readonly FormulaNode[];
    };

export interface FormulaDefinition {
  readonly kind: 'formula';
  readonly ast: FormulaNode;
  readonly unit: SemanticUnit;
  readonly scope: SemanticScope;
  readonly direction: SemanticDirection;
  readonly decimals: number;
}

/**
 * How a raw measurement becomes points on a 0-100 scale.
 *
 * Declared per component rather than inferred, because "what counts as good"
 * is a business decision and the product must not guess it. Both shapes are
 * things a visual builder can draw: a line between two ends, or a staircase.
 */
export type ScoreNormalisation =
  | {
      readonly kind: 'linear';
      /** The value that scores 0. May be above `best` for lower-is-better. */
      readonly worst: number;
      /** The value that scores 100. */
      readonly best: number;
    }
  | {
      readonly kind: 'bands';
      /** Ascending thresholds; the highest one the value reaches wins. */
      readonly bands: readonly { readonly atLeast: number; readonly points: number }[];
    };

/**
 * One weighted input of a score.
 *
 * Every component is required. A score that quietly renormalised the weights
 * around a missing input would report a number that means "out of the parts we
 * could measure" while looking like "out of 100" - which is exactly the
 * failure Gate F3 exists to prevent. A missing input makes the whole score
 * `not_calculable`, and says which input was missing.
 */
export interface ScoreComponent {
  readonly semanticVersionId: string;
  /** Relative weight. Normalised across components at evaluation time. */
  readonly weight: number;
  readonly normalisation: ScoreNormalisation;
  /** Shown in the calculation trace. Falls back to the definition's name. */
  readonly label?: string;
}

/**
 * Evaluation band: what a score number means in words (Master Spec §14).
 *
 * `band` picks one of the five evaluation token slots, so the colour comes
 * from the design system and the label always travels with it - a band is
 * never a colour alone (D9, D10).
 */
export interface EvaluationBand {
  /** i18n key suffix under `evaluation.`, e.g. `good`. */
  readonly key: string;
  /** Inclusive lower bound on the 0-100 scale. */
  readonly atLeast: number;
  readonly band: 1 | 2 | 3 | 4 | 5;
}

export interface ScoreDefinition {
  readonly kind: 'score';
  readonly components: readonly ScoreComponent[];
  /** Ascending by `atLeast`. May be empty: a score without an interpretation. */
  readonly evaluation: readonly EvaluationBand[];
  readonly unit: 'score';
  readonly scope: SemanticScope;
  readonly direction: SemanticDirection;
  readonly decimals: number;
}

export type SemanticDefinitionBody =
  NativeMetricDefinition | CustomMetricDefinition | FormulaDefinition | ScoreDefinition;

/** The unit and scope a definition produces, whatever kind it is. */
export function semanticUnitOf(body: SemanticDefinitionBody): SemanticUnit {
  return body.unit;
}

export function semanticScopeOf(body: SemanticDefinitionBody): SemanticScope {
  return body.scope;
}

export interface SemanticDefinitionRef {
  readonly id: string;
  /** Stable across installations; independent of the local database id. */
  readonly portableId: string;
  readonly type: SemanticType;
  readonly name: string;
  /**
   * The glossary entry: what this number means, in the business's own words.
   *
   * Separate from the version body on purpose. "Engagement" is explained the
   * same way whether it is currently computed one way or another, and a
   * rewording is not a new business version (Master Spec §13).
   */
  readonly description: string | null;
  readonly currentVersionId: string | null;
}

export interface SemanticVersionRef {
  readonly id: string;
  readonly definitionId: string;
  readonly version: number;
  readonly status: SemanticLifecycle;
  readonly body: SemanticDefinitionBody;
  readonly dependencyVersionIds: readonly string[];
}

/**
 * How a requirement is satisfied on one site (Master Spec §13).
 *
 * Deliberately separate from the semantic version: correcting a mapping is a
 * technical fix, and a new business version must not silently rewire it.
 */
export type SourceBindingDescriptor =
  | { readonly kind: 'native_metric'; readonly sourceMetric: string }
  | { readonly kind: 'event'; readonly category: string; readonly action?: string }
  | { readonly kind: 'custom_dimension'; readonly index: number }
  | { readonly kind: 'goal'; readonly goalId: number }
  | { readonly kind: 'site_search' }
  | { readonly kind: 'not_available' };

export interface SourceBindingRef {
  readonly id: string;
  readonly requirementKey: string;
  readonly siteId: string | null;
  readonly binding: SourceBindingDescriptor;
  readonly updatedAt: string;
}

/**
 * Whether what a binding points at still exists on the site.
 *
 * Drift is detected, never repaired automatically: a custom dimension that
 * disappeared may have been renamed, retired or broken, and only a person can
 * say which (Master Spec §13).
 */
export const DRIFT_STATES = ['ok', 'review_required', 'unresolved'] as const;
export const driftStateSchema = z.enum(DRIFT_STATES);
export type DriftState = z.infer<typeof driftStateSchema>;

export interface BindingHealth {
  readonly requirementKey: string;
  readonly siteId: string | null;
  readonly state: DriftState;
  /** i18n key explaining a non-ok state. */
  readonly detailKey?: string;
  /** What the site currently offers, for the person deciding what to do. */
  readonly availableSample?: readonly string[];
  /** Present once somebody has looked at this binding. */
  readonly review?: BindingReview;
}

/**
 * The review state of a binding: who last looked, and whether that still holds.
 *
 * Detection says a mapping no longer resolves; it cannot say what to do about
 * it. Someone deciding "the dimension really is gone and that is expected" is
 * an answer, and the product has to remember it - otherwise the same warning
 * is raised forever and stops being read.
 *
 * Recording a review touches no semantic version. Acknowledging a technical
 * fact is not a change to what a number means (Gate F3).
 */
export interface BindingReview {
  readonly reviewedAt: string;
  readonly reviewedBy: string | null;
  /**
   * Whether the site still looks the way it did when it was reviewed.
   *
   * False makes the review stale: the situation changed after somebody signed
   * off on it, so it needs looking at again rather than staying acknowledged.
   */
  readonly current: boolean;
}

/**
 * Where a definition is actually used (Master Spec §13, D6).
 *
 * The question behind every change to a definition is "what will this break".
 * Draft and published are counted separately because they answer different
 * questions: a draft will pick up a new active version at its next publish, a
 * published dashboard keeps the version it pinned.
 */
export interface SemanticUsage {
  readonly definitionId: string;
  /** Dashboards whose working copy references any version of this definition. */
  readonly draftDashboards: number;
  /** Dashboards whose published version pins one. */
  readonly publishedDashboards: number;
  /** Which versions published dashboards hold, newest version first. */
  readonly pinnedVersions: readonly {
    readonly versionId: string;
    readonly version: number;
    readonly dashboards: number;
  }[];
}

/**
 * What a definition needs in order to produce values, and whether it has it.
 *
 * Drives the recurring setup language `ready` / `setup_required` /
 * `ready_with_limitations` / `not_available` (Master Spec §13).
 */
export interface SemanticRequirement {
  readonly requirementKey: string;
  readonly satisfied: boolean;
  readonly detailKey?: string;
}

/** Portable ids of the native metrics the first vertical slice needs. */
export const CORE_NATIVE_METRICS = {
  visits: 'core.visits',
  pageviews: 'core.pageviews',
} as const;
