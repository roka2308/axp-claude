import { getFormatter, getTranslations } from 'next-intl/server';
import { Callout, Card, DataTable } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { DiagnosticsPanel } from '@/components/theming/DiagnosticsPanel';
import { getSystemOverview } from '@/lib/theming';

/**
 * Administration → System (D1, Master Spec §24), for platform administrators.
 *
 * Release and schema metadata, compatibility, health, job states and the
 * installation's providers and feature flags - and the sanitised diagnostic
 * bundle an operator hands to support.
 */
export default async function SystemPage() {
  const t = await getTranslations();
  const format = await getFormatter();

  return (
    <AdminFrame section="system">
      {async ({ context }) => {
        if (!context.platformAdmin) {
          return <Callout tone="warning">{t('system.notAllowed')}</Callout>;
        }
        const system = await getSystemOverview();
        const when = (iso: string | null) =>
          iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—';

        return (
          <div className="stack stack--loose">
            <div className="stack stack--tight">
              <h2>{t('system.title')}</h2>
              <p className="text-secondary">{t('system.intro')}</p>
            </div>

            <Card title={t('system.release.title')}>
              <dl className="stack stack--tight">
                {(
                  [
                    ['productVersion', system.release.productVersion],
                    ['schemaVersion', system.release.schemaVersion],
                    [
                      'migrations',
                      t('system.release.migrationsValue', {
                        count: system.release.appliedMigrations,
                        last: when(system.release.lastMigrationAt),
                      }),
                    ],
                    ['commit', system.release.commit],
                    ['builtAt', system.release.builtAt],
                    ['supportStatus', t(`system.support.${system.release.supportStatus}`)],
                    ['deploymentProfile', system.release.deploymentProfile],
                    ['appEnv', system.release.appEnv],
                    ['nodeVersion', system.release.nodeVersion],
                  ] as const
                ).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-muted">{t(`system.release.${key}`)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card
              title={t('system.compatibility.title')}
              description={t('system.compatibility.model')}
            >
              <p>
                {t('system.compatibility.packages', {
                  versions: system.compatibility.solutionPackageSchemas.join(', '),
                })}
              </p>
              {system.compatibility.matomoConnections.length === 0 ? (
                <p className="text-muted">{t('system.compatibility.none')}</p>
              ) : (
                <DataTable
                  caption={t('system.compatibility.title')}
                  captionHidden
                  columns={[
                    { key: 'tenant', label: t('system.compatibility.tenant') },
                    { key: 'compatibility', label: t('system.compatibility.state') },
                    { key: 'version', label: t('system.compatibility.version') },
                    { key: 'checked', label: t('system.compatibility.checked') },
                    { key: 'limitations', label: t('system.compatibility.limitations') },
                  ]}
                  rows={system.compatibility.matomoConnections.map((entry, index) => ({
                    key: `${entry.tenant}-${index}`,
                    cells: {
                      tenant: entry.tenant,
                      compatibility: entry.compatibility,
                      version: entry.version ?? '—',
                      checked: when(entry.checkedAt),
                      limitations:
                        entry.limitations.length === 0 ? '—' : entry.limitations.join(', '),
                    },
                  }))}
                />
              )}
            </Card>

            <Card title={t('system.runtime.title')}>
              <ul className="stack stack--tight">
                {system.health.map((entry) => (
                  <li key={entry.name}>
                    {entry.name}: {t(`system.runtime.health.${entry.status}`)}
                    {entry.latencyMs !== undefined ? ` (${Math.round(entry.latencyMs)} ms)` : ''}
                  </li>
                ))}
                <li>
                  {t('system.runtime.jobs')}:{' '}
                  {Object.entries(system.jobs).length === 0
                    ? '—'
                    : Object.entries(system.jobs)
                        .map(([status, count]) => `${status} ${count}`)
                        .join(', ')}
                </li>
                <li>
                  {t('system.runtime.providers')}:{' '}
                  {Object.entries(system.providers)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(', ')}
                </li>
                <li>
                  {t('system.runtime.flags')}:{' '}
                  {system.featureFlags
                    .map(
                      (flag) =>
                        `${flag.flag} – ${flag.enabled ? t('system.runtime.on') : t('system.runtime.off')}`,
                    )
                    .join(', ')}
                </li>
              </ul>
            </Card>

            <Card title={t('system.diagnostics.title')}>
              <DiagnosticsPanel />
              {system.bundles.length > 0 ? (
                <ul className="stack stack--tight">
                  {system.bundles.map((bundle) => (
                    <li key={bundle.id}>
                      {t('system.diagnostics.line', {
                        file: bundle.fileName,
                        by: bundle.createdBy ?? '—',
                        expires: when(bundle.expiresAt),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </div>
        );
      }}
    </AdminFrame>
  );
}
