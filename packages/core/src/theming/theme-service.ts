import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  AppError,
  evaluateContrast,
  type ContrastCheck,
  type ThemeOverview,
  type ThemeScope,
  type ThemeTokenValues,
  type ThemeValidation,
  type ThemeValidationIssue,
  validateThemeTokens,
} from '@axp/contracts';
import { type Database, newId, projects, themes, themeVersions, users } from '@axp/db';
import type { AuditService } from '../audit/audit-service';
import type { Clock } from '../clock';
import type { EntitlementService } from '../entitlements/entitlement-service';

export interface ThemeServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly entitlements: EntitlementService;
}

/** Which theme: the platform's, a tenant's, or a project's. */
export type ThemeTarget =
  | { readonly scope: 'platform' }
  | { readonly scope: 'tenant'; readonly tenantId: string }
  | { readonly scope: 'project'; readonly tenantId: string; readonly projectId: string };

type ThemeRow = typeof themes.$inferSelect;
type Layers = { light: ThemeTokenValues; dark: ThemeTokenValues };

/** What a scope looks like: its published tokens, light and dark. */
interface Published {
  readonly name: string;
  readonly version: number;
  readonly light: ThemeTokenValues;
  readonly dark: ThemeTokenValues;
}

/**
 * Themes (Master Spec §16): Draft -> Preview -> Validate -> Publish ->
 * Version/Rollback, inherited Platform -> Tenant -> optional Project.
 *
 * A theme is a set of values for allowlisted tokens - never CSS, never script.
 * Contrast is judged on what will really be shown: the product defaults, then
 * every theme above, then this one; and a theme is not published while any
 * theme that builds on it would fail. Invalid contrast does not publish,
 * silently or otherwise.
 */
export class ThemeService {
  constructor(private readonly deps: ThemeServiceDeps) {}

  async overview(target: ThemeTarget): Promise<ThemeOverview> {
    const row = await this.row(target);
    const inherited = await this.inheritedLayers(target);
    const published = row ? await this.published(row) : null;
    const versions = row
      ? await this.deps.db
          .select({
            version: themeVersions.version,
            createdAt: themeVersions.createdAt,
            rolledBackFromVersion: themeVersions.rolledBackFromVersion,
            tokens: themeVersions.tokens,
            id: themeVersions.id,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(themeVersions)
          .leftJoin(users, eq(users.id, themeVersions.publishedByUserId))
          .where(eq(themeVersions.themeId, row.id))
          .orderBy(desc(themeVersions.version))
      : [];

    return {
      scope: target.scope,
      tenantId: 'tenantId' in target ? target.tenantId : null,
      projectId: target.scope === 'project' ? target.projectId : null,
      name: row?.draftName ?? published?.name ?? '',
      draft:
        row?.draftTokens && row.draftUpdatedAt
          ? {
              name: row.draftName ?? published?.name ?? '',
              tokens: row.draftTokens as ThemeTokenValues,
              darkTokens: (row.draftDarkTokens ?? {}) as ThemeTokenValues,
              updatedAt: row.draftUpdatedAt.toISOString(),
            }
          : null,
      published: published
        ? { version: published.version, tokens: published.light, darkTokens: published.dark }
        : null,
      versions: versions.map((entry) => ({
        version: entry.version,
        publishedAt: entry.createdAt.toISOString(),
        publishedBy: entry.firstName ? `${entry.firstName} ${entry.lastName}`.trim() : null,
        rolledBackFromVersion: entry.rolledBackFromVersion,
        isCurrent: entry.id === row?.publishedVersionId,
        tokenCount: Object.keys(entry.tokens).length,
      })),
      inherited: merge(inherited.map((layer) => layer.light)),
      inheritedDark: merge(inherited.map((layer) => layer.dark)),
      applied: target.scope === 'platform' || (await this.customThemesAllowed(target.tenantId)),
    };
  }

  /**
   * Saves the working copy. Anything outside the allowlist, or a value that
   * is not a plain colour, length, shadow or font stack, is refused with the
   * token named - nothing is stored half.
   */
  async saveDraft(input: {
    readonly target: ThemeTarget;
    readonly name: string;
    readonly tokens: Readonly<Record<string, string>>;
    readonly darkTokens?: Readonly<Record<string, string>>;
    readonly actorUserId: string;
  }): Promise<ThemeOverview> {
    await this.requireCustomThemes(input.target);
    const light = validateThemeTokens({ ...input.tokens });
    const dark = validateThemeTokens({ ...(input.darkTokens ?? {}) });
    const issues = [
      ...light.issues,
      ...dark.issues.map((issue) => ({ ...issue, token: `dark:${issue.token}` })),
    ];
    if (issues.length > 0) throw unsafe(issues);

    const row = await this.ensureRow(input.target);
    await this.deps.db
      .update(themes)
      .set({
        draftName: input.name.trim().slice(0, 120) || 'Theme',
        draftTokens: light.accepted as Record<string, string>,
        draftDarkTokens: dark.accepted as Record<string, string>,
        draftUpdatedAt: this.deps.clock.now(),
        draftUpdatedByUserId: input.actorUserId,
      })
      .where(eq(themes.id, row.id));
    return this.overview(input.target);
  }

  async discardDraft(target: ThemeTarget): Promise<ThemeOverview> {
    const row = await this.row(target);
    if (row) {
      await this.deps.db
        .update(themes)
        .set({ draftName: null, draftTokens: null, draftDarkTokens: null, draftUpdatedAt: null })
        .where(eq(themes.id, row.id));
    }
    return this.overview(target);
  }

  /** Validates the draft as it would be published: with its inheritance and its dependents. */
  async validateDraft(target: ThemeTarget): Promise<ThemeValidation> {
    const row = await this.row(target);
    if (!row?.draftTokens) {
      throw new AppError('validation_failed', {
        code: 'theme_no_draft',
        messageKey: 'theme.no_draft',
        internalMessage: 'There is no draft to validate.',
      });
    }
    return this.validate(target, {
      light: row.draftTokens as ThemeTokenValues,
      dark: (row.draftDarkTokens ?? {}) as ThemeTokenValues,
    });
  }

  async publish(input: { readonly target: ThemeTarget; readonly actorUserId: string }) {
    await this.requireCustomThemes(input.target);
    const row = await this.row(input.target);
    if (!row?.draftTokens) {
      throw new AppError('validation_failed', {
        code: 'theme_no_draft',
        messageKey: 'theme.no_draft',
        internalMessage: 'There is no draft to publish.',
      });
    }
    const layers = {
      light: row.draftTokens as ThemeTokenValues,
      dark: (row.draftDarkTokens ?? {}) as ThemeTokenValues,
    };
    const validation = await this.validate(input.target, layers);
    if (!validation.publishable) throw notPublishable(validation);

    const version = await this.insertVersion(
      row,
      row.draftName ?? 'Theme',
      layers,
      input.actorUserId,
      null,
    );
    await this.deps.db
      .update(themes)
      .set({ draftName: null, draftTokens: null, draftDarkTokens: null, draftUpdatedAt: null })
      .where(eq(themes.id, row.id));
    await this.deps.audit.record({
      action: 'theme.published',
      outcome: 'success',
      actorUserId: input.actorUserId,
      tenantId: 'tenantId' in input.target ? input.target.tenantId : null,
      projectId: input.target.scope === 'project' ? input.target.projectId : null,
      targetType: 'theme',
      targetId: row.id,
      metadata: {
        scope: input.target.scope,
        version,
        tokens: Object.keys(layers.light).length,
        darkTokens: Object.keys(layers.dark).length,
      },
    });
    return this.overview(input.target);
  }

  /** Publishes an older version again, as a new version, if it still passes. */
  async rollback(input: {
    readonly target: ThemeTarget;
    readonly version: number;
    readonly actorUserId: string;
  }) {
    await this.requireCustomThemes(input.target);
    const row = await this.row(input.target);
    const [old] = row
      ? await this.deps.db
          .select()
          .from(themeVersions)
          .where(and(eq(themeVersions.themeId, row.id), eq(themeVersions.version, input.version)))
          .limit(1)
      : [];
    if (!row || !old) {
      throw new AppError('not_found', {
        code: 'theme_version_not_found',
        messageKey: 'theme.version_not_found',
        internalMessage: `Theme version ${input.version} not found.`,
      });
    }
    const layers = {
      light: old.tokens as ThemeTokenValues,
      dark: old.darkTokens as ThemeTokenValues,
    };
    // The world around it may have changed since; it is judged again.
    const validation = await this.validate(input.target, layers);
    if (!validation.publishable) throw notPublishable(validation);

    const version = await this.insertVersion(row, old.name, layers, input.actorUserId, old.version);
    await this.deps.audit.record({
      action: 'theme.rolled_back',
      outcome: 'success',
      actorUserId: input.actorUserId,
      tenantId: 'tenantId' in input.target ? input.target.tenantId : null,
      projectId: input.target.scope === 'project' ? input.target.projectId : null,
      targetType: 'theme',
      targetId: row.id,
      metadata: { scope: input.target.scope, version, fromVersion: old.version },
    });
    return this.overview(input.target);
  }

  /**
   * The theme to show: published layers from the platform down, as far as the
   * customer is entitled to its own. A customer that loses the module keeps
   * its themes; they are simply not applied.
   */
  async effective(context: {
    tenantId?: string | null;
    projectId?: string | null;
  }): Promise<Layers> {
    const scopeKeys = ['platform'];
    const custom = context.tenantId ? await this.customThemesAllowed(context.tenantId) : false;
    if (custom && context.tenantId) {
      scopeKeys.push(`tenant:${context.tenantId}`);
      if (context.projectId) scopeKeys.push(`project:${context.projectId}`);
    }
    const rows = await this.deps.db
      .select({
        scopeKey: themes.scopeKey,
        tokens: themeVersions.tokens,
        dark: themeVersions.darkTokens,
      })
      .from(themes)
      .innerJoin(themeVersions, eq(themeVersions.id, themes.publishedVersionId))
      .where(inArray(themes.scopeKey, scopeKeys));
    const ordered = scopeKeys
      .map((key) => rows.find((row) => row.scopeKey === key))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    return {
      light: merge(ordered.map((row) => row.tokens as ThemeTokenValues)),
      dark: merge(ordered.map((row) => row.dark as ThemeTokenValues)),
    };
  }

  // --- internals ------------------------------------------------------------------

  private async validate(target: ThemeTarget, candidate: Layers): Promise<ThemeValidation> {
    const issues: ThemeValidationIssue[] = [
      ...validateThemeTokens(candidate.light as Record<string, string>).issues,
      ...validateThemeTokens(candidate.dark as Record<string, string>).issues,
    ];
    const above = await this.inheritedLayers(target);
    const contrast = checks(above, candidate);

    // Themes that build on this one, judged with the candidate in place.
    const dependents: { scope: ThemeScope; name: string; failing: number }[] = [];
    for (const dependent of await this.dependents(target)) {
      const chain = [...above, candidate, ...dependent.between, dependent.layers];
      const failing = checks(chain.slice(0, -1), chain[chain.length - 1]!).filter(
        (check) => !check.pass,
      ).length;
      if (failing > 0) dependents.push({ scope: dependent.scope, name: dependent.name, failing });
    }

    return {
      issues,
      contrast,
      dependents,
      publishable:
        issues.length === 0 && contrast.every((check) => check.pass) && dependents.length === 0,
    };
  }

  /** Published layers above a target, top first. */
  private async inheritedLayers(target: ThemeTarget): Promise<Layers[]> {
    const keys =
      target.scope === 'platform'
        ? []
        : target.scope === 'tenant'
          ? ['platform']
          : ['platform', `tenant:${target.tenantId}`];
    const layers: Layers[] = [];
    for (const key of keys) {
      const row = await this.rowByKey(key);
      const published = row ? await this.published(row) : null;
      if (published) layers.push({ light: published.light, dark: published.dark });
    }
    return layers;
  }

  /** Published themes below a target, each with the published layers between. */
  private async dependents(
    target: ThemeTarget,
  ): Promise<{ scope: ThemeScope; name: string; layers: Layers; between: Layers[] }[]> {
    if (target.scope === 'project') return [];
    const below = await this.deps.db
      .select({ theme: themes, projectTenant: projects.tenantId })
      .from(themes)
      .leftJoin(projects, eq(projects.id, themes.projectId))
      .where(isNotNull(themes.publishedVersionId));

    const result: { scope: ThemeScope; name: string; layers: Layers; between: Layers[] }[] = [];
    for (const { theme } of below) {
      if (theme.scope === 'platform') continue;
      if (
        target.scope === 'tenant' &&
        !(theme.scope === 'project' && theme.tenantId === target.tenantId)
      )
        continue;
      const published = await this.published(theme);
      if (!published) continue;
      const between: Layers[] = [];
      if (target.scope === 'platform' && theme.scope === 'project' && theme.tenantId) {
        const tenantRow = await this.rowByKey(`tenant:${theme.tenantId}`);
        const tenantPublished = tenantRow ? await this.published(tenantRow) : null;
        if (tenantPublished)
          between.push({ light: tenantPublished.light, dark: tenantPublished.dark });
      }
      result.push({
        scope: theme.scope,
        name: published.name,
        layers: { light: published.light, dark: published.dark },
        between,
      });
    }
    return result;
  }

  private async insertVersion(
    row: ThemeRow,
    name: string,
    layers: Layers,
    actorUserId: string,
    rolledBackFrom: number | null,
  ): Promise<number> {
    const [latest] = await this.deps.db
      .select({ version: themeVersions.version })
      .from(themeVersions)
      .where(eq(themeVersions.themeId, row.id))
      .orderBy(desc(themeVersions.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const id = newId();
    await this.deps.db.insert(themeVersions).values({
      id,
      themeId: row.id,
      version,
      name,
      tokens: layers.light as Record<string, string>,
      darkTokens: layers.dark as Record<string, string>,
      rolledBackFromVersion: rolledBackFrom,
      publishedByUserId: actorUserId,
    });
    await this.deps.db.update(themes).set({ publishedVersionId: id }).where(eq(themes.id, row.id));
    return version;
  }

  private async published(row: ThemeRow): Promise<Published | null> {
    if (!row.publishedVersionId) return null;
    const [version] = await this.deps.db
      .select()
      .from(themeVersions)
      .where(eq(themeVersions.id, row.publishedVersionId))
      .limit(1);
    return version
      ? {
          name: version.name,
          version: version.version,
          light: version.tokens as ThemeTokenValues,
          dark: version.darkTokens as ThemeTokenValues,
        }
      : null;
  }

  private async ensureRow(target: ThemeTarget): Promise<ThemeRow> {
    const existing = await this.row(target);
    if (existing) return existing;
    await this.deps.db.insert(themes).values({
      id: newId(),
      scope: target.scope,
      scopeKey: keyOf(target),
      tenantId: 'tenantId' in target ? target.tenantId : null,
      projectId: target.scope === 'project' ? target.projectId : null,
    });
    return (await this.row(target))!;
  }

  private row(target: ThemeTarget) {
    return this.rowByKey(keyOf(target));
  }

  private async rowByKey(key: string): Promise<ThemeRow | undefined> {
    const [row] = await this.deps.db.select().from(themes).where(eq(themes.scopeKey, key)).limit(1);
    return row;
  }

  private customThemesAllowed(tenantId: string) {
    return this.deps.entitlements.hasEntitlement({ tenantId }, 'theming.custom');
  }

  private async requireCustomThemes(target: ThemeTarget) {
    if (target.scope === 'platform') return;
    await this.deps.entitlements.require({ tenantId: target.tenantId }, 'theming.custom');
  }
}

function keyOf(target: ThemeTarget): string {
  if (target.scope === 'platform') return 'platform';
  if (target.scope === 'tenant') return `tenant:${target.tenantId}`;
  return `project:${target.projectId}`;
}

function merge(layers: readonly ThemeTokenValues[]): ThemeTokenValues {
  return Object.assign({}, ...layers) as ThemeTokenValues;
}

/** Light and dark checks of a candidate on top of the layers above it. */
function checks(above: readonly Layers[], candidate: Layers): ContrastCheck[] {
  return [
    ...evaluateContrast([...above.map((layer) => layer.light), candidate.light], 'light'),
    ...evaluateContrast([...above.map((layer) => layer.dark), candidate.dark], 'dark'),
  ];
}

function unsafe(issues: readonly ThemeValidationIssue[]): AppError {
  return new AppError('validation_failed', {
    code: 'theme_tokens_refused',
    messageKey: 'theme.tokens_refused',
    messageParams: { tokens: issues.map((issue) => issue.token).join(', ') },
    internalMessage: `Theme tokens refused: ${issues.map((issue) => `${issue.token} (${issue.reason})`).join(', ')}.`,
  });
}

function notPublishable(validation: ThemeValidation): AppError {
  const failing = validation.contrast.filter((check) => !check.pass).length;
  // The theme's own failures come first: only a theme that passes on its own
  // is held back by the themes built on it.
  return new AppError('validation_failed', {
    code: 'theme_contrast_failed',
    messageKey:
      failing === 0 && validation.dependents.length > 0
        ? 'theme.dependents_fail'
        : 'theme.contrast_failed',
    messageParams: {
      failing,
      dependents: validation.dependents.map((entry) => entry.name).join(', '),
    },
    internalMessage: `Theme not published: ${failing} contrast checks fail, ${validation.dependents.length} dependents fail.`,
  });
}
