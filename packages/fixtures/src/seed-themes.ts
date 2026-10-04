import { THEME_PRESETS } from '@axp/contracts';
import type { Container } from '@axp/core';

/**
 * The reference themes of the canonical demo (development plan, Phase 9).
 *
 * The platform carries the Telekom Default reference theme; the demo customer
 * its own neutral customer theme on top. Both go through the ordinary path -
 * draft, contrast validation, publish - so the demo shows inheritance working
 * rather than rows written past the rules. Idempotent: a scope that already
 * has a published theme is left alone.
 */
export async function seedThemes(
  container: Container,
  params: { tenantId: string; platformAdminUserId: string; tenantAdminUserId: string },
): Promise<{ platform: number | null; tenant: number | null }> {
  const platform = await publishOnce(
    container,
    { scope: 'platform' },
    'telekom-default',
    params.platformAdminUserId,
  );
  const tenant = await publishOnce(
    container,
    { scope: 'tenant', tenantId: params.tenantId },
    'neutral-customer',
    params.tenantAdminUserId,
  );
  return { platform, tenant };
}

async function publishOnce(
  container: Container,
  target: Parameters<Container['themes']['overview']>[0],
  preset: keyof typeof THEME_PRESETS,
  actorUserId: string,
): Promise<number | null> {
  const existing = await container.themes.overview(target);
  if (existing.published) return existing.published.version;
  await container.themes.saveDraft({
    target,
    name: THEME_PRESETS[preset].name,
    tokens: THEME_PRESETS[preset].tokens,
    actorUserId,
  });
  const published = await container.themes.publish({ target, actorUserId });
  return published.published?.version ?? null;
}
