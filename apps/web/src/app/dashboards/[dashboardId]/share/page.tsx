import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { CauseSurface } from '@/components/viewer/CauseSurface';
import { ShareCreateForm } from '@/components/sharing/ShareCreateForm';
import { ShareList } from '@/components/sharing/ShareList';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getDashboardLayout } from '@/lib/analytics';
import { getInternalAccess, listShares } from '@/lib/sharing';
import styles from './share.module.css';

interface SharePageProps {
  readonly params: Promise<{ readonly dashboardId: string }>;
}

/**
 * Distributing a dashboard (Master Spec §15).
 *
 * Two different things, kept apart on the page as in the product: people in
 * the organisation get access through permissions, which this page hands off
 * to; people outside get an expiring, revocable link to the published
 * dashboard, which this page creates and manages.
 */
export default async function SharePage({ params }: SharePageProps) {
  const t = await getTranslations();
  const { dashboardId } = await params;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  let loaded;
  try {
    const [layout, shares, internal] = await Promise.all([
      getDashboardLayout(dashboardId, {}),
      listShares(dashboardId),
      getInternalAccess(dashboardId),
    ]);
    loaded = { layout, shares, internal };
  } catch (error) {
    return (
      <AppShell activeKey="dashboards" version={version}>
        <CauseSurface error={error} />
      </AppShell>
    );
  }
  const { layout, shares, internal } = loaded;

  return (
    <AppShell activeKey="dashboards" version={version}>
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <Link href={`/dashboards/${dashboardId}` as Route} className={styles.back}>
            {t('share.backToDashboard')}
          </Link>
          <h1>{t('share.title', { name: layout.dashboard.name })}</h1>
          <p className="text-secondary">{t('share.intro')}</p>
        </header>

        <section className={styles.card} aria-labelledby="share-internal">
          <h2 id="share-internal" className={styles.heading}>
            {t('share.internal.title')}
          </h2>
          <p>{t('share.internal.body')}</p>
          {internal.grants.length > 0 ? (
            <ul className={styles.grants}>
              {internal.grants.map((grant) => (
                <li key={`${grant.via}-${grant.subjectType}-${grant.subjectName}`}>
                  <strong>{grant.subjectName}</strong>{' '}
                  <span className="text-muted">
                    {t(`share.internal.subject.${grant.subjectType}`)} ·{' '}
                    {t(`share.internal.access.${grant.access}`)} ·{' '}
                    {t(`share.internal.via.${grant.via}`)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{t('share.internal.none')}</p>
          )}
          {internal.canManage && internal.manageHref ? (
            <Link href={internal.manageHref as Route} className={styles.action}>
              {t('share.internal.manage')}
            </Link>
          ) : (
            <p className="text-muted">{t('share.internal.askAdmin')}</p>
          )}
        </section>

        <section className={styles.card} aria-labelledby="share-external">
          <h2 id="share-external" className={styles.heading}>
            {t('share.external.title')}
          </h2>
          <ul className={styles.promises}>
            <li>{t('share.external.promisePublished')}</li>
            <li>{t('share.external.promiseNoInternal')}</li>
            <li>{t('share.external.promiseExpiry')}</li>
            <li>{t('share.external.promiseCreator')}</li>
          </ul>

          {!shares.entitled ? (
            // Entitlement, not permission: the customer's contract lacks the
            // module. Existing links stay listed so they can still be revoked.
            <Callout tone="warning" title={t('share.external.notEntitledTitle')}>
              {t('share.external.notEntitledBody')}
            </Callout>
          ) : layout.dashboard.publishedVersion === null ? (
            <Callout tone="warning" title={t('share.external.notPublishedTitle')}>
              {t('share.external.notPublishedBody')}
            </Callout>
          ) : (
            <ShareCreateForm dashboardId={dashboardId} expiry={shares.expiry} />
          )}

          <h3 className={styles.subheading}>{t('share.list.title')}</h3>
          <ShareList dashboardId={dashboardId} shares={shares.shares} />
        </section>
      </div>
    </AppShell>
  );
}
