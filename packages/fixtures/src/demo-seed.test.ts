import { describe, expect, it } from 'vitest';
import { computeReferencePulse, loadDemoSeed } from './demo-seed';

/**
 * The canonical fixture is shared with the Emergent track. If these numbers
 * drift, the cross-track comparison stops comparing like with like
 * (`06_Canonical_Demo_Data_Pulse_v1.0.md`).
 */
describe('canonical demo seed', () => {
  it('carries the agreed tenant, project and site', () => {
    const seed = loadDemoSeed();
    expect(seed.tenant.slug).toBe('corp-comms-demo');
    expect(seed.project.slug).toBe('employee-portal');
    expect(seed.project.timezone).toBe('Europe/Berlin');
    expect(seed.site.name).toBe('Employee Portal Demo Site');
  });

  it('defines the five canonical accounts with their scoped roles', () => {
    const seed = loadDemoSeed();
    expect(seed.users).toHaveLength(5);

    const byKey = Object.fromEntries(seed.users.map((user) => [user.key, user]));
    expect(byKey.viewer!.roles).toEqual([{ role: 'viewer', scope: 'project' }]);
    expect(byKey.tenantAdmin!.roles).toEqual([{ role: 'tenant_admin', scope: 'tenant' }]);
    expect(byKey.platformAdmin!.roles).toEqual([{ role: 'platform_admin', scope: 'platform' }]);
  });

  it('reproduces the reference Pulse chain from the raw inputs', () => {
    const seed = loadDemoSeed();
    const computed = computeReferencePulse(seed);
    const reference = seed.pulse.referenceDisplayedValues;

    expect(computed.engagementRateDisplay).toBe(reference.engagementRatePercent);
    expect(computed.creationRateDisplay).toBe(reference.creationRatePercent);
    expect(computed.adoptionRateDisplay).toBe(reference.adoptionRatePercent);
    expect(computed.interactionIndex).toBe(reference.interactionIndex);
    expect(computed.pulseScore).toBe(reference.pulseScore);
  });

  it('keeps the exact values the specification names', () => {
    const computed = computeReferencePulse();
    expect(computed.interactionIndex).toBe(15.4);
    expect(computed.pulseScore).toBe(40.32);
  });

  it('keeps full precision available alongside the rounded display values', () => {
    // Display rounding is explicit, not incidental: the engine may compute at
    // higher precision, and the reference chain rounds before weighting.
    const computed = computeReferencePulse();
    expect(computed.engagementRateExact).toBeCloseTo(17.96, 2);
    expect(computed.adoptionRateExact).toBeCloseTo(51.0204, 4);
  });
});
