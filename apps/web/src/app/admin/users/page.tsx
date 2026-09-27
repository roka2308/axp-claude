import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Callout } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { listUsers } from '@/lib/admin';
import styles from '../admin.module.css';

interface PageProps {
  readonly searchParams: Promise<{ readonly tenant?: string; readonly q?: string }>;
}

/**
 * The people of a tenant (D5 "Benutzer").
 *
 * Status, sign-in method, groups and roles at a glance - each as words, so the
 * list can be read without colour and without opening every person.
 */
export default async function UsersPage({ searchParams }: PageProps) {
  const { tenant: requested, q } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="users" requestedTenant={requested}>
      {async ({ tenant }) => {
        if (!tenant) return null;
        const users = await listUsers(tenant.id, q);
        const mayInvite = tenant.capabilities.includes('tenant.user.invite');

        return (
          <div className="stack">
            <div className={styles.toolbar}>
              <form method="get" className={styles.search} role="search">
                <input type="hidden" name="tenant" value={tenant.id} />
                <label htmlFor="user-search" className="sr-only">
                  {t('administration.users.search')}
                </label>
                <input
                  id="user-search"
                  name="q"
                  type="search"
                  defaultValue={q}
                  placeholder={t('administration.users.searchPlaceholder')}
                  className={styles.searchInput}
                />
                <Button type="submit" variant="secondary">
                  {t('administration.users.searchSubmit')}
                </Button>
              </form>
              {mayInvite ? (
                <Link href={`/admin/users/new?tenant=${tenant.id}`} className={styles.primaryLink}>
                  {t('administration.users.invite')}
                </Link>
              ) : null}
            </div>

            {users.length === 0 ? (
              <Callout tone="info">{t('administration.users.empty')}</Callout>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('administration.section.users')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('administration.users.columnName')}</th>
                      <th scope="col">{t('administration.users.columnStatus')}</th>
                      <th scope="col">{t('administration.users.columnGroups')}</th>
                      <th scope="col">{t('administration.users.columnRoles')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <th scope="row">
                          <Link
                            href={`/admin/users/${user.id}?tenant=${tenant.id}`}
                            className={styles.name}
                          >
                            {user.name}
                          </Link>
                          <span className={styles.muted}>{user.email}</span>
                        </th>
                        <td>
                          {t(`administration.status.${user.status}`)}
                          <span className={styles.muted}>
                            {t(`administration.provider.${user.provider}`)}
                          </span>
                        </td>
                        <td>{user.groups.length > 0 ? user.groups.join(', ') : '—'}</td>
                        <td>
                          {user.roles.length > 0
                            ? user.roles.map((role) => t(`roles.${role}.label`)).join(', ')
                            : '—'}
                        </td>
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
