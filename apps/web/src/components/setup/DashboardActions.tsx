import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@axp/ui';
import { publishDashboardAction } from '@/app/projects/[projectId]/setup/publish-action';
import styles from './DashboardActions.module.css';

export interface DashboardActionsProps {
  readonly dashboardId: string;
  readonly canPreview: boolean;
  readonly canPublish: boolean;
  readonly hasUnpublishedChanges: boolean;
}

/**
 * Preview and publish, beside a dashboard in the project list.
 *
 * Only rendered for capabilities the server said the caller holds. Publishing
 * is offered when the draft differs from what is published, because publishing
 * an unchanged draft is a no-op that only produces a confusing new version
 * number (Master Spec §21).
 *
 * The editor is a page of its own; these are the entry points to it from the
 * project list, where a reader is deciding which dashboard to work on.
 */
export async function DashboardActions({
  dashboardId,
  canPreview,
  canPublish,
  hasUnpublishedChanges,
}: DashboardActionsProps) {
  const t = await getTranslations('project');
  if (!canPreview && !canPublish) return null;

  return (
    <span className={styles.actions}>
      {canPreview ? (
        <>
          <Link href={`/dashboards/${dashboardId}/edit`} className={styles.link}>
            {t('editDashboard')}
          </Link>
          <Link href={`/dashboards/${dashboardId}?source=draft`} className={styles.link}>
            {t('previewDraft')}
          </Link>
        </>
      ) : null}

      {canPublish && hasUnpublishedChanges ? (
        <form action={publishDashboardAction.bind(null, dashboardId)}>
          <Button type="submit">{t('publish')}</Button>
        </form>
      ) : null}
    </span>
  );
}
