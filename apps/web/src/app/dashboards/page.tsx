import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { listLibraryDashboards } from '@/lib/analytics';
import { logoutAction } from '@/app/login/actions';
import styles from './library.module.css';

/**
 * Dashboard library (D1 "Dashboards", D10 journey 1).
 *
 * Every dashboard the caller may open, across their projects, as a table: the
 * questions a library answers - which project, which version, when last
 * changed - are columns, and a table is the element that makes them
 * comparable and readable by a screen reader.
 */
export default async function DashboardLibraryPage() {
  const t = await getTranslations();

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const dashboards = await listLibraryDashboards();

  return (
    <AppShell
      activeKey="dashboards"
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
          <h1>{t('library.title')}</h1>
          <p className="text-secondary">{t('library.subtitle')}</p>
        </header>

        {dashboards.length === 0 ? (
          <Callout tone="info" title={t('library.emptyTitle')}>
            {t('library.emptyBody')}
          </Callout>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <caption className="sr-only">{t('library.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('library.columnName')}</th>
                  <th scope="col">{t('library.columnProject')}</th>
                  <th scope="col">{t('library.columnVersion')}</th>
                  <th scope="col">{t('library.columnUpdated')}</th>
                </tr>
              </thead>
              <tbody>
                {dashboards.map((dashboard) => (
                  <tr key={dashboard.id}>
                    <th scope="row">
                      <Link href={`/dashboards/${dashboard.id}`} className={styles.name}>
                        {dashboard.name}
                      </Link>
                    </th>
                    <td>{dashboard.projectName}</td>
                    <td>
                      {/* A word, never a coloured dot (D10). */}
                      {dashboard.publishedVersion === null
                        ? t('library.notPublished')
                        : t('library.published', { version: dashboard.publishedVersion })}
                      {dashboard.hasUnpublishedChanges ? ` · ${t('library.draftChanges')}` : ''}
                    </td>
                    <td>
                      {new Date(dashboard.updatedAt).toLocaleDateString('de-DE', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
