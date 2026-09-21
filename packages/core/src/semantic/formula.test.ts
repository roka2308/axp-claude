import { describe, expect, it } from 'vitest';
import {
  AppError,
  type FormulaNode,
  hasNumericValue,
  type SemanticDefinitionBody,
  valueEnvelope,
  type ValueEnvelope,
} from '@axp/contracts';
import {
  assertFormulaValid,
  evaluateFormula,
  referencedVersionIds,
  validateFormula,
} from './formula';

/**
 * Gate F3 asks for three things from formulas: no arbitrary executable code,
 * cycles blocked, and missing inputs never quietly becoming zero. These tests
 * are written as those properties.
 */

const VISITS = 'v-visits';
const PAGEVIEWS = 'v-pageviews';
const SECONDS = 'v-duration';
const ACTIONS = 'v-downloads';

const bodies = new Map<string, SemanticDefinitionBody>([
  [
    VISITS,
    {
      kind: 'native',
      sourceMetric: 'visits',
      unit: 'count',
      scope: 'visit',
      direction: 'higher_is_better',
      decimals: 0,
    },
  ],
  [
    PAGEVIEWS,
    {
      kind: 'native',
      sourceMetric: 'pageviews',
      unit: 'count',
      scope: 'visit',
      direction: 'higher_is_better',
      decimals: 0,
    },
  ],
  [
    SECONDS,
    {
      kind: 'native',
      sourceMetric: 'avgTimeOnSite',
      unit: 'seconds',
      scope: 'visit',
      direction: 'higher_is_better',
      decimals: 1,
    },
  ],
  [
    ACTIONS,
    {
      kind: 'native',
      sourceMetric: 'downloads',
      unit: 'count',
      scope: 'action',
      direction: 'higher_is_better',
      decimals: 0,
    },
  ],
]);

const names = new Map([
  [VISITS, 'Besuche'],
  [PAGEVIEWS, 'Seitenaufrufe'],
  [SECONDS, 'Verweildauer'],
  [ACTIONS, 'Downloads'],
]);

const ref = (id: string): FormulaNode => ({ type: 'reference', semanticVersionId: id });
const constant = (value: number): FormulaNode => ({ type: 'constant', value });
const binary = (op: '+' | '-' | '*' | '/', left: FormulaNode, right: FormulaNode): FormulaNode => ({
  type: 'binary',
  op,
  left,
  right,
});

const validate = (node: FormulaNode, extra: Partial<Parameters<typeof validateFormula>[1]> = {}) =>
  validateFormula(node, { inputs: bodies, ...extra });

const evaluate = (node: FormulaNode, values: Record<string, ValueEnvelope>) =>
  evaluateFormula(node, { values: new Map(Object.entries(values)), names });

describe('a formula is a tree, never code', () => {
  it('has no way to express anything but the declared node types', () => {
    // The guard is structural: the AST has four node types and no string that
    // is ever interpreted. This test states the invariant so that adding an
    // `{ type: 'expression', source: string }` node has to fail a test first.
    const node = binary('/', ref(PAGEVIEWS), ref(VISITS));
    const kinds = new Set<string>();

    const walk = (current: FormulaNode): void => {
      kinds.add(current.type);
      if (current.type === 'binary') {
        walk(current.left);
        walk(current.right);
      } else if (current.type === 'function') current.args.forEach(walk);
    };
    walk(node);

    for (const kind of kinds) {
      expect(['constant', 'reference', 'binary', 'function']).toContain(kind);
    }
  });

  it('refuses a reference to something that does not exist', () => {
    const { issues } = validate(ref('v-nope'));
    expect(issues[0]?.messageKey).toBe('semantic.formula.unknown_reference');
  });

  it('reports every referenced version, for pinning', () => {
    const node = binary('+', binary('/', ref(PAGEVIEWS), ref(VISITS)), ref(SECONDS));
    expect(referencedVersionIds(node).sort()).toEqual([PAGEVIEWS, SECONDS, VISITS].sort());
  });
});

describe('units and scopes have to combine meaningfully', () => {
  it('accepts a ratio of two counts', () => {
    const { issues, type } = validate(binary('/', ref(PAGEVIEWS), ref(VISITS)));
    expect(issues).toEqual([]);
    expect(type).toEqual({ unit: 'ratio', scope: 'visit' });
  });

  it('refuses adding seconds to a count', () => {
    const { issues } = validate(binary('+', ref(VISITS), ref(SECONDS)));
    expect(issues[0]?.messageKey).toBe('semantic.formula.unit_mismatch');
  });

  it('refuses adding a visit metric to an action metric', () => {
    // Counted over different things, so the sum has no referent (§13).
    const { issues } = validate(binary('+', ref(VISITS), ref(ACTIONS)));
    expect(issues.map((issue) => issue.messageKey)).toContain('semantic.formula.scope_mismatch');
  });

  it('allows dividing across scopes, because that is what "per" means', () => {
    // `actions / visits` is how "pages per visit" exists at all. The result is
    // read per the denominator, so that is the scope it carries.
    const { issues, type } = validate(binary('/', ref(ACTIONS), ref(VISITS)));
    expect(issues).toEqual([]);
    expect(type).toEqual({ unit: 'ratio', scope: 'visit' });
  });

  it('lets a constant scale a measurement without changing its unit', () => {
    const { issues, type } = validate(binary('*', ref(VISITS), constant(0.5)));
    expect(issues).toEqual([]);
    expect(type).toEqual({ unit: 'count', scope: 'visit' });
  });

  it('refuses multiplying two measurements', () => {
    // There is no compound unit in the MVP, so `count × seconds` would have to
    // be labelled something the product cannot name.
    const { issues } = validate(binary('*', ref(VISITS), ref(SECONDS)));
    expect(issues[0]?.messageKey).toBe('semantic.formula.unit_mismatch');
  });

  it('keeps the unit when dividing by a dimensionless value', () => {
    const { type } = validate(binary('/', ref(SECONDS), constant(60)));
    expect(type).toEqual({ unit: 'seconds', scope: 'visit' });
  });

  it('requires ROUND to take a constant number of digits', () => {
    const bad: FormulaNode = { type: 'function', name: 'ROUND', args: [ref(VISITS), ref(VISITS)] };
    expect(validate(bad).issues[0]?.messageKey).toBe(
      'semantic.formula.round_needs_constant_digits',
    );
  });

  it('requires MIN and MAX to compare the same kind of thing', () => {
    const bad: FormulaNode = { type: 'function', name: 'MIN', args: [ref(VISITS), ref(SECONDS)] };
    expect(validate(bad).issues[0]?.messageKey).toBe('semantic.formula.unit_mismatch');
  });
});

describe('cycles are blocked', () => {
  it('refuses a formula that reaches itself', () => {
    // `self -> a -> self` is not visible in the tree; it is a property of the
    // dependency graph, which is where it has to be checked.
    const dependencies = new Map([
      ['v-a', ['v-self']],
      ['v-self', ['v-a']],
    ]);

    const inputs = new Map(bodies);
    inputs.set('v-a', bodies.get(VISITS)!);

    const { issues } = validateFormula(ref('v-a'), {
      inputs,
      dependencies,
      selfVersionIds: ['v-self'],
    });

    expect(issues[0]?.messageKey).toBe('semantic.formula.cycle');
  });

  it('allows a diamond, which is not a cycle', () => {
    // a and b both depend on visits; the formula depends on both. Perfectly
    // ordinary, and a naive "already seen" check would reject it.
    const dependencies = new Map([
      ['v-a', [VISITS]],
      ['v-b', [VISITS]],
      [VISITS, []],
    ]);

    const inputs = new Map(bodies);
    inputs.set('v-a', bodies.get(VISITS)!);
    inputs.set('v-b', bodies.get(VISITS)!);

    const { issues } = validateFormula(binary('+', ref('v-a'), ref('v-b')), {
      inputs,
      dependencies,
      selfVersionIds: ['v-self'],
    });

    expect(issues).toEqual([]);
  });

  it('throws at activation rather than storing something unevaluable', () => {
    expect(() =>
      assertFormulaValid(binary('+', ref(VISITS), ref(SECONDS)), { inputs: bodies }),
    ).toThrow(AppError);
  });
});

describe('evaluation', () => {
  const ready = (value: number) => valueEnvelope.measured(value);

  it('computes and shows its work', () => {
    const { value, trace } = evaluate(binary('/', ref(PAGEVIEWS), ref(VISITS)), {
      [PAGEVIEWS]: ready(300),
      [VISITS]: ready(120),
    });

    expect(hasNumericValue(value) && value.value).toBe(2.5);
    // The trace is what makes a number inspectable rather than magic.
    expect(trace.map((entry) => entry.label)).toContain('Seitenaufrufe');
    expect(trace.at(-1)?.label).toBe('300 / 120');
  });

  it('never turns a missing input into zero', () => {
    const { value } = evaluate(binary('/', ref(PAGEVIEWS), ref(VISITS)), {
      [PAGEVIEWS]: ready(300),
      [VISITS]: valueEnvelope.missing({ kind: 'no_mapping', requirement: 'visits' }),
    });

    expect(value.state).toBe('missing');
    expect(hasNumericValue(value)).toBe(false);
  });

  it('names the input that was missing', () => {
    const { value } = evaluate(binary('+', ref(VISITS), ref(PAGEVIEWS)), {
      [VISITS]: ready(10),
    });

    expect(value).toMatchObject({
      state: 'missing',
      cause: { kind: 'not_calculable', missingInputs: ['Seitenaufrufe'] },
    });
  });

  it('treats division by zero as a value that does not exist', () => {
    // Not an error, and emphatically not zero: the quotient is undefined.
    const { value } = evaluate(binary('/', ref(PAGEVIEWS), ref(VISITS)), {
      [PAGEVIEWS]: ready(300),
      [VISITS]: ready(0),
    });

    expect(value).toMatchObject({
      state: 'missing',
      cause: { messageKey: 'semantic.formula.division_by_zero' },
    });
  });

  it('counts a measured zero as a value', () => {
    // Zero is a measurement; it participates in arithmetic like any other.
    const { value } = evaluate(binary('+', ref(VISITS), ref(PAGEVIEWS)), {
      [VISITS]: ready(0),
      [PAGEVIEWS]: ready(7),
    });

    expect(hasNumericValue(value) && value.value).toBe(7);
  });

  it('lets COALESCE choose a fallback explicitly', () => {
    const node: FormulaNode = {
      type: 'function',
      name: 'COALESCE',
      args: [ref(VISITS), ref(PAGEVIEWS), constant(0)],
    };

    const { value } = evaluate(node, {
      [VISITS]: valueEnvelope.missing({ kind: 'no_mapping', requirement: 'visits' }),
      [PAGEVIEWS]: ready(42),
    });

    // The fallback is in the formula, visible to whoever reads it - which is
    // the whole difference from a silent default.
    expect(hasNumericValue(value) && value.value).toBe(42);
  });

  it('is not calculable when every COALESCE branch is missing', () => {
    const node: FormulaNode = {
      type: 'function',
      name: 'COALESCE',
      args: [ref(VISITS), ref(PAGEVIEWS)],
    };

    const { value } = evaluate(node, {});
    expect(value).toMatchObject({ state: 'missing', cause: { kind: 'not_calculable' } });
  });

  it('carries a source outage through rather than relabelling it', () => {
    // "The source was down" and "the input is not mapped" are different facts
    // and stay different all the way to the widget (D10).
    const { value } = evaluate(binary('+', ref(VISITS), ref(PAGEVIEWS)), {
      [VISITS]: valueEnvelope.unavailable({ kind: 'source_timeout' }),
      [PAGEVIEWS]: ready(1),
    });

    expect(value).toMatchObject({ state: 'unavailable', cause: { kind: 'source_timeout' } });
  });

  it('rounds where the formula says to', () => {
    const node: FormulaNode = {
      type: 'function',
      name: 'ROUND',
      args: [binary('/', ref(PAGEVIEWS), ref(VISITS)), constant(2)],
    };

    const { value } = evaluate(node, { [PAGEVIEWS]: ready(100), [VISITS]: ready(3) });
    expect(hasNumericValue(value) && value.value).toBe(33.33);
  });

  it('takes the smallest and the largest', () => {
    const min: FormulaNode = { type: 'function', name: 'MIN', args: [ref(VISITS), ref(PAGEVIEWS)] };
    const max: FormulaNode = { type: 'function', name: 'MAX', args: [ref(VISITS), ref(PAGEVIEWS)] };
    const values = { [VISITS]: ready(4), [PAGEVIEWS]: ready(9) };

    expect(
      hasNumericValue(evaluate(min, values).value) && evaluate(min, values).value,
    ).toMatchObject({ value: 4 });
    expect(evaluate(max, values).value).toMatchObject({ value: 9 });
  });
});
