import { describe, expect, it } from 'vitest';
import { hasNumericValue, valueEnvelope, type ValueEnvelope } from './states';

/**
 * These tests guard the invariant that blocks MVP acceptance if broken:
 * "missing/unknown/unavailable is never silently rendered as numeric zero"
 * (acceptance checklist A).
 */
describe('valueEnvelope', () => {
  it('reports a measured zero as its own state, not as missing', () => {
    const result = valueEnvelope.measured(0);
    expect(result.state).toBe('zero');
    expect(hasNumericValue(result)).toBe(true);
  });

  it('reports a measured non-zero value as ready', () => {
    const result = valueEnvelope.measured(898);
    expect(result).toEqual({ state: 'ready', value: 898 });
  });

  it('refuses to coerce a non-finite number into a value', () => {
    // The caller has to pick an explicit absence state; guessing here is what
    // produces "missing shown as 0" bugs.
    expect(() => valueEnvelope.measured(Number.NaN)).toThrow(TypeError);
    expect(() => valueEnvelope.measured(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('keeps absence states free of a numeric value', () => {
    const absences: ValueEnvelope[] = [
      valueEnvelope.missing({ kind: 'no_mapping', requirement: 'pulse.active_users' }),
      valueEnvelope.unknown(),
      valueEnvelope.notApplicable(),
      valueEnvelope.notTracked(),
      valueEnvelope.unavailable({ kind: 'source_timeout' }),
      valueEnvelope.empty(),
      valueEnvelope.loading(),
    ];

    for (const absence of absences) {
      expect(hasNumericValue(absence)).toBe(false);
      expect(absence).not.toHaveProperty('value');
    }
  });

  it('models a score with missing inputs as not_calculable, never as zero', () => {
    const result = valueEnvelope.notCalculable(['pulse.engaged_users']);
    expect(result.state).toBe('missing');
    expect(result).toMatchObject({
      cause: { kind: 'not_calculable', missingInputs: ['pulse.engaged_users'] },
    });
    expect(hasNumericValue(result)).toBe(false);
  });

  it('keeps a value alongside a warning so it can still be displayed', () => {
    const result = valueEnvelope.warning(42, [
      { severity: 'warning', messageKey: 'dq.partial_period' },
    ]);
    expect(hasNumericValue(result)).toBe(true);
    expect(result).toMatchObject({ state: 'warning', value: 42 });
  });
});
