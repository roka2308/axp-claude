import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { Callout } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { listTenants } from '@/lib/admin';
import styles from '../admin.module.css';

/**
 * Tenants/Kunden, for the Platform Admin (D5), with its primary action
 * "Tenant anlegen".
 *
 * The list is about operating customers, not about their data: seeing a
 * tenant here never opens its analytics (ADR 0006).
 */
export default async function TenantsPage() {
  const t = await getTranslations();

  return (
    <AdminFrame section="tenants">
      {async ({ context }) => {
        if (!context.platformAdmin) {
          return <Callout tone="warning">{t('administration.tenants.notAllowed')}</Callout>;
        }
        const tenants = await listTenants();

        return (
          <div className="stack">
            <div className={styles.toolbar}>
              <p className="text-secondary">
                {t('administration.tenants.lead', { count: tenants.length })}
              </p>
              <Link href="/admin/tenants/new" className={styles.primaryLink}>
                {t('administration.tenants.create')}
              </Link>
            </div>

            {tenants.length === 0 ? (
              <Callout tone="info">{t('administration.tenants.empty')}</Callout>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('administration.section.tenants')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('administration.tenants.columnName')}</th>
                      <th scope="col">{t('administration.tenants.columnState')}</th>
                      <th scope="col">{t('administration.tenants.columnProjects')}</th>
                      <th scope="col">{t('administration.tenants.columnUsers')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((tenant) => (
                      <tr key={tenant.id}>
                        <th scope="row">
                          <Link
                            href={`/admin/tenants/${tenant.id}` as Route}
                            className={styles.name}
                          >
                            {tenant.name}
                          </Link>
                          <span className={styles.muted}>{tenant.slug}</span>
                        </th>
                        <td>{t(`administration.tenants.state.${tenant.lifecycle}`)}</td>
                        <td>{tenant.projects}</td>
                        <td>{tenant.users}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }}
    </AdminFrame>
  );
}
