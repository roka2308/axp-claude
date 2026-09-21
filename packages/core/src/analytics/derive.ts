import {
  type AnalyticsResult,
  type BreakdownRow,
  type FormulaDefinition,
  type MetricValue,
  type ScoreDefinition,
  type TimeSeries,
  type TimeSeriesPoint,
  type ValueEnvelope,
} from '@axp/contracts';
import { evaluateFormula, type TraceEntry } from '../semantic/formula';
import { evaluateScore } from '../semantic/score';

/**
 * Derived metrics (Master Spec §13).
 *
 * Matomo answers questions about native metrics. Formulas and scores are
 * computed here, from those answers, after they arrive - which is what keeps
 * the connector free of business logic and keeps a formula identical whichever
 * adapter served its inputs.
 *
 * Derivation happens per data point, not once over a total: a ratio of two
 * sums is not the sum of the ratios, and a chart of a formula has to be the
 * formula evaluated at each point.
 */

export interface Derivation {
  readonly semanticVersionId: string;
  readonly body: FormulaDefinition | ScoreDefinition;
  readonly decimals: number;
}

export interface DerivationContext {
  readonly derivations: readonly Derivation[];
  /** Display names of every version involved, for traces and explanations. */
  readonly names: ReadonlyMap<string, string>;
  /** The version ids the caller actually asked for, in order. */
  readonly requested: readonly string[];
}

/**
 * Computes derived metrics and returns the result the caller asked for.
 *
 * Leaf metrics that were only fetched to feed a formula are dropped: the
 * caller asked for "Engagement Rate", not for the two counts behind it.
 */
export function applyDerivations(
  result: AnalyticsResult,
  context: DerivationContext,
): AnalyticsResult {
  if (context.derivations.length === 0) return selectRequested(result, context.requested);

  switch (result.kind) {
    case 'scalar':
      return selectRequested(
        { ...result, metrics: deriveMetrics(result.metrics, context) },
        context.requested,
      );

    case 'series':
      return selectRequested(
        { ...result, series: deriveSeries(result.series, context) },
        context.requested,
      );

    case 'breakdown':
      return selectRequested(
        {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metrics: deriveMetrics(row.metrics, context),
          })) satisfies BreakdownRow[],
        },
        context.requested,
      );
  }
}

/** One derived value per derivation, appended to the leaves it was built from. */
function deriveMetrics(metrics: readonly MetricValue[], context: DerivationContext): MetricValue[] {
  const values = new Map(metrics.map((metric) => [metric.semanticVersionId, metric.value]));
  const comparisons = new Map(
    metrics
      .filter((metric) => metric.comparison)
      .map((metric) => [metric.semanticVersionId, metric.comparison!.value]),
  );

  const derived = context.derivations.map((derivation) => {
    const value = evaluate(derivation, values, context.names).value;

    // The comparison is the same formula over the comparison period, not a
    // comparison of the formula against itself.
    const comparisonValue =
      comparisons.size > 0 ? evaluate(derivation, comparisons, context.names).value : null;

    return {
      semanticVersionId: derivation.semanticVersionId,
      value,
      ...(comparisonValue ? { comparison: compare(value, comparisonValue) } : {}),
    } satisfies MetricValue;
  });

  return [...metrics, ...derived];
}

function deriveSeries(series: readonly TimeSeries[], context: DerivationContext): TimeSeries[] {
  const first = series[0];
  if (!first) return [...series];

  const derived = context.derivations.map((derivation) => {
    const points = first.points.map((point, index) =>
      derivePoint(derivation, series, index, point.date, context, false),
    );

    const comparisonPoints = first.comparisonPoints
      ? first.comparisonPoints.map((point, index) =>
          derivePoint(derivation, series, index, point.date, context, true),
        )
      : undefined;

    return {
      semanticVersionId: derivation.semanticVersionId,
      granularity: first.granularity,
      points,
      ...(comparisonPoints ? { comparisonPoints } : {}),
    } satisfies TimeSeries;
  });

  return [...series, ...derived];
}

/** Evaluates one derivation at one position of every input series. */
function derivePoint(
  derivation: Derivation,
  series: readonly TimeSeries[],
  index: number,
  date: string,
  context: DerivationContext,
  comparison: boolean,
): TimeSeriesPoint {
  const values = new Map<string, ValueEnvelope>();
  for (const input of series) {
    const points = comparison ? input.comparisonPoints : input.points;
    const point = points?.[index];
    if (point) values.set(input.semanticVersionId, point.value);
  }

  return { date, value: evaluate(derivation, values, context.names).value };
}

function evaluate(
  derivation: Derivation,
  values: ReadonlyMap<string, ValueEnvelope>,
  names: ReadonlyMap<string, string>,
): { value: ValueEnvelope; trace: readonly TraceEntry[] } {
  if (derivation.body.kind === 'score') {
    const evaluated = evaluateScore(derivation.body, { values, names });
    return { value: evaluated.value, trace: evaluated.trace };
  }

  return evaluateFormula(derivation.body.ast, { values, names });
}

/**
 * Change against the comparison period.
 *
 * Mirrors what the connector produces for native metrics, so a formula and a
 * native metric present their comparison identically. A zero baseline is
 * flagged rather than turned into an infinite percentage.
 */
function compare(value: ValueEnvelope, baseline: ValueEnvelope) {
  const current = numberOf(value);
  const previous = numberOf(baseline);

  if (current === null || previous === null) return { value: baseline };
  if (previous === 0) return { value: baseline, change: current, baselineZero: true };

  return {
    value: baseline,
    change: current - previous,
    changeRatio: (current - previous) / previous,
  };
}

function numberOf(envelope: ValueEnvelope): number | null {
  return envelope.state === 'ready' || envelope.state === 'zero' || envelope.state === 'warning'
    ? envelope.value
    : null;
}

/**
 * Keeps only what was asked for, in the order it was asked for.
 *
 * A widget showing one formula must not suddenly render the three inputs that
 * happened to be fetched for it.
 */
function selectRequested(result: AnalyticsResult, requested: readonly string[]): AnalyticsResult {
  const order = (id: string) => {
    const index = requested.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const keep = (id: string) => requested.includes(id);

  switch (result.kind) {
    case 'scalar':
      return {
        ...result,
        metrics: result.metrics
          .filter((metric) => keep(metric.semanticVersionId))
          .sort((a, b) => order(a.semanticVersionId) - order(b.semanticVersionId)),
      };

    case 'series':
      return {
        ...result,
        series: result.series
          .filter((entry) => keep(entry.semanticVersionId))
          .sort((a, b) => order(a.semanticVersionId) - order(b.semanticVersionId)),
      };

    case 'breakdown':
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          metrics: row.metrics
            .filter((metric) => keep(metric.semanticVersionId))
            .sort((a, b) => order(a.semanticVersionId) - order(b.semanticVersionId)),
        })),
      };
  }
}
