import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { type TenantLifecycle, TENANT_LIFECYCLE_STATES } from '@axp/contracts';
import { Callout, Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { LifecycleConfirm } from '@/components/admin/TenantForms';
import { getLifecycleImpact, getTenant } from '@/lib/admin';
import styles from '../../admin.module.css';

const TABS = [
  'overview',
  'projects',
  'people',
  'theme',
  'entitlements',
  'connections',
  'diagnostics',
  'lifecycle',
] as const;
type Tab = (typeof TABS)[number];

/** Tabs whose content belongs to a later milestone of the plan. */
const LATER: Partial<Record<Tab, number>> = {
  theme: 9,
  entitlements: 9,
  diagnostics: 9,
};

interface PageProps {
  readonly params: Promise<{ readonly tenantId: string }>;
  readonly searchParams: Promise<{
    readonly tab?: string;
    readonly to?: string;
    readonly changed?: string;
  }>;
}

/**
 * Tenant Detail (D5), for the Platform Admin.
 *
 * Lifecycle actions live in their own tab, apart from everything else, and each
 * goes through impact preview, typed confirmation and a fresh password.
 */
export default async function TenantPage({ params, searchParams }: PageProps) {
  const { tenantId } = await params;
  const { tab: requestedTab, to, changed } = await searchParams;
  const tab: Tab = TABS.find((entry) => entry === requestedTab) ?? 'overview';
  const t = await getTranslations();

  return (
    <AdminFrame section="tenants">
      {async ({ context }) => {
        if (!context.platformAdmin) {
          return <Callout tone="warning">{t('administration.tenants.notAllowed')}</Callout>;
        }
        const tenant = await getTenant(tenantId);
        const administers = context.tenants.some((entry) => entry.id === tenant.id);
        const target = TENANT_LIFECYCLE_STATES.find(
          (state): state is TenantLifecycle =>
            state === to && tenant.allowedTransitions.includes(state),
        );
        const impact =
          tab === 'lifecycle' && target ? await getLifecycleImpact(tenant.id, target) : null;
        const tabHref = (entry: Tab) => `/admin/tenants/${tenant.id}?tab=${entry}` as Route;

        return (
          <div className="stack stack--loose">
            <div className="stack stack--tight">
              <Link href="/admin/tenants">{t('administration.tenants.back')}</Link>
              <h2>{tenant.name}</h2>
              <p className="text-secondary">
                {t('administration.tenants.stateLine', {
                  state: t(`administration.tenants.state.${tenant.lifecycle}`),
                })}
              </p>
            </div>

            <nav aria-label={t('administration.tenants.tabs')}>
              <ul className={styles.tabs}>
                {TABS.map((entry) => (
                  <li key={entry}>
                    <Link
                      href={tabHref(entry)}
                      className={styles.tab}
                      aria-current={entry === tab ? 'page' : undefined}
                    >
                      {t(`administration.tenants.tab.${entry}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {LATER[tab] ? (
              <Callout tone="info" title={t(`administration.tenants.tab.${tab}`)}>
                {t('administration.tenants.later', { phase: LATER[tab] })}
              </Callout>
            ) : null}

            {tab === 'overview' ? (
              <Card title={t('administration.tenants.tab.overview')}>
                <dl className={styles.facts}>
                  <dt>{t('administration.tenants.slug')}</dt>
                  <dd>{tenant.slug}</dd>
                  <dt>{t('administration.tenants.portableId')}</dt>
                  <dd>
                    <code>{tenant.portableId}</code>
                  </dd>
                  <dt>{t('administration.tenants.defaultLocale')}</dt>
                  <dd>{tenant.defaultLocale === 'en' ? 'English' : 'Deutsch'}</dd>
                  <dt>{t('administration.tenants.columnProjects')}</dt>
                  <dd>{tenant.projects}</dd>
                  <dt>{t('administration.tenants.dashboards')}</dt>
                  <dd>{tenant.dashboards}</dd>
                  <dt>{t('administration.tenants.columnUsers')}</dt>
                  <dd>{tenant.users}</dd>
                  <dt>{t('administration.tenants.groups')}</dt>
                  <dd>{tenant.groups}</dd>
                </dl>
                <p className="text-muted">{t('administration.tenants.noDataAccess')}</p>
              </Card>
            ) : null}

            {tab === 'projects' ? (
              <Card title={t('administration.tenants.tab.projects')}>
                {tenant.projectList.length === 0 ? (
                  <p className="text-muted">{t('administration.tenants.noProjects')}</p>
                ) : (
                  <ul className={styles.list}>
                    {tenant.projectList.map((project) => (
                      <li key={project.id} className={styles.listItem}>
                        {project.name}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ) : null}

            {tab === 'people' ? (
              <Card title={t('administration.tenants.tab.people')}>
                <p>
                  {t('administration.tenants.peopleSummary', {
                    users: tenant.users,
                    groups: tenant.groups,
                  })}
                </p>
                {administers ? (
                  <Link href={`/admin/users?tenant=${tenant.id}` as Route}>
                    {t('administration.tenants.openPeople')}
                  </Link>
                ) : (
                  <p className="text-muted">{t('administration.tenants.peopleNeedRole')}</p>
                )}
              </Card>
            ) : null}

            {tab === 'connections' ? (
              <Card title={t('administration.tenants.tab.connections')}>
                <p>
                  {t('administration.tenants.connectionsSummary', { count: tenant.connections })}
                </p>
                <p className="text-muted">{t('administration.tenants.connectionsLater')}</p>
              </Card>
            ) : null}

            {tab === 'lifecycle' ? (
              <Card title={t('administration.tenants.tab.lifecycle')}>
                <div className="stack">
                  {changed ? (
                    <Callout tone="success" live>
                      {t('administration.tenants.lifecycle.changed', {
                        state: t(`administration.tenants.state.${tenant.lifecycle}`),
                      })}
                    </Callout>
                  ) : null}
                  <p>
                    {t('administration.tenants.stateLine', {
                      state: t(`administration.tenants.state.${tenant.lifecycle}`),
                    })}
                  </p>
                  {tenant.allowedTransitions.length === 0 ? (
                    <p className="text-muted">{t('administration.tenants.lifecycle.final')}</p>
                  ) : (
                    <ul
                      className={styles.list}
                      aria-label={t('administration.tenants.lifecycle.options')}
                    >
                      {tenant.allowedTransitions.map((state) => (
                        <li key={state}>
                          <Link
                            href={`/admin/tenants/${tenant.id}?tab=lifecycle&to=${state}` as Route}
                            aria-current={state === target ? 'true' : undefined}
                            className={styles.option}
                          >
                            {t('administration.tenants.lifecycle.moveTo', {
                              state: t(`administration.tenants.state.${state}`),
                            })}
                          </Link>
                          <span className={styles.muted}>
                            {t(`administration.tenants.lifecycle.explain.${state}`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {impact ? (
                    <section
                      className="stack"
                      aria-label={t('administration.tenants.lifecycle.impactTitle')}
                    >
                      <h3>{t('administration.tenants.lifecycle.impactTitle')}</h3>
                      <ul>
                        {impact.haltsProcessing ? (
                          <li>{t('administration.tenants.lifecycle.halts')}</li>
                        ) : null}
                        {impact.resumesProcessing ? (
                          <li>{t('administration.tenants.lifecycle.resumes')}</li>
                        ) : null}
                        <li>
                          {t('administration.tenants.lifecycle.affected', {
                            users: impact.affectedUsers,
                            dashboards: impact.dashboards,
                          })}
                        </li>
                        {impact.haltsProcessing ? (
                          <li>
                            {t('administration.tenants.lifecycle.signedOut', {
                              users: impact.usersSignedOut,
                              sessions: impact.liveSessions,
                            })}
                          </li>
                        ) : null}
                      </ul>
                      {impact.irreversible ? (
                        <Callout
                          tone="critical"
                          title={t('administration.tenants.lifecycle.irreversibleTitle')}
                        >
                          {t('administration.tenants.lifecycle.irreversibleBody')}
                        </Callout>
                      ) : null}
                      <LifecycleConfirm
                        tenantId={tenant.id}
                        to={impact.to}
                        phrase={impact.confirmationPhrase}
                        danger={impact.haltsProcessing || impact.irreversible}
                      />
                    </section>
                  ) : null}
                </div>
              </Card>
            ) : null}
          </div>
        );
      }}
    </AdminFrame>
  );
}
