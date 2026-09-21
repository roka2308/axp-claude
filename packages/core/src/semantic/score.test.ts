import { describe, expect, it } from 'vitest';
import {
  AppError,
  hasNumericValue,
  type ScoreDefinition,
  valueEnvelope,
  type ValueEnvelope,
} from '@axp/contracts';
import { assertScoreValid, bandFor, evaluateScore, normalise, validateScore } from './score';

/**
 * The Gate F3 criterion this file exists for: a score never hides missing
 * inputs by reweighting. Everything else here is in service of making that one
 * demonstrable.
 */

const ENGAGEMENT = 'v-engagement';
const CREATION = 'v-creation';
const ADOPTION = 'v-adoption';

const names = new Map([
  [ENGAGEMENT, 'Engagement Rate'],
  [CREATION, 'Creation Rate'],
  [ADOPTION, 'Adoption Rate'],
]);

function score(overrides: Partial<ScoreDefinition> = {}): ScoreDefinition {
  return {
    kind: 'score',
    unit: 'score',
    scope: 'visit',
    direction: 'higher_is_better',
    decimals: 1,
    components: [
      {
        semanticVersionId: ENGAGEMENT,
        weight: 50,
        normalisation: { kind: 'linear', worst: 0, best: 100 },
      },
      {
        semanticVersionId: CREATION,
        weight: 30,
        normalisation: { kind: 'linear', worst: 0, best: 50 },
      },
      {
        semanticVersionId: ADOPTION,
        weight: 20,
        normalisation: { kind: 'linear', worst: 0, best: 100 },
      },
    ],
    evaluation: [
      { key: 'critical', atLeast: 0, band: 1 },
      { key: 'weak', atLeast: 40, band: 2 },
      { key: 'fair', atLeast: 60, band: 3 },
      { key: 'good', atLeast: 75, band: 4 },
      { key: 'excellent', atLeast: 90, band: 5 },
    ],
    ...overrides,
  };
}

const evaluate = (definition: ScoreDefinition, values: Record<string, ValueEnvelope>) =>
  evaluateScore(definition, { values: new Map(Object.entries(values)), names });

const ready = (value: number) => valueEnvelope.measured(value);

describe('a missing input is never reweighted away', () => {
  it('refuses to produce a number when one component has no value', () => {
    const { value } = evaluate(score(), {
      [ENGAGEMENT]: ready(80),
      [CREATION]: ready(25),
      // Adoption is absent.
    });

    // Not 80×0.625 + 50×0.375. A score computed from part of its definition
    // looks exactly like a score computed from all of it, and a reader cannot
    // tell them apart - which is why this refuses.
    expect(hasNumericValue(value)).toBe(false);
    expect(value).toMatchObject({ state: 'missing', cause: { kind: 'not_calculable' } });
  });

  it('names what was missing, so it can be fixed', () => {
    const { value } = evaluate(score(), { [ENGAGEMENT]: ready(80) });

    expect(value).toMatchObject({
      cause: { kind: 'not_calculable', missingInputs: ['Creation Rate', 'Adoption Rate'] },
    });
  });

  it('still reports the components that did have values', () => {
    // The score is not calculable, but the person fixing it should see how far
    // it got rather than a blank.
    const { components } = evaluate(score(), { [ENGAGEMENT]: ready(80) });

    expect(components).toHaveLength(3);
    expect(components[0]).toMatchObject({ label: 'Engagement Rate', points: 80 });
    expect(components[1]).toMatchObject({ label: 'Creation Rate', points: null });
  });

  it('keeps the declared weights rather than renormalising the survivors', () => {
    const { components } = evaluate(score(), { [ENGAGEMENT]: ready(80) });

    // 50/30/20 of the declared total, regardless of what is missing.
    expect(components.map((component) => Math.round(component.normalisedWeight * 100))).toEqual([
      50, 30, 20,
    ]);
  });
});

describe('a complete score', () => {
  it('is the weighted sum of its normalised components', () => {
    const { value } = evaluate(score(), {
      [ENGAGEMENT]: ready(80), // 80 points × 0.5 = 40
      [CREATION]: ready(25), // 50 points × 0.3 = 15
      [ADOPTION]: ready(60), // 60 points × 0.2 = 12
    });

    expect(value).toMatchObject({ state: 'ready', value: 67 });
  });

  it('lands in the band its number falls into', () => {
    const { band } = evaluate(score(), {
      [ENGAGEMENT]: ready(80),
      [CREATION]: ready(25),
      [ADOPTION]: ready(60),
    });

    expect(band).toMatchObject({ key: 'fair', band: 3 });
  });

  it('counts a measured zero as a real component value', () => {
    // Zero engagement is a fact about the site, not an absence of data.
    const { value } = evaluate(score(), {
      [ENGAGEMENT]: ready(0),
      [CREATION]: ready(50),
      [ADOPTION]: ready(100),
    });

    expect(value).toMatchObject({ state: 'ready', value: 50 });
  });

  it('explains itself component by component', () => {
    const { trace } = evaluate(score(), {
      [ENGAGEMENT]: ready(80),
      [CREATION]: ready(25),
      [ADOPTION]: ready(60),
    });

    expect(trace.map((entry) => entry.label)).toEqual([
      'Engagement Rate · 50 %',
      'Creation Rate · 30 %',
      'Adoption Rate · 20 %',
      'Score',
    ]);
  });
});

describe('normalisation', () => {
  it('maps a measurement onto the 0-100 scale linearly', () => {
    expect(normalise(25, { kind: 'linear', worst: 0, best: 50 })).toBe(50);
    expect(normalise(0, { kind: 'linear', worst: 0, best: 50 })).toBe(0);
  });

  it('clamps rather than rewarding overachievement', () => {
    // A score is a share of an agreed goal, not a leaderboard.
    expect(normalise(500, { kind: 'linear', worst: 0, best: 50 })).toBe(100);
    expect(normalise(-20, { kind: 'linear', worst: 0, best: 50 })).toBe(0);
  });

  it('runs the other way when lower is better', () => {
    // Bounce rate: 20 % is excellent, 80 % is not. Expressed by putting the
    // worse value at `worst`, with no special case in the code.
    const bounce = { kind: 'linear', worst: 80, best: 20 } as const;
    expect(normalise(20, bounce)).toBe(100);
    expect(normalise(80, bounce)).toBe(0);
    expect(normalise(50, bounce)).toBe(50);
  });

  it('uses the highest band a value reaches', () => {
    const bands = {
      kind: 'bands',
      bands: [
        { atLeast: 0, points: 0 },
        { atLeast: 10, points: 40 },
        { atLeast: 25, points: 80 },
        { atLeast: 50, points: 100 },
      ],
    } as const;

    expect(normalise(9, bands)).toBe(0);
    expect(normalise(10, bands)).toBe(40);
    expect(normalise(30, bands)).toBe(80);
    expect(normalise(1000, bands)).toBe(100);
  });

  it('handles a degenerate linear range without dividing by zero', () => {
    expect(normalise(5, { kind: 'linear', worst: 5, best: 5 })).toBe(100);
    expect(normalise(4, { kind: 'linear', worst: 5, best: 5 })).toBe(0);
  });
});

describe('evaluation bands', () => {
  const bands = score().evaluation;

  it('picks the highest threshold the score reaches', () => {
    expect(bandFor(0, bands)).toMatchObject({ key: 'critical' });
    expect(bandFor(59.9, bands)).toMatchObject({ key: 'weak' });
    expect(bandFor(90, bands)).toMatchObject({ key: 'excellent' });
  });

  it('returns nothing when a score carries no interpretation', () => {
    // A score without bands is a number, and the product does not invent a
    // judgement for it.
    expect(bandFor(50, [])).toBeUndefined();
  });
});

describe('a score definition has to be able to mean something', () => {
  it('refuses a score with no components', () => {
    expect(validateScore(score({ components: [] })).map((issue) => issue.messageKey)).toContain(
      'semantic.score.no_components',
    );
  });

  it('refuses weights that cannot express a share', () => {
    const zeroed = score({
      components: score().components.map((component) => ({ ...component, weight: 0 })),
    });
    expect(validateScore(zeroed).map((issue) => issue.messageKey)).toContain(
      'semantic.score.non_positive_weight',
    );
  });

  it('refuses the same metric twice', () => {
    const duplicated = score({
      components: [score().components[0]!, score().components[0]!],
    });
    expect(validateScore(duplicated).map((issue) => issue.messageKey)).toContain(
      'semantic.score.duplicate_component',
    );
  });

  it('refuses two bands starting at the same number', () => {
    const overlapping = score({
      evaluation: [
        { key: 'a', atLeast: 50, band: 2 },
        { key: 'b', atLeast: 50, band: 3 },
      ],
    });
    expect(validateScore(overlapping).map((issue) => issue.messageKey)).toContain(
      'semantic.score.duplicate_band',
    );
  });

  it('accepts the reference definition', () => {
    expect(validateScore(score())).toEqual([]);
    expect(() => assertScoreValid(score())).not.toThrow();
  });

  it('throws at activation rather than storing something unevaluable', () => {
    expect(() => assertScoreValid(score({ components: [] }))).toThrow(AppError);
  });
});
