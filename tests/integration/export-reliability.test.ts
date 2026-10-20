import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { matomoConnections } from '@axp/db';
import { seedReferenceDashboard } from '@axp/fixtures';
import { MemoryMailTransport } from '@axp/core';
import { buildServer } from '../../apps/api/src/server';
import { pdfText, xlsxSheets } from '../../packages/core/src/export/readers.test-helper';
import {
  closeDatabase,
  createTestContext,
  grantProjectAccess,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Export reliability (Phase 10; acceptance G).
 *
 * Several people exporting at once each get their own, complete file; an
 * export made while Matomo is down is still a correct file - it says the
 * values are unavailable instead of failing or printing zeros.
 */
describe('export reliability', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let session: string;
  let tenantId: string;
  let dashboardId: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestContext({ mailTransport: new MemoryMailTransport() });
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
    tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: 'exp',
        name: 'Export',
        slug: 'export',
      })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    const projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'exp.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;
    const { userId } = await ctx.container.users.createLocalUser({
      email: 'viewer@example.invalid',
      firstName: 'View',
      lastName: 'Er',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.tenants.addMembership(tenantId, userId);
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role: 'viewer',
      scopeType: 'project',
      scopeId: projectId,
    });
    await grantProjectAccess(ctx, userId, projectId, 'view');
    dashboardId = (
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: userId })
    ).dashboardId;
    session = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'viewer@example.invalid', password: STRONG_TEST_PASSWORD },
      })
    ).json().token as string;
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  function exportAs(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/dashboards/${dashboardId}/exports`,
      headers: { authorization: `Bearer ${session}` },
      payload: body,
    });
  }

  function download(id: string) {
    return app.inject({
      method: 'GET',
      url: `/exports/${id}`,
      headers: { authorization: `Bearer ${session}` },
    });
  }

  it('gives everyone exporting at once their own complete file', async () => {
    const formats = ['pdf', 'xlsx', 'pptx', 'csv'] as const;
    const requests = Array.from({ length: 12 }, (_, index) => {
      const format = formats[index % formats.length]!;
      return exportAs(format === 'csv' ? { format, widgetId: 'kpi-visits' } : { format });
    });
    const created = await Promise.all(requests);
    for (const response of created) expect(response.statusCode, response.body).toBe(201);
    const ids = created.map((response) => response.json().id as string);
    expect(new Set(ids).size).toBe(ids.length);

    const files = await Promise.all(ids.map((id) => download(id)));
    for (const file of files) {
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.length).toBeGreaterThan(200);
    }
    // Each format opens as what it claims to be.
    const pdf = files[0]!.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const xlsx = files[1]!.rawPayload;
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  });

  it('still produces a correct file while Matomo is unreachable', async () => {
    await ctx.container.db
      .update(matomoConnections)
      .set({ baseUrl: 'mock://unavailable' })
      .where(eq(matomoConnections.tenantId, tenantId));
    await ctx.container.analyticsCache.clear();

    const workbook = await exportAs({ format: 'xlsx' });
    expect(workbook.statusCode, workbook.body).toBe(201);
    const sheets = await xlsxSheets((await download(workbook.json().id)).rawPayload);
    const cells = [...sheets.values()].flat(2).map((cell) => String(cell ?? ''));
    expect(cells.join(' ')).toMatch(/nicht verfügbar|Nicht verfügbar/);

    const pdf = await exportAs({ format: 'pdf' });
    expect(pdf.statusCode, pdf.body).toBe(201);
    const text = (await pdfText((await download(pdf.json().id)).rawPayload)).join('\n');
    expect(text).toMatch(/nicht verfügbar|Nicht verfügbar/);
    // No value of the healthy source, and no zero standing in for one.
    expect(text).not.toMatch(/\b0 Besuche\b/);
  });
});
