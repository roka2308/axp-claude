import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser, getPlatformStatus } from '@/lib/platform';
import { listLibraryDashboards } from '@/lib/analytics';
import { logoutAction } from '@/app/login/actions';

/**
 * Home.
 *
 * Role-adaptive by design (Master Spec §16) - one Home for everyone, not
 * separate role portals. The first thing on it is what most people came for:
 * the dashboards they may open, most recently changed first. Roles follow,
 * with the reminder that a role alone opens no data.
 */
export default async function HomePage() {
  const t = await getTranslations();

  const status = await getPlatformStatus();
  if (status === null) return <ServiceUnavailable />;
  if (status.initState === 'uninitialized') redirect('/setup');

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const fullName = `${user.user.firstName} ${user.user.lastName}`.trim();

  // Tolerant: a Home that fails because the library could not be read would
  // hide the roles and the sign-out along with it.
  const recent = (await listLibraryDashboards().catch(() => []))
    .filter((dashboard) => dashboard.publishedVersion !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);

  return (
    <AppShell
      activeKey="home"
      version={version}
      headerEnd={
        <form action={logoutAction}>
          <span className="text-muted">{t('home.signedInAs', { name: fullName })}</span>{' '}
          <Button type="submit" variant="ghost">
            {t('login.signOut')}
          </Button>
        </form>
      }
    >
      <div className="stack stack--loose">
        <div className="stack stack--tight">
          <h1>{t('home.title')}</h1>
          <p className="text-secondary">{t('home.subtitle')}</p>
        </div>

        <Card title={t('home.recentTitle')}>
          {recent.length === 0 ? (
            <p className="text-muted">{t('home.recentEmpty')}</p>
          ) : (
            <ul className="stack stack--tight">
              {recent.map((dashboard) => (
                <li key={dashboard.id}>
                  <Link href={`/dashboards/${dashboard.id}`}>{dashboard.name}</Link>{' '}
                  <span className="text-muted">· {dashboard.projectName}</span>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link href="/dashboards">{t('home.allDashboards')}</Link>
          </p>
        </Card>

        <Card title={t('home.rolesTitle')}>
          <div className="stack">
            {user.roleAssignments.length === 0 ? (
              <p className="text-muted">{t('home.noRoles')}</p>
            ) : (
              <ul className="stack stack--tight">
                {user.roleAssignments.map((assignment) => (
                  <li key={`${assignment.role}-${assignment.scopeType}-${assignment.scopeId}`}>
                    <strong>{t(`roles.${assignment.role}.label`)}</strong>{' '}
                    <span className="text-muted">
                      {t('home.roleScope', { scope: t(`scopes.${assignment.scopeType}`) })}
                    </span>
                    <div className="text-muted">{t(`roles.${assignment.role}.purpose`)}</div>
                  </li>
                ))}
              </ul>
            )}

            {/*
              Stated in the UI, not just in the model: a role never implies
              access to customer analytics data (Master Spec §7).
            */}
            <Callout tone="info">{t('home.noAutomaticDataAccess')}</Callout>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * The API is unreachable. This is `temporarily_unavailable`, not an error page
 * and not a permission problem - D10 requires those to stay distinguishable.
 */
async function ServiceUnavailable() {
  const t = await getTranslations('errors');
  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <Callout tone="warning" title={t('unreachable')}>
          {t('unreachableAction')}
        </Callout>
      </div>
    </main>
  );
}
