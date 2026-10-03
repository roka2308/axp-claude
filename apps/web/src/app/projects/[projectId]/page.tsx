import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { CompatibilityReport } from '@/components/setup/CompatibilityReport';
import { DashboardActions } from '@/components/setup/DashboardActions';
import { ApiError } from '@/lib/api-client';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getProject, listDashboards } from '@/lib/analytics';
import { listConnections, type ConnectionWithCapabilities } from '@/lib/matomo';
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

  const detail = await getProject(projectId);

  /*
   * Roles are additive, so "may open this project" and "may see its
   * dashboards" are different answers, and a tenant administrator legitimately
   * has the first without the second. Each section asks for what it needs and
   * explains its absence, rather than the page failing as a whole
   * (Master Spec §7, D10).
   */
  const canAdminister = detail.capabilities.includes('tenant.settings.update');
  const canReadDashboards = detail.capabilities.includes('dashboard.read_published');
  const canPublish = detail.capabilities.includes('dashboard.publish');
  const canPreview = detail.capabilities.includes('dashboard.edit_draft');
  const canReadSemantics = detail.capabilities.includes('semantic.read');
  const canManageReports = detail.capabilities.includes('report.manage');

  const [dashboards, connections] = await Promise.all([
    canReadDashboards ? listDashboards(projectId) : Promise.resolve([]),
    canAdminister ? listConnectionsIfPermitted(detail.project.tenantId) : Promise.resolve(null),
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
          actions={
            !canAdminister ? null : (
              <Link href={`/projects/${projectId}/setup`} className={styles.setupCta}>
                {t('project.setupCta')}
              </Link>
            )
          }
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

        {connections === null ? null : (
          <Card title={t('project.matomoTitle')}>
            {connections.length === 0 ? (
              <Callout tone="warning" title={t('project.noConnectionTitle')}>
                {t('project.noConnectionBody')}
              </Callout>
            ) : (
              <div className="stack stack--loose">
                {connections.map((connection) => (
                  <section key={connection.id} className="stack stack--tight">
                    <div>
                      <strong>{connection.name}</strong>{' '}
                      <span className="text-muted">{connection.baseUrl}</span>
                    </div>
                    {connection.capabilities ? (
                      <CompatibilityReport
                        compatibility={connection.capabilities.compatibility}
                        matomoVersion={connection.capabilities.matomoVersion}
                        probes={connection.capabilities.probes}
                        limitationKeys={connection.capabilities.limitationKeys}
                        detectedAt={connection.capabilities.detectedAt}
                        siteCount={connection.capabilities.siteCount}
                        compact
                      />
                    ) : null}
                  </section>
                ))}
              </div>
            )}
          </Card>
        )}

        {canReadSemantics ? (
          <Card title={t('semantics.title')} description={t('semantics.subtitle')}>
            <Link href={`/projects/${projectId}/semantics`} className={styles.setupCta}>
              {t('project.openSemantics')}
            </Link>
          </Card>
        ) : null}

        {canManageReports ? (
          // Projekt → Reports (D1): scheduled delivery of published dashboards.
          <Card title={t('reports.title')} description={t('reports.projectCardBody')}>
            <Link href={`/projects/${projectId}/reports`} className={styles.setupCta}>
              {t('reports.open')}
            </Link>
          </Card>
        ) : null}

        <Card title={t('project.dashboardsTitle')}>
          {!canReadDashboards ? (
            <Callout tone="info" title={t('project.dashboardsNotYoursTitle')}>
              {t('project.dashboardsNotYoursBody')}
            </Callout>
          ) : dashboards.length === 0 ? (
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
                  <DashboardActions
                    dashboardId={dashboard.id}
                    canPreview={canPreview}
                    canPublish={canPublish}
                    hasUnpublishedChanges={dashboard.hasUnpublishedChanges}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * Reads the tenant's Matomo connections, or `null` when the caller may not.
 *
 * Distinguishes "no permission" from "none configured": the first hides the
 * section, the second shows a setup prompt. Any other failure still throws -
 * silently swallowing it would leave a page that quietly lies.
 */
async function listConnectionsIfPermitted(
  tenantId: string,
): Promise<ConnectionWithCapabilities[] | null> {
  try {
    return await listConnections(tenantId);
  } catch (error) {
    if (error instanceof ApiError && error.body.category === 'permission_denied') return null;
    throw error;
  }
}
