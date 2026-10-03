import { and, eq, inArray, lte } from 'drizzle-orm';
import {
  AppError,
  type DashboardPresentation,
  type ExportArtifactSummary,
  type ExportFormat,
  type Locale,
} from '@axp/contracts';
import { type Database, exportArtifacts, newId } from '@axp/db';
import type { Logger } from '@axp/observability';
import type { AuditService } from '../audit/audit-service';
import type { Clock } from '../clock';
import type {
  BuildPresentationInput,
  PresentationBuilder,
} from '../dashboard/presentation-builder';
import type { ArtifactStore } from './artifact-store';
import { buildExportDocument, slug } from './document';
import { renderCsv } from './render-csv';
import { renderPdf } from './render-pdf';
import { renderPptx } from './render-pptx';
import { renderXlsx } from './render-xlsx';

export interface ExportServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly presentation: PresentationBuilder;
  readonly store: ArtifactStore;
  readonly ttlMinutes: number;
  /** Renders at once, at most; the rest wait. Rendering is CPU work. */
  readonly maxConcurrentRenders?: number;
}

/** Who asked for a file - and therefore the only one who may fetch it. */
export type ExportRequester =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'share'; readonly shareId: string; readonly shareExpiresAt: Date };

export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
};

/**
 * Manual exports (Master Spec §15).
 *
 * An export reproduces the viewer's current state: the caller resolves and
 * authorizes the view exactly as for the screen, and this service renders
 * that same input - never a stored copy, never the draft. The resulting file
 * is a protected, short-lived artifact: encrypted at rest, readable only by
 * whoever requested it, deleted when it expires. Nothing analytical is
 * written to the database; the row is metadata.
 */
export class ExportService {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly deps: ExportServiceDeps) {}

  async create(input: {
    readonly tenantId: string;
    readonly dashboardId: string;
    readonly format: ExportFormat;
    readonly widgetId?: string;
    readonly view: BuildPresentationInput;
    readonly requester: ExportRequester;
  }): Promise<ExportArtifactSummary> {
    if (input.view.meta.isDraftPreview) {
      // Exports describe what was published; a draft is an editor's workspace.
      throw new AppError('validation_failed', {
        code: 'export_draft_refused',
        messageKey: 'export.draft_refused',
        internalMessage: 'Exports are built from the published dashboard only.',
      });
    }

    const view: BuildPresentationInput = { ...input.view, audience: 'export' };
    const { content, fileName } = await this.render({
      view,
      format: input.format,
      ...(input.widgetId ? { widgetId: input.widgetId } : {}),
      audience: input.requester.kind === 'share' ? 'share' : 'internal',
      ...(input.requester.kind === 'share'
        ? { shareExpiresAt: input.requester.shareExpiresAt }
        : {}),
    });

    const id = newId();
    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + this.deps.ttlMinutes * 60_000);
    const storageKey = await this.deps.store.write(id, content);

    try {
      await this.deps.db.insert(exportArtifacts).values({
        id,
        tenantId: input.tenantId,
        dashboardId: input.dashboardId,
        format: input.format,
        requestedByUserId: input.requester.kind === 'user' ? input.requester.userId : null,
        shareId: input.requester.kind === 'share' ? input.requester.shareId : null,
        fileName,
        byteSize: content.length,
        storageKey,
        expiresAt,
        createdAt: now,
      });
    } catch (error) {
      await this.deps.store.remove(storageKey);
      throw error;
    }

    await this.deps.audit.record({
      action: 'export.created',
      outcome: 'success',
      actorUserId: input.requester.kind === 'user' ? input.requester.userId : null,
      tenantId: input.tenantId,
      projectId: view.projectId,
      targetType: 'dashboard',
      targetId: input.dashboardId,
      // What was exported, never what it contained.
      metadata: {
        format: input.format,
        ...(input.widgetId ? { widgetId: input.widgetId } : {}),
        timeRange: view.timeRangePreset,
        comparison: view.comparisonMode,
        via: input.requester.kind,
        ...(input.requester.kind === 'share' ? { shareId: input.requester.shareId } : {}),
      },
    });

    return {
      id,
      format: input.format,
      fileName,
      byteSize: content.length,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Renders a file and hands it back, keeping nothing.
   *
   * For callers that deliver the bytes themselves - a scheduled report mails
   * its attachment and forgets it. Whatever the caller passed, a file never
   * carries internal notes, and it describes the published dashboard only.
   */
  async render(input: {
    readonly view: BuildPresentationInput;
    readonly format: ExportFormat;
    readonly widgetId?: string;
    readonly audience: 'internal' | 'share';
    readonly shareExpiresAt?: Date;
  }): Promise<{ content: Buffer; fileName: string; presentation: DashboardPresentation }> {
    const view: BuildPresentationInput = { ...input.view, audience: 'export' };
    const locale: Locale = view.locale;

    return this.limited(async () => {
      const presentation = await this.presentationFor(view, input.format, input.widgetId);
      const document = buildExportDocument(presentation, {
        locale,
        generatedAt: this.deps.clock.now(),
        audience: input.audience,
        ...(input.shareExpiresAt ? { shareExpiresAt: input.shareExpiresAt } : {}),
      });

      switch (input.format) {
        case 'pdf':
          return {
            content: await renderPdf(document),
            fileName: `${document.fileBase}.pdf`,
            presentation,
          };
        case 'xlsx':
          return {
            content: await renderXlsx(document),
            fileName: `${document.fileBase}.xlsx`,
            presentation,
          };
        case 'pptx':
          return {
            content: await renderPptx(document),
            fileName: `${document.fileBase}.pptx`,
            presentation,
          };
        case 'csv': {
          const widget = document.widgets[0]!;
          return {
            content: renderCsv(document, widget),
            fileName: `${slug(document.title)}_${slug(widget.title)}_${presentation.timeRange.from}_${presentation.timeRange.to}.csv`,
            presentation,
          };
        }
      }
    });
  }

  /**
   * The file, for the one who asked for it and only until it expires.
   *
   * Someone else's artifact, an expired one and one that never existed all
   * answer `not_found`: an artifact id is not something to probe.
   */
  async open(
    artifactId: string,
    requester:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'share'; readonly shareId: string },
  ): Promise<{
    content: Buffer;
    fileName: string;
    contentType: string;
    summary: ExportArtifactSummary;
  }> {
    const [row] = await this.deps.db
      .select()
      .from(exportArtifacts)
      .where(eq(exportArtifacts.id, artifactId))
      .limit(1);

    const now = this.deps.clock.now();
    const owned =
      row &&
      (requester.kind === 'user'
        ? row.requestedByUserId === requester.userId
        : row.shareId === requester.shareId);

    if (!row || !owned || row.expiresAt <= now) {
      if (row && row.expiresAt <= now) await this.discard([row]);
      throw notFound(artifactId);
    }

    const content = await this.deps.store.read(row.id, row.storageKey);
    if (!content) {
      await this.discard([row]);
      throw notFound(artifactId);
    }

    await this.deps.db
      .update(exportArtifacts)
      .set({ downloadCount: row.downloadCount + 1 })
      .where(eq(exportArtifacts.id, row.id));

    return {
      content,
      fileName: row.fileName,
      contentType: EXPORT_CONTENT_TYPES[row.format],
      summary: {
        id: row.id,
        format: row.format,
        fileName: row.fileName,
        byteSize: row.byteSize,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      },
    };
  }

  /** Deletes expired files and their records, and files nothing points to. */
  async purgeExpired(): Promise<{ expired: number; orphans: number }> {
    const now = this.deps.clock.now();
    const expired = await this.deps.db
      .select({ id: exportArtifacts.id, storageKey: exportArtifacts.storageKey })
      .from(exportArtifacts)
      .where(lte(exportArtifacts.expiresAt, now));
    await this.discard(expired);

    const known = await this.deps.db
      .select({ storageKey: exportArtifacts.storageKey })
      .from(exportArtifacts);
    const orphans = await this.deps.store.orphans(
      new Set(known.map((row) => row.storageKey)),
      new Date(now.getTime() - this.deps.ttlMinutes * 60_000),
    );
    for (const key of orphans) await this.deps.store.remove(key);

    return { expired: expired.length, orphans: orphans.length };
  }

  /** Every artifact of a share, when the share goes away. */
  async discardForShare(shareId: string): Promise<void> {
    const rows = await this.deps.db
      .select({ id: exportArtifacts.id, storageKey: exportArtifacts.storageKey })
      .from(exportArtifacts)
      .where(eq(exportArtifacts.shareId, shareId));
    await this.discard(rows);
  }

  private async discard(rows: readonly { id: string; storageKey: string }[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) await this.deps.store.remove(row.storageKey);
    await this.deps.db.delete(exportArtifacts).where(
      and(
        inArray(
          exportArtifacts.id,
          rows.map((row) => row.id),
        ),
      ),
    );
  }

  private async presentationFor(
    view: BuildPresentationInput,
    format: ExportFormat,
    widgetId: string | undefined,
  ): Promise<DashboardPresentation> {
    if (format !== 'csv') return this.deps.presentation.build(view);

    // One widget: only its own query runs.
    const layout = this.deps.presentation.buildLayout(view);
    const tile = await this.deps.presentation.buildTile({ ...view, widgetId: widgetId! });
    return { ...layout, widgets: [tile] };
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    const limit = this.deps.maxConcurrentRenders ?? 2;
    if (this.running >= limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}

function notFound(artifactId: string): AppError {
  return new AppError('not_found', {
    code: 'export_not_found',
    messageKey: 'export.not_found',
    internalMessage: `Export ${artifactId} is unknown, expired or not the caller's.`,
  });
}
