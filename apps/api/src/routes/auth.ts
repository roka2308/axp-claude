import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { ROLE_DESCRIPTORS } from '@axp/contracts';
import { users } from '@axp/db';
import type { Container } from '@axp/core';
import { extractBearerToken, requireAuth } from '../plugins/authentication';

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
});

export function registerAuthRoutes(app: FastifyInstance, container: Container): void {
  /**
   * Local login. Rate limited in addition to the per-account and per-address
   * lockout in the domain layer, so a distributed attempt still meets a ceiling.
   */
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const input = loginSchema.parse(request.body);
      const result = await container.auth.login({
        email: input.email,
        password: input.password,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        userId: result.userId,
        mustChangePassword: result.mustChangePassword,
      };
    },
  );

  app.post('/auth/logout', { onRequest: [app.authenticate] }, async (request) => {
    const token = extractBearerToken(request);
    if (token) await container.auth.logout(token, request.auth?.userId);
    return { ok: true };
  });

  /**
   * The caller's own identity and access summary.
   *
   * Roles are reported together with the explicit statement that none of them
   * grants analytics data access by itself - the same distinction the
   * Administration UI has to make (Master Spec §7).
   */
  app.get('/auth/me', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);

    const [user] = await container.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        status: users.status,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);

    return {
      user,
      recentlyAuthenticated: request.recentlyAuthenticated ?? false,
      roleAssignments: auth.roleAssignments.map((assignment) => ({
        role: assignment.role,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
        viaGroup: assignment.subjectType === 'group',
        grantsAutomaticAnalyticsAccess:
          ROLE_DESCRIPTORS[assignment.role].grantsAutomaticAnalyticsAccess,
      })),
      tenantIds: auth.tenantIds,
      projectIds: auth.projectIds,
    };
  });
}
