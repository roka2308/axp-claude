'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import { Button } from '@axp/ui';
import { deleteReportAction, pauseReportAction, runReportNowAction } from '@/app/reporting/actions';
import styles from './reporting.module.css';

/** What can be done with one schedule: send now, pause or resume, edit, delete. */
export function ScheduleActions({
  projectId,
  scheduleId,
  paused,
}: {
  readonly projectId: string;
  readonly scheduleId: string;
  readonly paused: boolean;
}) {
  const t = useTranslations('reports');
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const act = (work: () => Promise<{ status: string; message?: string }>, done: string) =>
    startTransition(async () => {
      const outcome = await work();
      setMessage(
        outcome.status === 'ok'
          ? { tone: 'ok', text: done }
          : { tone: 'error', text: outcome.message ?? t('actions.failed') },
      );
    });

  return (
    <div className="stack stack--tight">
      <div className={styles.actions}>
        <Button
          type="button"
          disabled={pending}
          onClick={() => act(() => runReportNowAction(projectId, scheduleId), t('actions.queued'))}
        >
          {t('actions.runNow')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            act(
              () => pauseReportAction(projectId, scheduleId, !paused),
              paused ? t('actions.resumed') : t('actions.paused'),
            )
          }
        >
          {paused ? t('actions.resume') : t('actions.pause')}
        </Button>
        <Link
          href={`/projects/${projectId}/reports?edit=${scheduleId}` as Route}
          className={styles.link}
        >
          {t('actions.edit')}
        </Link>
        <Link
          href={`/projects/${projectId}/reports?schedule=${scheduleId}` as Route}
          className={styles.link}
        >
          {t('actions.history')}
        </Link>
        {confirming ? (
          <span className={styles.actions} role="group" aria-label={t('actions.confirmLabel')}>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() =>
                act(() => deleteReportAction(projectId, scheduleId), t('actions.deleted'))
              }
            >
              {t('actions.confirmDelete')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {t('actions.cancel')}
            </Button>
          </span>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
            {t('actions.delete')}
          </Button>
        )}
      </div>
      <p aria-live="polite" className={message?.tone === 'error' ? styles.fieldError : styles.hint}>
        {message?.text ?? ''}
      </p>
    </div>
  );
}
