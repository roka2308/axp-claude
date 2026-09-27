import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { CreateGroupForm } from '@/components/admin/GroupForms';
import { listGroups } from '@/lib/admin';
import styles from '../admin.module.css';

interface PageProps {
  readonly searchParams: Promise<{ readonly tenant?: string }>;
}

/** Groups (D5): "Gruppen sind der bevorzugte Skalierungsweg." */
export default async function GroupsPage({ searchParams }: PageProps) {
  const { tenant: requested } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="groups" requestedTenant={requested}>
      {async ({ tenant }) => {
        if (!tenant) return null;
        const groups = await listGroups(tenant.id);
        const manage = tenant.capabilities.includes('tenant.group.manage');

        return (
          <div className="stack stack--loose">
            <Callout tone="info">{t('administration.groups.principle')}</Callout>
            {groups.length === 0 ? (
              <p className="text-muted">{t('administration.groups.empty')}</p>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('administration.section.groups')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('administration.groups.name')}</th>
                      <th scope="col">{t('administration.groups.members')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr key={group.id}>
                        <th scope="row">
                          <Link
                            href={`/admin/groups/${group.id}?tenant=${tenant.id}`}
                            className={styles.name}
                          >
                            {group.name}
                          </Link>
                          {group.description ? (
                            <span className={styles.muted}>{group.description}</span>
                          ) : null}
                        </th>
                        <td>
                          {t('administration.groups.memberCount', { count: group.memberCount })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {manage ? (
              <Card title={t('administration.groups.newTitle')}>
                <CreateGroupForm tenantId={tenant.id} />
              </Card>
            ) : null}
          </div>
        );
      }}
    </AdminFrame>
  );
}
