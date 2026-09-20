import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getProject, listDashboards } from '@/lib/analytics';
import { logoutAction } from '@/app/login/actions';
import styles from './project.module.css';

interface ProjectPageProps {
  readonly params: Promise<{ readonly projectId: string }>;
}

/**
 * Project overview (Master Spec §13).
 *
 * Shows the resumable setup checklist and the project's dashboards. The
 * checklist is derived from what is actually configured, so it stays honest
 * regardless of how a project was set up.
 */
export default async function ProjectPage({ params }: ProjectPageProps) {
  const t = await getTranslations();
  const { projectId } = await params;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const [detail, dashboards] = await Promise.all([
    getProject(projectId),
    listDashboards(projectId),
  ]);

  return (
    <AppShell
      activeKey="projects"
      version={version}
      headerEnd={
        <form action={logoutAction}>
          <Button type="submit" variant="ghost">
            {t('login.signOut')}
          </Button>
        </form>
      }
    >
      <div className="stack stack--loose">
        <div className="stack stack--tight">
          <Link href="/projects" className={styles.back}>
            {t('projects.backToList')}
          </Link>
          <h1>{detail.project.name}</h1>
          <p className="text-secondary">
            {detail.project.tenantName} ·{' '}
            {t('project.timezone', { timezone: detail.project.timezone })}
          </p>
        </div>

        <Card
          title={t('project.setupTitle')}
          description={t(`setupReadinessDescription.${detail.setup.readiness}`)}
        >
          <ol className={styles.checklist}>
            {detail.setup.steps.map((step) => (
              <li key={step.key} className={styles.step} data-state={step.state}>
                <span className={styles.stepState}>{t(`setupStepState.${step.state}`)}</span>
                <span className={styles.stepLabel}>
                  {t(step.key)}
                  {step.required ? null : (
                    <span className={styles.optional}> · {t('project.optionalStep')}</span>
                  )}
                </span>
                {step.detail ? <span className={styles.stepDetail}>{step.detail}</span> : null}
              </li>
            ))}
          </ol>
        </Card>

        <Card title={t('project.dataSourceTitle')}>
          {detail.sites.length === 0 ? (
            <Callout tone="warning" title={t('project.noSiteTitle')}>
              {t('project.noSiteBody')}
            </Callout>
          ) : (
            <ul className="stack stack--tight">
              {detail.sites.map((site) => (
                <li key={site.id}>
                  <strong>{site.name}</strong>{' '}
                  <span className="text-muted">
                    {t('project.siteMeta', {
                      timezone: site.timezone,
                      matomoSiteId: site.matomoSiteId,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t('project.dashboardsTitle')}>
          {dashboards.length === 0 ? (
            <p className="text-muted">{t('project.noDashboards')}</p>
          ) : (
            <ul className="stack stack--tight">
              {dashboards.map((dashboard) => (
                <li key={dashboard.id} className={styles.dashboardRow}>
                  <Link href={`/dashboards/${dashboard.id}`} className={styles.dashboardName}>
                    {dashboard.name}
                  </Link>
                  <span className="text-muted">
                    {dashboard.publishedVersion === null
                      ? t('project.notPublished')
                      : t('project.publishedVersion', { version: dashboard.publishedVersion })}
                    {dashboard.hasUnpublishedChanges ? ` · ${t('project.unpublishedChanges')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
