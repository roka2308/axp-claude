import { describe, expect, it } from 'vitest';
import type { SolutionPackage } from '@axp/contracts';
import { PULSE_PACKAGE } from './catalog/pulse';
import { validatePackage } from './package-validation';

/**
 * Adversarial package payloads (Phase 10; ADR 0008).
 *
 * Beyond Gate F6's code and credential fields: inputs built to crash, stall
 * or confuse the validator. Each one is refused with a reason - none may
 * throw, hang, or come back as a valid package.
 */

const clone = (): SolutionPackage => JSON.parse(JSON.stringify(PULSE_PACKAGE)) as SolutionPackage;
type Loose = Record<string, unknown>;

function refused(input: unknown): string[] {
  const started = Date.now();
  const result = validatePackage(input);
  expect(Date.now() - started, 'validation time').toBeLessThan(2_000);
  expect(result.package ?? null, 'no package comes back').toBeNull();
  expect(result.issues.length).toBeGreaterThan(0);
  return result.issues.map((issue) => issue.messageKey);
}

describe('adversarial solution packages', () => {
  it('refuses deep nesting without exhausting the stack', () => {
    const depth = 20_000;
    const text = `{"manifest":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    expect(() => refused(text)).not.toThrow();
  });

  it('refuses constructor and prototype keys, not only __proto__', () => {
    for (const key of ['constructor', 'prototype']) {
      const text = JSON.stringify(PULSE_PACKAGE).replace(
        '"manifest":{',
        `"manifest":{"${key}":{"x":1},`,
      );
      expect(refused(text)).toContain('solution.unknown_field');
    }
    expect(({} as Loose).x).toBeUndefined();
  });

  it('refuses portable ids that only look right', () => {
    for (const id of [
      'com.axp.employee‐portal-health', // U+2010 hyphen
      'com.axp.employee-portal-health​', // zero-width space
      'COM.AXP.EMPLOYEE-PORTAL-HEALTH',
      '../../etc/passwd',
      'com.axp.<script>',
    ]) {
      const pkg = clone() as unknown as { manifest: Loose };
      pkg.manifest.packageId = id;
      expect(refused(pkg), id).not.toEqual([]);
    }
  });

  it('refuses numbers a formula or a score cannot use', () => {
    const text = JSON.stringify(PULSE_PACKAGE);
    for (const [from, to] of [
      ['"decimals":0', '"decimals":1e309'],
      ['"decimals":0', '"decimals":-1'],
      ['"decimals":0', '"decimals":0.5'],
    ] as const) {
      expect(text).toContain(from);
      expect(refused(text.replace(from, to)), to).not.toEqual([]);
    }
  });

  it('refuses oversized strings and too many entries', () => {
    const long = clone() as unknown as { manifest: Loose };
    long.manifest.name = 'x'.repeat(100_000);
    expect(refused(long)).not.toEqual([]);

    const many = clone();
    const first = many.definitions[0]!;
    const definitions = Array.from({ length: 5_000 }, (_, index) => ({
      ...first,
      portableId: `${first.portableId}.copy${index}`,
    }));
    expect(refused({ ...many, definitions })).not.toEqual([]);
  });

  it('refuses a payload of the wrong shape at the top', () => {
    for (const input of [null, 42, 'null', '[]', '"text"', [], { manifest: null }]) {
      expect(() => refused(input)).not.toThrow();
    }
  });

  it('keeps markup in text as text: nothing in a package is ever interpreted', () => {
    const pkg = clone() as unknown as { manifest: Loose };
    pkg.manifest.description = '<img src=x onerror=alert(1)> javascript:alert(1)';
    const result = validatePackage(pkg);
    // Text fields are plain text; the UI renders them as text. What matters
    // here is that no field changes meaning because of what it contains.
    if (result.package) {
      expect(result.package.manifest.description).toBe(pkg.manifest.description);
    }
    expect(JSON.stringify(result)).not.toMatch(/"(script|html|code|expression)"\s*:/);
  });
});
