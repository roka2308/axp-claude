import { describe, expect, it } from 'vitest';
import { SOLUTION_PACKAGE_LIMITS, type SolutionPackage } from '@axp/contracts';
import { PULSE_PACKAGE } from './catalog/pulse';
import { installOrder, validatePackage } from './package-validation';

/**
 * Gate F6: malicious and invalid package payloads are rejected - before
 * anything is written, and with every reason listed.
 */

const clone = (): SolutionPackage => JSON.parse(JSON.stringify(PULSE_PACKAGE)) as SolutionPackage;
type Loose = Record<string, unknown>;

function keysOf(input: unknown) {
  return validatePackage(input).issues.map((issue) => issue.messageKey);
}

describe('solution package validation', () => {
  it('accepts the Pulse reference package as it ships', () => {
    const result = validatePackage(PULSE_PACKAGE);
    expect(result.issues).toEqual([]);
    expect(result.package?.manifest.packageId).toBe('com.axp.employee-portal-health');
    expect(result.externalReferences).toEqual([]);
  });

  it('accepts the same package as uploaded JSON text', () => {
    expect(validatePackage(JSON.stringify(PULSE_PACKAGE)).issues).toEqual([]);
  });

  it('refuses a field that could carry code, anywhere in the tree', () => {
    const pkg = clone() as unknown as Loose;
    (pkg.definitions as Loose[])[4]!.script = 'fetch("https://evil.example")';
    expect(keysOf(pkg)).toContain('solution.unknown_field');

    const nested = clone() as unknown as { definitions: { body: Loose }[] };
    nested.definitions[4]!.body.ast = { type: 'expression', source: 'process.exit(1)' };
    expect(keysOf(nested)).toContain('solution.invalid_field');
  });

  it('refuses credentials and customer ids, which have no field to live in', () => {
    for (const field of ['token', 'password', 'connectionId', 'siteId', 'users', 'shares']) {
      const pkg = clone() as unknown as Loose;
      (pkg.manifest as Loose)[field] = 'x';
      expect(keysOf(pkg)).toContain('solution.unknown_field');
    }
  });

  it('refuses prototype pollution through __proto__ keys', () => {
    const text = JSON.stringify(PULSE_PACKAGE).replace(
      '"manifest":{',
      '"manifest":{"__proto__":{"polluted":true},',
    );
    expect(keysOf(text)).toContain('solution.unknown_field');
    expect(({} as Loose).polluted).toBeUndefined();
  });

  it('refuses a payload over the size limit before parsing it', () => {
    const text = ' '.repeat(SOLUTION_PACKAGE_LIMITS.maxBytes + 1);
    expect(keysOf(text)).toEqual(['solution.too_large']);
  });

  it('refuses text that is not JSON, and an unknown schema version', () => {
    expect(keysOf('{ not json')).toEqual(['solution.not_json']);
    const pkg = clone() as unknown as { manifest: Loose };
    pkg.manifest.packageSchemaVersion = '2';
    expect(keysOf(pkg)).toContain('solution.unsupported_schema_version');
  });

  it('refuses duplicate portable ids and a dishonest manifest', () => {
    const pkg = clone();
    const duplicated = { ...pkg, definitions: [...pkg.definitions, pkg.definitions[0]!] };
    expect(keysOf(duplicated)).toContain('solution.duplicate_id');

    const understated = clone();
    const manifest = {
      ...understated.manifest,
      includedObjects: understated.manifest.includedObjects.slice(1),
    };
    expect(keysOf({ ...understated, manifest })).toContain('solution.manifest_mismatch');
  });

  it('refuses reference cycles and oversized formulas', () => {
    const pkg = clone();
    const definitions = pkg.definitions.map((definition) =>
      definition.portableId === 'pulse.engagement_rate'
        ? {
            ...definition,
            body: {
              kind: 'formula' as const,
              ast: { type: 'reference' as const, portableId: 'pulse.interaction_index' },
              unit: 'percent' as const,
              scope: 'site' as const,
              direction: 'higher_is_better' as const,
              decimals: 0,
            },
          }
        : definition,
    );
    expect(keysOf({ ...pkg, definitions })).toContain('solution.cycle');

    type Node =
      | { type: 'binary'; op: '+'; left: unknown; right: unknown }
      | { type: 'constant'; value: number };
    let deep: Node = { type: 'constant', value: 1 };
    for (let level = 0; level < 20; level += 1) {
      deep = { type: 'binary', op: '+', left: deep, right: { type: 'constant', value: 1 } };
    }
    const tooDeep = clone();
    const withDeep = tooDeep.definitions.map((definition) =>
      definition.portableId === 'pulse.engagement_rate'
        ? { ...definition, body: { ...definition.body, ast: deep } }
        : definition,
    );
    expect(keysOf({ ...tooDeep, definitions: withDeep })).toContain('solution.formula_too_deep');
  });

  it('refuses a custom metric whose requirement is not declared', () => {
    const pkg = clone();
    expect(keysOf({ ...pkg, requirements: pkg.requirements.slice(1) })).toContain(
      'solution.undeclared_requirement',
    );
  });

  it('refuses overlapping dashboard template widgets', () => {
    const pkg = clone();
    const [first, ...rest] = pkg.dashboardTemplates;
    const widgets = first!.widgets.map((widget, index) =>
      index === 1 ? { ...widget, placement: first!.widgets[0]!.placement } : widget,
    );
    expect(keysOf({ ...pkg, dashboardTemplates: [{ ...first!, widgets }, ...rest] })).toContain(
      'solution.widgets_overlap',
    );
  });

  it('orders definitions so every one follows what it references', () => {
    const order = installOrder(PULSE_PACKAGE.definitions).map(
      (definition) => definition.portableId,
    );
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
    expect(before('pulse.engaged_users', 'pulse.engagement_rate')).toBe(true);
    expect(before('pulse.engagement_rate', 'pulse.interaction_index')).toBe(true);
    expect(before('pulse.interaction_index', 'pulse.health_index')).toBe(true);
    expect(before('pulse.adoption_rate', 'pulse.health_index')).toBe(true);
  });
});
