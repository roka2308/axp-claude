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
 * string. The full builder, cycle and unit validation arrive with Phase 3; the
 * shape is fixed here so nothing else is invented in the meantime.
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

export type SemanticDefinitionBody =
  NativeMetricDefinition | CustomMetricDefinition | FormulaDefinition;

export interface SemanticDefinitionRef {
  readonly id: string;
  /** Stable across installations; independent of the local database id. */
  readonly portableId: string;
  readonly type: SemanticType;
  readonly name: string;
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
