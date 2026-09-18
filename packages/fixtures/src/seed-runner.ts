import { eq } from 'drizzle-orm';
import { AppError } from '@axp/contracts';
import { users } from '@axp/db';
import { type Container, generateSecretToken } from '@axp/core';
import { DEMO_USER_NAMES, type DemoSeed, loadDemoSeed } from './demo-seed';

export interface SeedOptions {
  /**
   * Password for every demo account. Omitted means one random password per
   * account, printed once by the CLI - so no default credential ever exists in
   * a code path that could reach production.
   */
  readonly password?: string;
  readonly seed?: DemoSeed;
}

export interface SeededAccount {
  readonly key: string;
  readonly email: string;
  readonly password: string;
  readonly roles: string;
  readonly created: boolean;
}

export interface SeedResult {
  readonly tenantId: string;
  readonly projectId: string;
  readonly accounts: readonly SeededAccount[];
}

/**
 * Applies the canonical demo fixture.
 *
 * Idempotent: re-running updates nothing that already exists, so a developer
 * can seed repeatedly without duplicate tenants or users.
 *
 * Phase 0 applies the tenancy and identity part of the fixture. The Matomo
 * site, semantic definitions and Pulse solution are seeded by later milestones;
 * their values already live in `demo_seed.json` so both tracks stay aligned.
 */
export async function seedDemoData(
  container: Container,
  options: SeedOptions = {},
): Promise<SeedResult> {
  // Two independent guards: a production environment can never be seeded, and
  // demo fixtures must be switched on deliberately.
  if (container.config.appEnv === 'production') {
    throw new AppError('invalid_configuration', {
      code: 'demo_seed_in_production',
      internalMessage: 'Refusing to seed demo fixtures: APP_ENV=production.',
    });
  }
  if (!container.config.features.demoFixtures) {
    throw new AppError('invalid_configuration', {
      code: 'demo_fixtures_disabled',
      internalMessage: 'Refusing to seed: ENABLE_DEMO_FIXTURES is not enabled.',
    });
  }

  const seed = options.seed ?? loadDemoSeed();

  const existingTenant = await container.tenants.findTenantBySlug(seed.tenant.slug);
  const tenantId =
    existingTenant?.id ??
    (
      await container.tenants.createTenant({
        portableId: seed.tenant.portableId,
        name: seed.tenant.name,
        slug: seed.tenant.slug,
        defaultLocale: seed.project.locale,
      })
    ).tenantId;

  // The fixture describes an active tenant; creation starts in `provisioning`.
  if (!existingTenant || existingTenant.lifecycle === 'provisioning') {
    await container.tenants.changeLifecycle(tenantId, 'active');
  }

  const existingProject = await container.tenants.findProjectBySlug(tenantId, seed.project.slug);
  const projectId =
    existingProject?.id ??
    (
      await container.tenants.createProject({
        tenantId,
        portableId: seed.project.portableId,
        name: seed.project.name,
        slug: seed.project.slug,
        timezone: seed.project.timezone,
        defaultLocale: seed.project.locale,
      })
    ).projectId;

  const accounts: SeededAccount[] = [];

  for (const fixtureUser of seed.users) {
    const names = DEMO_USER_NAMES[fixtureUser.key] ?? {
      firstName: fixtureUser.key,
      lastName: 'Demo',
    };
    const password = options.password ?? generateSecretToken(12);

    const [existing] = await container.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailNormalized, fixtureUser.email.toLowerCase()))
      .limit(1);

    let userId: string;
    let created = false;

    if (existing) {
      userId = existing.id;
      if (options.password) {
        // Only reset an existing demo account when an explicit password was
        // requested; otherwise a re-run would silently invalidate credentials
        // the developer is currently using.
        await container.users.changePassword({
          userId,
          newPassword: options.password,
          requireCurrent: false,
        });
      }
    } else {
      userId = (
        await container.users.createLocalUser({
          email: fixtureUser.email,
          firstName: names.firstName,
          lastName: names.lastName,
          locale: seed.project.locale,
          password,
          status: 'active',
        })
      ).userId;
      created = true;
    }

    for (const roleSpec of fixtureUser.roles) {
      const scopeId =
        roleSpec.scope === 'platform' ? '' : roleSpec.scope === 'tenant' ? tenantId : projectId;
      await container.users.assignRole({
        subjectType: 'user',
        subjectId: userId,
        role: roleSpec.role,
        scopeType: roleSpec.scope,
        scopeId,
        tenantId: roleSpec.scope === 'platform' ? undefined : tenantId,
      });
    }

    // Platform admins are not tenant members: the role is platform-wide and, by
    // design, grants no customer analytics access (Master Spec §7).
    if (fixtureUser.roles.some((role) => role.scope !== 'platform')) {
      await container.tenants.addMembership(tenantId, userId);
    }

    accounts.push({
      key: fixtureUser.key,
      email: fixtureUser.email,
      password: created || options.password ? password : '(unchanged)',
      roles: fixtureUser.roles.map((role) => `${role.role}@${role.scope}`).join(', '),
      created,
    });
  }

  return { tenantId, projectId, accounts };
}
