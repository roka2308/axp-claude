'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BREAKPOINTS,
  type Breakpoint,
  type DashboardSnapshot,
  type EditorLease,
  type PublishImpact,
  type SemanticDefinitionRef,
  type WidgetConfig,
  type TemplateSummary,
} from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { publishAction, publishImpactAction } from '@/app/dashboards/[dashboardId]/edit/actions';
import { EditorCanvas } from './EditorCanvas';
import { Inspector } from './Inspector';
import { WidgetGallery } from './WidgetGallery';
import { useEditorState } from './useEditorState';
import styles from './EditorWorkbench.module.css';

export interface EditorWorkbenchProps {
  readonly dashboardId: string;
  readonly initialSnapshot: DashboardSnapshot;
  readonly initialRevisionId: string;
  readonly initialLease: EditorLease | null;
  readonly heartbeatSeconds: number;
  readonly metrics: readonly SemanticDefinitionRef[];
  readonly projectId: string;
  readonly widgetTemplates: readonly TemplateSummary[];
  readonly canPublish: boolean;
}

/**
 * The editor (D3).
 *
 * Canvas in the middle, contextual Inspector on the right, gallery above. What
 * the editor does NOT have is a save button: the draft autosaves, and publish
 * is a separate, deliberate act that produces an immutable version.
 *
 * The distinction is the whole point of the screen. Saving changes nothing for
 * viewers; publishing is the only thing that does.
 */
export function EditorWorkbench({
  dashboardId,
  initialSnapshot,
  initialRevisionId,
  initialLease,
  heartbeatSeconds,
  metrics,
  projectId,
  widgetTemplates,
  canPublish,
}: EditorWorkbenchProps) {
  const t = useTranslations('editor');
  const router = useRouter();

  const editor = useEditorState({
    dashboardId,
    initialSnapshot,
    initialRevisionId,
    initialLease,
    heartbeatSeconds,
  });

  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impact, setImpact] = useState<PublishImpact | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<number | null>(null);

  const lockedByOther = editor.lease !== null && !editor.lease.heldByCaller;

  function addWidget(widget: WidgetConfig) {
    editor.commit({ ...editor.snapshot, widgets: [...editor.snapshot.widgets, widget] });
    setSelectedId(widget.id);
  }

  function removeWidget(widgetId: string) {
    editor.commit({
      ...editor.snapshot,
      widgets: editor.snapshot.widgets.filter((widget) => widget.id !== widgetId),
    });
    setSelectedId(null);
  }

  async function reviewPublish() {
    editor.saveNow();
    setImpact(await publishImpactAction(dashboardId));
  }

  async function confirmPublish() {
    setPublishing(true);
    try {
      const result = await publishAction(dashboardId);
      if (result.status === 'published') {
        setPublished(result.version ?? null);
        setImpact(null);
        router.refresh();
      } else {
        setImpact(await publishImpactAction(dashboardId));
      }
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="stack">
      {/*
        Who is editing. A takeover ends someone else's session, so it is a
        deliberate button with a name on it, not an automatic recovery.
      */}
      {lockedByOther ? (
        <Callout tone="warning" title={t('lockedTitle', { name: editor.lease!.userName })}>
          <div className="stack stack--tight">
            <span>{t('lockedBody')}</span>
            <div>
              <Button type="button" onClick={editor.takeOver}>
                {t('takeOver')}
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}

      {editor.saveStatus === 'conflict' ? (
        <Callout tone="critical" title={t('conflictTitle')} live>
          <div className="stack stack--tight">
            <span>{editor.saveMessage ?? t('conflictBody')}</span>
            <div>
              <Button type="button" onClick={() => router.refresh()}>
                {t('reload')}
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}

      {published !== null ? (
        <Callout tone="success" title={t('publishedTitle', { version: published })} live>
          <Link href={`/dashboards/${dashboardId}`}>{t('openViewer')}</Link>
        </Callout>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.group} role="group" aria-label={t('breakpoint')}>
          {BREAKPOINTS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={styles.toggle}
              aria-pressed={candidate === breakpoint}
              onClick={() => setBreakpoint(candidate)}
            >
              {t(candidate)}
            </button>
          ))}
        </div>

        <div className={styles.group}>
          <Button type="button" onClick={editor.undo} disabled={!editor.canUndo}>
            {t('undo')}
          </Button>
          <Button type="button" onClick={editor.redo} disabled={!editor.canRedo}>
            {t('redo')}
          </Button>
        </div>

        {/*
          Autosave state as words. "Saved" and "saving" are different facts and
          a spinner alone says neither (D10).
        */}
        <span className={styles.status} role="status">
          {t(`saveStatus.${editor.saveStatus}`)}
        </span>

        <div className={styles.group}>
          <Link href={`/dashboards/${dashboardId}?source=draft`} className={styles.previewLink}>
            {t('preview')}
          </Link>
          {canPublish ? (
            <Button type="button" variant="primary" onClick={reviewPublish}>
              {t('reviewPublish')}
            </Button>
          ) : null}
        </div>
      </div>

      {impact ? (
        <PublishReview
          impact={impact}
          publishing={publishing}
          onCancel={() => setImpact(null)}
          onConfirm={confirmPublish}
        />
      ) : null}

      <div className={styles.workbench}>
        <div className="stack">
          <WidgetGallery
            snapshot={editor.snapshot}
            metrics={metrics}
            projectId={projectId}
            widgetTemplates={widgetTemplates}
            onAdd={addWidget}
          />
          <EditorCanvas
            snapshot={editor.snapshot}
            breakpoint={breakpoint}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={editor.commit}
          />
        </div>

        <Inspector
          snapshot={editor.snapshot}
          breakpoint={breakpoint}
          selectedId={selectedId}
          onChange={editor.commit}
          onRemove={removeWidget}
        />
      </div>
    </div>
  );
}

/**
 * What publishing would change, before it happens (D3).
 *
 * Blocking errors and warnings are shown apart and styled apart, because one
 * stops the publish and the other only informs. Collapsing them would make
 * publishing either unsafe or needlessly obstructive.
 */
function PublishReview({
  impact,
  publishing,
  onCancel,
  onConfirm,
}: {
  readonly impact: PublishImpact;
  readonly publishing: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useTranslations('editor');
  const tKeys = useTranslations();

  const message = (key: string, params?: Record<string, string | number>) =>
    tKeys.has(key) ? tKeys(key, params as never) : key;

  return (
    <section className={styles.publish} aria-label={t('publishReview')}>
      <h2 className={styles.publishHeading}>{t('publishReview')}</h2>

      <dl className={styles.changes}>
        <div>
          <dt>{t('added')}</dt>
          <dd>{impact.addedWidgetIds.length}</dd>
        </div>
        <div>
          <dt>{t('changed')}</dt>
          <dd>{impact.changedWidgetIds.length}</dd>
        </div>
        <div>
          <dt>{t('removed')}</dt>
          <dd>{impact.removedWidgetIds.length}</dd>
        </div>
      </dl>

      {impact.blockingErrors.length > 0 ? (
        <Callout tone="critical" title={t('blockingTitle')}>
          <ul className={styles.issues}>
            {impact.blockingErrors.map((issue, index) => (
              <li key={`${issue.messageKey}-${index}`}>
                {message(issue.messageKey, issue.messageParams)}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {impact.warnings.length > 0 ? (
        <Callout tone="warning" title={t('warningTitle')}>
          <ul className={styles.issues}>
            {impact.warnings.map((issue, index) => (
              <li key={`${issue.messageKey}-${index}`}>
                {message(issue.messageKey, issue.messageParams)}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="row">
        <Button
          type="button"
          variant="primary"
          disabled={!impact.canPublish}
          busy={publishing}
          busyLabel={t('publishing')}
          onClick={onConfirm}
        >
          {t('publishNow')}
        </Button>
        <Button type="button" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </section>
  );
}
