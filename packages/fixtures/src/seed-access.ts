import { and, eq } from 'drizzle-orm';
import type { Container } from '@axp/core';
import { groups } from '@axp/db';

/**
 * Who may see which data in the demo (ADR 0006).
 *
 * Roles open no data by themselves, so the fixture grants it the way the
 * product recommends: through a group for the many, directly for the
 * exception (Master Spec §7).
 *
 *   - `Portal-Leser` holds a view grant on the project; the demo viewer is a
 *     member. Their access reads User -> Gruppe -> Freigabe -> Projekt.
 *   - The semantic catalog manager gets a direct view grant on the project,
 *     because previewing a formula shows this customer's real numbers.
 *   - The tenant admin and the platform admin get nothing. They administer;
 *     they do not read customer analytics. That is the point.
 *   - Dashboards the editor created carry the editor's own edit grant.
 *
 * Plus one account managed by an identity provider, so the "Durch Identity
 * Provider verwaltet" state can be seen - an addition to the canonical
 * fixture, not a change to it.
 */

export const DEMO_READER_GROUP = 'Portal-Leser';
export const DEMO_SSO_EMAIL = 'sso.demo@example.invalid';

export async function seedAccessDemo(
  container: Container,
  params: {
    tenantId: string;
    projectId: string;
    viewerUserId: string | null;
    semanticUserId: string | null;
    editorUserId: string | null;
    dashboardIds: readonly string[];
  },
): Promise<{ groupId: string; ssoUserId: string }> {
  const { tenantId, projectId } = params;

  const [existing] = await container.db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.name, DEMO_READER_GROUP)))
    .limit(1);

  const groupId =
    existing?.id ??
    (
      await container.groups.create({
        tenantId,
        name: DEMO_READER_GROUP,
        description: 'Liest die veröffentlichten Dashboards des Mitarbeiterportals.',
        actorUserId: params.editorUserId ?? params.viewerUserId ?? 'system',
      })
    ).groupId;

  await container.access.grant({
    tenantId,
    subjectType: 'group',
    subjectId: groupId,
    objectType: 'project',
    objectId: projectId,
    access: 'view',
  });

  if (params.viewerUserId) {
    await container.groups.addMember({
      tenantId,
      groupId,
      userId: params.viewerUserId,
      actorUserId: params.viewerUserId,
    });
  }

  if (params.semanticUserId) {
    await container.access.grant({
      tenantId,
      subjectType: 'user',
      subjectId: params.semanticUserId,
      objectType: 'project',
      objectId: projectId,
      access: 'view',
    });
  }

  // Idempotent: a re-run over dashboards created before grants existed still
  // leaves their author able to open them.
  if (params.editorUserId) {
    for (const dashboardId of params.dashboardIds) {
      await container.access.grantCreator({
        tenantId,
        dashboardId,
        userId: params.editorUserId,
      });
    }
  }

  const { userId: ssoUserId } = await container.users.createFederatedUser({
    email: DEMO_SSO_EMAIL,
    firstName: 'Simon',
    lastName: 'Single-Sign-On',
    providerSubject: 'demo-idp|simon',
    managedAttributes: ['firstName', 'lastName', 'email'],
  });
  await container.userAdmin.addMembership(tenantId, ssoUserId);
  await container.groups.addMember({
    tenantId,
    groupId,
    userId: ssoUserId,
    actorUserId: ssoUserId,
  });
  await container.users.assignRole({
    subjectType: 'user',
    subjectId: ssoUserId,
    role: 'viewer',
    scopeType: 'project',
    scopeId: projectId,
    tenantId,
  });

  return { groupId, ssoUserId };
}
