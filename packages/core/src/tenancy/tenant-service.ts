import { and, eq } from 'drizzle-orm';
import { AppError, canTransitionTenant, type TenantLifecycle } from '@axp/contracts';
import { type Database, newId, projects, tenantMemberships, tenants } from '@axp/db';
import type { Clock } from '../clock';
import type { AuditService } from '../audit/audit-service';

export interface TenantServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
}

export interface CreateTenantInput {
  readonly portableId: string;
  readonly name: string;
  readonly slug: string;
  readonly defaultLocale?: 'de' | 'en';
  readonly actorUserId?: string;
}

export interface CreateProjectInput {
  readonly tenantId: string;
  readonly portableId: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly timezone?: string;
  readonly defaultLocale?: 'de' | 'en';
  readonly actorUserId?: string;
}

/**
 * Tenant and project lifecycle (Master Spec §5).
 *
 * Phase 0 covers only what the foundation and the canonical fixture need:
 * creation, lookup and guarded lifecycle transitions. The Platform Admin
 * wizard, impact previews and purge arrive with Phase 5.
 */
export class TenantService {
  constructor(private readonly deps: TenantServiceDeps) {}

  async createTenant(input: CreateTenantInput): Promise<{ tenantId: string }> {
    const tenantId = newId();
    const now = this.deps.clock.now();

    await this.deps.db.insert(tenants).values({
      id: tenantId,
      portableId: input.portableId,
      name: input.name,
      slug: input.slug,
      // New tenants start in `provisioning` and are activated explicitly, so a
      // half-configured tenant is never mistaken for a live one.
      lifecycle: 'provisioning',
      defaultLocale: input.defaultLocale ?? 'de',
      lifecycleChangedAt: now,
      lifecycleChangedByUserId: input.actorUserId ?? null,
    });

    await this.deps.audit.success('tenant.created', {
      actorUserId: input.actorUserId ?? null,
      tenantId,
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { name: input.name, slug: input.slug },
    });

    return { tenantId };
  }

  async changeLifecycle(
    tenantId: string,
    next: TenantLifecycle,
    actorUserId?: string,
  ): Promise<void> {
    const [tenant] = await this.deps.db
      .select({ lifecycle: tenants.lifecycle })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      throw new AppError('not_found', {
        code: 'tenant_not_found',
        internalMessage: `Tenant ${tenantId} does not exist.`,
      });
    }

    if (tenant.lifecycle === next) return;

    if (!canTransitionTenant(tenant.lifecycle, next)) {
      throw new AppError('conflict', {
        code: 'invalid_lifecycle_transition',
        messageKey: 'tenant.invalid_lifecycle_transition',
        messageParams: { from: tenant.lifecycle, to: next },
        internalMessage: `Refused tenant transition ${tenant.lifecycle} -> ${next}.`,
      });
    }

    const now = this.deps.clock.now();
    await this.deps.db
      .update(tenants)
      .set({
        lifecycle: next,
        lifecycleChangedAt: now,
        lifecycleChangedByUserId: actorUserId ?? null,
      })
      .where(eq(tenants.id, tenantId));

    await this.deps.audit.success('tenant.lifecycle.changed', {
      actorUserId: actorUserId ?? null,
      tenantId,
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { from: tenant.lifecycle, to: next },
    });
  }

  async createProject(input: CreateProjectInput): Promise<{ projectId: string }> {
    const [tenant] = await this.deps.db
      .select({ id: tenants.id, lifecycle: tenants.lifecycle })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);

    if (!tenant) {
      throw new AppError('not_found', {
        code: 'tenant_not_found',
        internalMessage: `Cannot create project: tenant ${input.tenantId} does not exist.`,
      });
    }
    if (tenant.lifecycle === 'offboarding' || tenant.lifecycle === 'deleted') {
      throw new AppError('conflict', {
        code: 'tenant_not_accepting_changes',
        messageKey: 'tenant.not_accepting_changes',
        internalMessage: `Tenant ${input.tenantId} is ${tenant.lifecycle}.`,
      });
    }

    const projectId = newId();
    await this.deps.db.insert(projects).values({
      id: projectId,
      tenantId: input.tenantId,
      portableId: input.portableId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      timezone: input.timezone ?? 'Europe/Berlin',
      defaultLocale: input.defaultLocale ?? 'de',
      setupState: 'setup_required',
    });

    await this.deps.audit.success('project.created', {
      actorUserId: input.actorUserId ?? null,
      tenantId: input.tenantId,
      projectId,
      targetType: 'project',
      targetId: projectId,
      metadata: { name: input.name, slug: input.slug },
    });

    return { projectId };
  }

  /**
   * Tenant membership is separate from global identity (Gap Review G5): a user
   * may belong to several tenants and survives the removal of any one of them.
   */
  async addMembership(tenantId: string, userId: string): Promise<void> {
    const [existing] = await this.deps.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)),
      )
      .limit(1);
    if (existing) return;

    await this.deps.db
      .insert(tenantMemberships)
      .values({ id: newId(), tenantId, userId });
  }

  async findTenantBySlug(slug: string) {
    const [row] = await this.deps.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return row ?? null;
  }

  async findProjectBySlug(tenantId: string, slug: string) {
    const [row] = await this.deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.slug, slug)))
      .limit(1);
    return row ?? null;
  }
}
