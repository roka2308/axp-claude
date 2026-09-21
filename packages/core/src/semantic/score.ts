import {
  AppError,
  type EvaluationBand,
  hasNumericValue,
  type ScoreComponent,
  type ScoreDefinition,
  type ScoreNormalisation,
  valueEnvelope,
  type ValueEnvelope,
} from '@axp/contracts';
import type { TraceEntry } from './formula';

/**
 * Score evaluation (Master Spec §14, Gate F3).
 *
 * One rule shapes this file: **a score never hides a missing input by
 * reweighting.** If one component has no value, the score is `not_calculable`
 * and names what was missing. The alternative - renormalising the remaining
 * weights - produces a number that looks like "72 out of 100" while actually
 * meaning "72 out of the parts we happened to measure", and nobody reading a
 * dashboard can tell the difference.
 *
 * That is also why every component is required. Optional components would be
 * declared reweighting, which is still reweighting.
 */

export interface ScoreComponentResult {
  readonly semanticVersionId: string;
  readonly label: string;
  /** The raw measurement, before normalisation. */
  readonly input: ValueEnvelope;
  /** Points on the 0-100 scale, when the input had a value. */
  readonly points: number | null;
  readonly weight: number;
  /** Share of the total the weights add up to. */
  readonly normalisedWeight: number;
}

export interface ScoreEvaluation {
  readonly value: ValueEnvelope;
  readonly components: readonly ScoreComponentResult[];
  /** The band the score falls into, when it has a value and bands exist. */
  readonly band?: EvaluationBand;
  readonly trace: readonly TraceEntry[];
}

export interface ScoreContext {
  readonly values: ReadonlyMap<string, ValueEnvelope>;
  readonly names: ReadonlyMap<string, string>;
}

export function evaluateScore(definition: ScoreDefinition, context: ScoreContext): ScoreEvaluation {
  const totalWeight = definition.components.reduce(
    (sum, component) => sum + Math.max(component.weight, 0),
    0,
  );

  const components: ScoreComponentResult[] = definition.components.map((component) => {
    const input = context.values.get(component.semanticVersionId) ?? missingInput();
    const label =
      component.label ??
      context.names.get(component.semanticVersionId) ??
      component.semanticVersionId;

    return {
      semanticVersionId: component.semanticVersionId,
      label,
      input,
      points: hasNumericValue(input) ? normalise(input.value, component.normalisation) : null,
      weight: component.weight,
      normalisedWeight: totalWeight > 0 ? Math.max(component.weight, 0) / totalWeight : 0,
    };
  });

  const trace: TraceEntry[] = components.map((component) => ({
    label: `${component.label} · ${Math.round(component.normalisedWeight * 100)} %`,
    value: component.points === null ? component.input : valueEnvelope.measured(component.points),
  }));

  // The rule, in one place.
  const missing = components.filter((component) => component.points === null);
  if (missing.length > 0) {
    const value = valueEnvelope.notCalculable(missing.map((component) => component.label));
    return { value, components, trace: [...trace, { label: 'Score', value }] };
  }

  if (totalWeight <= 0) {
    // Weights that sum to nothing cannot express a score. Refusing is honest;
    // dividing by zero and calling the result 0 would not be.
    const value = valueEnvelope.missing({
      kind: 'other',
      messageKey: 'semantic.score.no_weight',
    });
    return { value, components, trace: [...trace, { label: 'Score', value }] };
  }

  const total = components.reduce(
    (sum, component) => sum + component.points! * component.normalisedWeight,
    0,
  );

  const rounded = round(total, definition.decimals);
  const value = valueEnvelope.measured(rounded);
  const band = bandFor(rounded, definition.evaluation);

  return {
    value,
    components,
    ...(band ? { band } : {}),
    trace: [...trace, { label: 'Score', value }],
  };
}

/**
 * Turns a measurement into points on the 0-100 scale.
 *
 * Clamped at both ends: a metric that beats its target does not earn more than
 * 100, because the score is a share of an agreed goal and not a leaderboard.
 */
export function normalise(value: number, normalisation: ScoreNormalisation): number {
  if (normalisation.kind === 'linear') {
    const { worst, best } = normalisation;
    if (worst === best) return value >= best ? 100 : 0;

    // `worst > best` is the lower-is-better case and needs no special handling:
    // the ratio simply runs the other way.
    const share = (value - worst) / (best - worst);
    return clamp(share * 100, 0, 100);
  }

  // Bands: the highest threshold the value reaches decides. Below all of them
  // is zero points rather than an error - the staircase starts at the floor.
  const ordered = [...normalisation.bands].sort((a, b) => a.atLeast - b.atLeast);
  let points = 0;
  for (const band of ordered) {
    if (value >= band.atLeast) points = band.points;
  }
  return clamp(points, 0, 100);
}

/** The evaluation band a score falls into, or undefined when none is defined. */
export function bandFor(
  score: number,
  bands: readonly EvaluationBand[],
): EvaluationBand | undefined {
  const ordered = [...bands].sort((a, b) => a.atLeast - b.atLeast);
  let found: EvaluationBand | undefined;
  for (const band of ordered) {
    if (score >= band.atLeast) found = band;
  }
  return found;
}

/**
 * Refuses a score definition that cannot mean anything.
 *
 * Checked at activation rather than at evaluation: a score whose weights sum
 * to zero, or whose bands overlap, is a definition problem and the person who
 * wrote it should hear about it while they are writing it.
 */
export function validateScore(definition: ScoreDefinition): { messageKey: string }[] {
  const issues: { messageKey: string }[] = [];

  if (definition.components.length === 0) {
    issues.push({ messageKey: 'semantic.score.no_components' });
  }
  if (definition.components.some((component) => component.weight <= 0)) {
    issues.push({ messageKey: 'semantic.score.non_positive_weight' });
  }
  if (definition.components.reduce((sum, component) => sum + component.weight, 0) <= 0) {
    issues.push({ messageKey: 'semantic.score.no_weight' });
  }

  const duplicated = new Set<string>();
  for (const component of definition.components) {
    if (duplicated.has(component.semanticVersionId)) {
      issues.push({ messageKey: 'semantic.score.duplicate_component' });
      break;
    }
    duplicated.add(component.semanticVersionId);
  }

  for (const component of definition.components) {
    if (component.normalisation.kind === 'bands' && component.normalisation.bands.length === 0) {
      issues.push({ messageKey: 'semantic.score.empty_bands' });
      break;
    }
  }

  const thresholds = definition.evaluation.map((band) => band.atLeast);
  if (new Set(thresholds).size !== thresholds.length) {
    issues.push({ messageKey: 'semantic.score.duplicate_band' });
  }

  return issues;
}

export function assertScoreValid(definition: ScoreDefinition): void {
  const issues = validateScore(definition);
  if (issues.length === 0) return;

  throw new AppError('validation_failed', {
    code: 'score_invalid',
    messageKey: issues[0]!.messageKey,
    internalMessage: `Score rejected: ${issues.map((issue) => issue.messageKey).join(', ')}`,
  });
}

/** The version ids a score depends on, for pinning and impact analysis. */
export function scoreComponentVersionIds(definition: ScoreDefinition): string[] {
  return [...new Set(definition.components.map((component) => component.semanticVersionId))];
}

function missingInput(): ValueEnvelope {
  return valueEnvelope.missing({ kind: 'other', messageKey: 'semantic.score.input_missing' });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** Math.max(decimals, 0);
  return Math.round(value * factor) / factor;
}

/** Narrows a body to a score, for callers that already know the type. */
export function isScore(body: { kind: string }): body is ScoreDefinition {
  return body.kind === 'score';
}

export type { ScoreComponent };
