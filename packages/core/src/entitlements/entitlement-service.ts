import { and, eq } from 'drizzle-orm';
import {
  AppError,
  ENTITLEMENTS,
  type Entitlement,
  type EntitlementState,
  FEATURE_FLAGS,
  type FeatureFlag,
  type FeatureFlagState,
} from '@axp/contracts';
import { type Database, newId, tenantEntitlements, users } from '@axp/db';
import type { AuditService } from '../audit/audit-service';
import type { Clock } from '../clock';

export interface EntitlementServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  /** Technical rollout switches of this installation. */
  readonly featureFlags: Readonly<Record<FeatureFlag, { enabled: boolean; setting: string }>>;
}

/** The context an entitlement is asked about: the customer. */
export interface EntitlementContext {
  readonly tenantId: string;
}

/**
 * Entitlements (Master Spec §23, Shared Contract §14).
 *
 * Answers "does this customer have the module?" - never "may this person act?"
 * (authorization) and never "is the function rolled out here?" (feature flag).
 * Without a recorded decision a module is available: there is no billing or
 * licence server in the MVP, and a platform administrator switches modules
 * off per customer. Switching off deletes nothing.
 */
export class EntitlementService {
  constructor(private readonly deps: EntitlementServiceDeps) {}

  async hasEntitlement(context: EntitlementContext, entitlement: Entitlement): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ enabled: tenantEntitlements.enabled })
      .from(tenantEntitlements)
      .where(
        and(
          eq(tenantEntitlements.tenantId, context.tenantId),
          eq(tenantEntitlements.entitlement, entitlement),
        ),
      )
      .limit(1);
    return row ? row.enabled === 1 : true;
  }

  /** Throws `entitlement_required` - a state of its own, not a permission error (D10). */
  async require(context: EntitlementContext, entitlement: Entitlement): Promise<void> {
    if (await this.hasEntitlement(context, entitlement)) return;
    throw new AppError('entitlement_required', {
      code: 'entitlement_missing',
      messageKey: `entitlement.missing.${entitlement.replace('.', '_')}`,
      internalMessage: `Tenant ${context.tenantId} is not entitled to ${entitlement}.`,
    });
  }

  async list(tenantId: string): Promise<EntitlementState[]> {
    const rows = await this.deps.db
      .select({
        entitlement: tenantEntitlements.entitlement,
        enabled: tenantEntitlements.enabled,
        changedAt: tenantEntitlements.changedAt,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(tenantEntitlements)
      .leftJoin(users, eq(users.id, tenantEntitlements.changedByUserId))
      .where(eq(tenantEntitlements.tenantId, tenantId));
    const byName = new Map(rows.map((row) => [row.entitlement, row]));
    return ENTITLEMENTS.map((entitlement) => {
      const row = byName.get(entitlement);
      return {
        entitlement,
        enabled: row ? row.enabled === 1 : true,
        changedAt: row?.changedAt.toISOString() ?? null,
        changedBy: row?.firstName ? `${row.firstName} ${row.lastName}`.trim() : null,
      };
    });
  }

  async set(input: {
    readonly tenantId: string;
    readonly entitlement: Entitlement;
    readonly enabled: boolean;
    readonly actorUserId: string;
  }): Promise<EntitlementState[]> {
    const now = this.deps.clock.now();
    const [existing] = await this.deps.db
      .select({ id: tenantEntitlements.id })
      .from(tenantEntitlements)
      .where(
        and(
          eq(tenantEntitlements.tenantId, input.tenantId),
          eq(tenantEntitlements.entitlement, input.entitlement),
        ),
      )
      .limit(1);
    if (existing) {
      await this.deps.db
        .update(tenantEntitlements)
        .set({ enabled: input.enabled ? 1 : 0, changedByUserId: input.actorUserId, changedAt: now })
        .where(eq(tenantEntitlements.id, existing.id));
    } else {
      await this.deps.db.insert(tenantEntitlements).values({
        id: newId(),
        tenantId: input.tenantId,
        entitlement: input.entitlement,
        enabled: input.enabled ? 1 : 0,
        changedByUserId: input.actorUserId,
        changedAt: now,
      });
    }
    await this.deps.audit.record({
      action: 'entitlement.changed',
      outcome: 'success',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'entitlement',
      targetId: input.entitlement,
      metadata: { entitlement: input.entitlement, enabled: input.enabled },
    });
    return this.list(input.tenantId);
  }

  featureFlags(): FeatureFlagState[] {
    return FEATURE_FLAGS.map((flag) => ({
      flag,
      enabled: this.deps.featureFlags[flag].enabled,
      setting: this.deps.featureFlags[flag].setting,
    }));
  }

  isFeatureEnabled(flag: FeatureFlag): boolean {
    return this.deps.featureFlags[flag].enabled;
  }
}
