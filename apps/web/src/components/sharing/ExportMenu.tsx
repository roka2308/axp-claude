'use client';

import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type {
  ComparisonMode,
  ExportArtifactSummary,
  ExportFormat,
  TimeRangePreset,
} from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import type { AdminOutcome } from '@/app/admin/outcome';
import styles from './ExportMenu.module.css';

type ExportResult = ExportArtifactSummary & { downloadHref: string };

export interface ExportMenuProps {
  /** The server action, already bound to the dashboard or the share. */
  readonly action: (input: {
    format: ExportFormat;
    widgetId?: string;
    timeRange?: TimeRangePreset;
    comparison?: ComparisonMode;
  }) => Promise<AdminOutcome<ExportResult>>;
  readonly formats: readonly ExportFormat[];
  /** The state on screen, which is what the file will show. */
  readonly timeRange: TimeRangePreset;
  readonly comparison: ComparisonMode;
  /** Shown to the person: "Letzte 7 Tage · Vorperiode". */
  readonly stateLabel: string;
  readonly widgetId?: string;
  readonly idPrefix: string;
}

/**
 * Export the current view (Master Spec §15).
 *
 * The file shows exactly what is on screen: the period and comparison are
 * passed along and named next to the button, so nobody wonders which view
 * they are about to get. The download starts by itself; the link stays for
 * anyone whose browser blocked it, together with how long it is valid.
 */
export function ExportMenu({
  action,
  formats,
  timeRange,
  comparison,
  stateLabel,
  widgetId,
  idPrefix,
}: ExportMenuProps) {
  const t = useTranslations('export');
  const [format, setFormat] = useState<ExportFormat>(formats[0]!);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<AdminOutcome<ExportResult> | null>(null);
  const link = useRef<HTMLAnchorElement>(null);

  const run = () =>
    startTransition(async () => {
      setResult(null);
      const outcome = await action({
        format,
        ...(widgetId ? { widgetId } : {}),
        timeRange,
        comparison,
      });
      setResult(outcome);
      if (outcome.status === 'ok' && outcome.data) {
        // Start the download; the visible link below remains the fallback.
        requestAnimationFrame(() => link.current?.click());
      }
    });

  const selectId = `${idPrefix}-export-format`;
  const done = result?.status === 'ok' ? result.data : undefined;

  return (
    <div className={styles.menu}>
      <div className={styles.row}>
        {formats.length > 1 ? (
          <div className={styles.field}>
            <label htmlFor={selectId} className={styles.label}>
              {t('format')}
            </label>
            <select
              id={selectId}
              className={styles.select}
              value={format}
              onChange={(event) => setFormat(event.target.value as ExportFormat)}
            >
              {formats.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`formats.${entry}`)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Button
          type="button"
          onClick={run}
          disabled={pending}
          aria-describedby={`${idPrefix}-export-state`}
        >
          {pending
            ? t('creating')
            : formats.length > 1
              ? t('create')
              : t('createOne', { format: t(`formats.${formats[0]!}`) })}
        </Button>
      </div>
      <p id={`${idPrefix}-export-state`} className={styles.state}>
        {t('currentView', { state: stateLabel })}
      </p>

      <div aria-live="polite" className={styles.status}>
        {pending ? <span>{t('creatingLong')}</span> : null}
        {done ? (
          <Callout tone="success" title={t('readyTitle')}>
            <a
              ref={link}
              href={done.downloadHref}
              download={done.fileName}
              className={styles.download}
            >
              {t('download', { file: done.fileName })}
            </a>{' '}
            {t('validUntil', {
              time: new Date(done.expiresAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </Callout>
        ) : null}
        {result?.status === 'error' ? (
          <Callout tone="critical" title={t('failedTitle')}>
            {result.message}
          </Callout>
        ) : null}
      </div>
    </div>
  );
}
