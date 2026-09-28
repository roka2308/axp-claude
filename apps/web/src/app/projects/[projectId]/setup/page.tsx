import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { DISMISSABLE_SETUP_STEPS } from '@axp/contracts';
import { getTranslations } from 'next-intl/server';
import type { SelectOption } from '@axp/ui';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { CompatibilityReport } from '@/components/setup/CompatibilityReport';
import { ContextProfileForm } from '@/components/setup/ContextProfileForm';
import { StepRelevanceToggle } from '@/components/setup/StepRelevanceToggle';
import { DashboardCreateForm } from '@/components/setup/DashboardCreateForm';
import { MatomoConnectionForm } from '@/components/setup/MatomoConnectionForm';
import { SiteAssignmentForm } from '@/components/setup/SiteAssignmentForm';
import { getProject } from '@/lib/analytics';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { listConnections, listRemoteSites, type ConnectionWithCapabilities } from '@/lib/matomo';
import { logoutAction } from '@/app/login/actions';
import {
  assignSiteAction,
  createDashboardAction,
  refreshCapabilitiesAction,
  submitConnectionAction,
} from './actions';
import styles from './setup.module.css';

interface SetupPageProps {
  readonly params: Promise<{ readonly projectId: string }>;
}

/**
 * Resumable project setup (Master Spec §13).
 *
 * One page with three sections rather than a wizard: the steps have a natural
 * order but no forced one, each commits on its own, and the page can be left
 * and returned to at any point. What is already done is shown as done, derived
 * from the configuration itself rather than from a stored wizard position.
 */
export default async function ProjectSetupPage({ params }: SetupPageProps) {
  const t = await getTranslations();
  const { projectId } = await params;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const detail = await getProject(projectId);

  /*
   * Roles are additive and not hierarchical, so the three steps are not one
   * permission: a tenant administrator connects Matomo and assigns the site,
   * a dashboard editor creates the dashboard. Each section is gated on the
   * capability it actually needs, and a caller who lacks one is told which
   * rather than shown an empty page (Master Spec §7, D10).
   */
  const canConnect = detail.capabilities.includes('tenant.settings.update');
  const canAssignSite = detail.capabilities.includes('project.settings.update');
  const canCreateDashboard = detail.capabilities.includes('dashboard.create');

  if (!canConnect && !canAssignSite && !canCreateDashboard) {
    return (
      <AppShell activeKey="projects" version={version}>
        <div className="stack">
          <Callout tone="warning" title={t('projectSetup.permissionTitle')}>
            {t('projectSetup.permissionBody')}
          </Callout>
          <Link href={`/projects/${projectId}`}>{t('projectSetup.backToProject')}</Link>
        </div>
      </AppShell>
    );
  }

  const connections: ConnectionWithCapabilities[] = canConnect
    ? await listConnections(detail.project.tenantId)
    : [];

  // One failing connection must not take the page down with it.
  const remoteSites = await Promise.allSettled(
    connections.map(async (connection) => ({
      connection,
      sites: await listRemoteSites(detail.project.tenantId, connection.id),
    })),
  );

  const siteOptions: SelectOption[] = remoteSites.flatMap((result) =>
    result.status !== 'fulfilled'
      ? []
      : result.value.sites.map((site) => ({
          value: `${result.value.connection.id}:${site.matomoSiteId}`,
          label: site.name,
          detail: `${site.timezone} · ${result.value.connection.name}`,
        })),
  );

  const assignedSites: SelectOption[] = detail.sites.map((site) => ({
    value: site.id,
    label: site.name,
    detail: site.timezone,
  }));

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
        <header className="stack stack--tight">
          <Link href={`/projects/${projectId}`} className={styles.back}>
            {t('projectSetup.backToProject')}
          </Link>
          <h1>{t('projectSetup.title')}</h1>
          <p className="text-secondary">
            {detail.project.name} · {t('projectSetup.subtitle')}
          </p>
        </header>

        <Card
          title={t('project.setupTitle')}
          description={t(`setupReadinessDescription.${detail.setup.readiness}`)}
        >
          <ol className={styles.checklist}>
            {detail.setup.steps.map((step) => (
              <li key={step.key} className={styles.step} data-state={step.state}>
                <span className={styles.stepState}>{t(`setupStepState.${step.state}`)}</span>
                <span className="stack stack--tight">
                  <span>
                    {t(step.key)}
                    <span className="text-muted">
                      {' · '}
                      {t(`setupStepCategory.${step.category}`)}
                      {step.detail ? ` · ${step.detail}` : ''}
                    </span>
                  </span>
                  {step.step === 'mapping' &&
                  step.state !== 'done' &&
                  step.state !== 'not_relevant' ? (
                    <Link href={`/projects/${projectId}/semantics`}>
                      {t('projectSetup.toMapping')}
                    </Link>
                  ) : null}
                  {canAssignSite &&
                  DISMISSABLE_SETUP_STEPS.includes(step.step) &&
                  step.state !== 'done' ? (
                    <StepRelevanceToggle
                      projectId={projectId}
                      step={step.step}
                      notRelevant={step.state === 'not_relevant'}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title={t('contextProfile.title')} description={t('contextProfile.description')}>
          <ContextProfileForm
            projectId={projectId}
            initial={detail.project.contextProfile}
            readOnly={!canAssignSite}
          />
        </Card>

        {/* Step 1 - the Matomo installation itself. */}
        <Card
          title={t('projectSetup.connectionSectionTitle')}
          description={t('projectSetup.connectionSectionBody')}
        >
          <div className="stack stack--loose">
            {!canConnect ? (
              <Callout tone="info" title={t('projectSetup.sectionNotYoursTitle')}>
                {t('projectSetup.connectionNotYoursBody')}
              </Callout>
            ) : connections.length === 0 ? (
              <p className="text-muted">{t('projectSetup.noConnections')}</p>
            ) : (
              <section className="stack" aria-label={t('projectSetup.existingConnections')}>
                <h3 className={styles.subheading}>{t('projectSetup.existingConnections')}</h3>
                {connections.map((connection) => (
                  <article key={connection.id} className={styles.connection}>
                    <header className={styles.connectionHeader}>
                      <div className="stack stack--tight">
                        <strong>{connection.name}</strong>
                        <span className="text-muted">{connection.baseUrl}</span>
                        <span className="text-muted">
                          {connection.lastTestedAt
                            ? t('projectSetup.lastTested', {
                                when: new Date(connection.lastTestedAt).toLocaleString(),
                              })
                            : t('projectSetup.neverTested')}
                        </span>
                      </div>
                      <form action={refreshCapabilitiesAction.bind(null, projectId, connection.id)}>
                        <Button type="submit">{t('projectSetup.refreshCapabilities')}</Button>
                      </form>
                    </header>

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
                  </article>
                ))}
              </section>
            )}

            {canConnect ? (
              <MatomoConnectionForm action={submitConnectionAction.bind(null, projectId)} />
            ) : null}
          </div>
        </Card>

        {/* Step 2 - which site this project reads. */}
        <Card
          title={t('projectSetup.siteSectionTitle')}
          description={t('projectSetup.siteSectionBody')}
        >
          <div className="stack stack--loose">
            <section aria-label={t('projectSetup.assignedSites')}>
              <h3 className={styles.subheading}>{t('projectSetup.assignedSites')}</h3>
              {detail.sites.length === 0 ? (
                <p className="text-muted">{t('projectSetup.noAssignedSites')}</p>
              ) : (
                <ul className={styles.siteList}>
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
            </section>

            {canAssignSite ? (
              <SiteAssignmentForm
                action={assignSiteAction.bind(null, projectId)}
                options={siteOptions}
              />
            ) : (
              <Callout tone="info" title={t('projectSetup.sectionNotYoursTitle')}>
                {t('projectSetup.siteNotYoursBody')}
              </Callout>
            )}
          </div>
        </Card>

        {/* A ready-made start: a solution, then a dashboard from its template. */}
        <Card
          title={t('projectSetup.solutionsTitle')}
          description={t('projectSetup.solutionsBody')}
        >
          <Link href={`/templates?project=${projectId}&tab=solutions` as Route}>
            {t('projectSetup.toSolutions')}
          </Link>
        </Card>

        {/* Step 3 - something to look at. */}
        <Card
          title={t('projectSetup.dashboardSectionTitle')}
          description={t('projectSetup.dashboardSectionBody')}
        >
          {canCreateDashboard ? (
            <DashboardCreateForm
              action={createDashboardAction.bind(null, projectId)}
              sites={assignedSites}
            />
          ) : (
            <Callout tone="info" title={t('projectSetup.sectionNotYoursTitle')}>
              {t('projectSetup.dashboardNotYoursBody')}
            </Callout>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
