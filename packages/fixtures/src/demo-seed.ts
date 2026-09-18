import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale, ScopeType, SystemRole } from '@axp/contracts';

/**
 * Canonical demo fixture (`06_Canonical_Demo_Data_Pulse_v1.0.md`).
 *
 * Shape mirrors the handoff JSON exactly. The Pulse block is carried through
 * unchanged even though Phase 0 does not apply it yet: the semantic catalog and
 * the reference solution arrive in Phase 3 and Phase 6, and the values must not
 * drift in the meantime.
 */
export interface DemoSeed {
  readonly schemaVersion: string;
  readonly tenant: {
    readonly portableId: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
  };
  readonly project: {
    readonly portableId: string;
    readonly name: string;
    readonly slug: string;
    readonly timezone: string;
    readonly locale: Locale;
  };
  readonly site: {
    readonly portableId: string;
    readonly name: string;
    readonly timezone: string;
  };
  readonly users: readonly {
    readonly key: string;
    readonly email: string;
    readonly roles: readonly { readonly role: SystemRole; readonly scope: ScopeType }[];
  }[];
  readonly pulse: {
    readonly periodLabel: string;
    readonly inputs: Readonly<Record<string, number>>;
    readonly referenceDisplayedValues: Readonly<Record<string, number>>;
    readonly weights: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly portableIds: Readonly<Record<string, string>>;
  };
}

/** Display names for the seeded accounts; the handoff fixture lists only emails. */
export const DEMO_USER_NAMES: Readonly<Record<string, { firstName: string; lastName: string }>> = {
  viewer: { firstName: 'Vera', lastName: 'Viewer' },
  editor: { firstName: 'Erik', lastName: 'Editor' },
  semantic: { firstName: 'Sara', lastName: 'Semantik' },
  tenantAdmin: { firstName: 'Tom', lastName: 'Tenantadmin' },
  platformAdmin: { firstName: 'Petra', lastName: 'Plattform' },
};

let cached: DemoSeed | undefined;

export function loadDemoSeed(): DemoSeed {
  if (cached) return cached;
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../data/demo_seed.json',
  );
  cached = JSON.parse(readFileSync(file, 'utf8')) as DemoSeed;
  return cached;
}

/**
 * Recomputes the Pulse chain from the canonical inputs.
 *
 * Kept here so a test can assert that the implementation reproduces the
 * reference numbers. The reference chain rounds each rate to whole percent
 * before weighting - that is how 40.32 arises - so the rounding is explicit
 * rather than incidental (`06_Canonical_Demo_Data_Pulse_v1.0.md`).
 */
export function computeReferencePulse(seed: DemoSeed = loadDemoSeed()) {
  const { activeUsers, engagedUsers, contentCreators, registeredUsers } = seed.pulse.inputs as {
    activeUsers: number;
    engagedUsers: number;
    contentCreators: number;
    registeredUsers: number;
  };

  const engagementRateExact = (engagedUsers / activeUsers) * 100;
  const creationRateExact = (contentCreators / activeUsers) * 100;
  const adoptionRateExact = (activeUsers / registeredUsers) * 100;

  const engagementRateDisplay = Math.round(engagementRateExact);
  const creationRateDisplay = Math.round(creationRateExact);
  const adoptionRateDisplay = Math.round(adoptionRateExact);

  const interactionWeights = seed.pulse.weights.interactionIndex!;
  const pulseWeights = seed.pulse.weights.pulse!;

  const interactionIndex =
    engagementRateDisplay * interactionWeights.engagementRate! +
    creationRateDisplay * interactionWeights.creationRate!;

  const pulseScore =
    interactionIndex * pulseWeights.interactionIndex! +
    adoptionRateDisplay * pulseWeights.adoptionRate!;

  return {
    engagementRateExact,
    creationRateExact,
    adoptionRateExact,
    engagementRateDisplay,
    creationRateDisplay,
    adoptionRateDisplay,
    interactionIndex: Number(interactionIndex.toFixed(2)),
    pulseScore: Number(pulseScore.toFixed(2)),
  };
}
