import { describe, expect, it } from 'vitest';
import {
  type AnalyticsResult,
  type FormulaDefinition,
  type FormulaNode,
  type ScoreDefinition,
  valueEnvelope,
} from '@axp/contracts';
import { applyDerivations, type Derivation } from './derive';

/**
 * Chained derivations, checked against the canonical Pulse case
 * (`06_Canonical_Demo_Data_Pulse_v1.0.md`): a score on a formula on formulas,
 * each step consuming the value the step before it displays.
 */

const ref = (semanticVersionId: string): FormulaNode => ({ type: 'reference', semanticVersionId });
const constant = (value: number): FormulaNode => ({ type: 'constant', value });
const binary = (op: '+' | '-' | '*' | '/', left: FormulaNode, right: FormulaNode): FormulaNode => ({
  type: 'binary',
  op,
  left,
  right,
});

const percentOf = (part: string, whole: string, decimals: number): FormulaDefinition => ({
  kind: 'formula',
  ast: binary('*', binary('/', ref(part), ref(whole)), constant(100)),
  unit: 'percent',
  scope: 'site',
  direction: 'higher_is_better',
  decimals,
});

const interactionIndex: FormulaDefinition = {
  kind: 'formula',
  ast: binary(
    '+',
    binary('*', ref('engagement'), constant(0.8)),
    binary('*', ref('creation'), constant(0.2)),
  ),
  unit: 'ratio',
  scope: 'site',
  direction: 'higher_is_better',
  decimals: 1,
};

const pulse: ScoreDefinition = {
  kind: 'score',
  components: [
    {
      semanticVersionId: 'interaction',
      weight: 0.3,
      normalisation: { kind: 'linear', worst: 0, best: 100 },
    },
    {
      semanticVersionId: 'adoption',
      weight: 0.7,
      normalisation: { kind: 'linear', worst: 0, best: 100 },
    },
  ],
  evaluation: [],
  unit: 'score',
  scope: 'site',
  direction: 'higher_is_better',
  decimals: 2,
};

const derivations: Derivation[] = [
  { semanticVersionId: 'engagement', body: percentOf('engaged', 'active', 0), decimals: 0 },
  { semanticVersionId: 'creation', body: percentOf('creators', 'active', 0), decimals: 0 },
  { semanticVersionId: 'adoption', body: percentOf('active', 'registered', 0), decimals: 0 },
  { semanticVersionId: 'interaction', body: interactionIndex, decimals: 1 },
  { semanticVersionId: 'pulse', body: pulse, decimals: 2 },
];

const leaves = { active: 5000, engaged: 898, creators: 251, registered: 9800 };

function scalar(values: Record<string, number>): AnalyticsResult {
  return {
    kind: 'scalar',
    metrics: Object.entries(values).map(([semanticVersionId, value]) => ({
      semanticVersionId,
      value: valueEnvelope.measured(value),
    })),
    freshness: { fetchedAt: '2026-09-28T00:00:00.000Z', fromCache: false, siteTimezone: 'UTC' },
  };
}

const requested = ['engagement', 'creation', 'adoption', 'interaction', 'pulse'];

describe('chained derivations', () => {
  it('reproduces the canonical Pulse chain: 18 %, 5 %, 51 %, 15.4 and 40.32', () => {
    const result = applyDerivations(scalar(leaves), {
      derivations,
      names: new Map(),
      requested,
    });
    if (result.kind !== 'scalar') throw new Error('expected a scalar result');

    const value = (id: string) => {
      const envelope = result.metrics.find((metric) => metric.semanticVersionId === id)!.value;
      return 'value' in envelope ? envelope.value : envelope.state;
    };
    expect(value('engagement')).toBe(18);
    expect(value('creation')).toBe(5);
    expect(value('adoption')).toBe(51);
    expect(value('interaction')).toBe(15.4);
    expect(value('pulse')).toBe(40.32);
  });

  it('carries an absence up the whole chain instead of computing around it', () => {
    const result = applyDerivations(scalar({ active: 5000, engaged: 898, creators: 251 }), {
      derivations,
      names: new Map(),
      requested,
      placeholders: new Map([
        [
          'registered',
          valueEnvelope.missing({ kind: 'no_mapping', requirement: 'pulse.registered_users' }),
        ],
      ]),
    });
    if (result.kind !== 'scalar') throw new Error('expected a scalar result');

    const state = (id: string) =>
      result.metrics.find((metric) => metric.semanticVersionId === id)!.value.state;
    expect(state('interaction')).toBe('ready');
    expect(state('adoption')).not.toBe('ready');
    expect(state('pulse')).not.toBe('ready');
  });

  it('chains per point in a series as well', () => {
    const series: AnalyticsResult = {
      kind: 'series',
      series: Object.entries(leaves).map(([semanticVersionId, value]) => ({
        semanticVersionId,
        granularity: 'week',
        points: [{ date: '2026-09-21', value: valueEnvelope.measured(value) }],
      })),
      freshness: { fetchedAt: '2026-09-28T00:00:00.000Z', fromCache: false, siteTimezone: 'UTC' },
    };
    const result = applyDerivations(series, {
      derivations,
      names: new Map(),
      requested: ['pulse'],
    });
    if (result.kind !== 'series') throw new Error('expected a series result');
    expect(result.series).toHaveLength(1);
    const point = result.series[0]!.points[0]!.value;
    expect('value' in point ? point.value : point.state).toBe(40.32);
  });
});
