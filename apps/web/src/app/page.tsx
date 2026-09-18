import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser, getPlatformStatus } from '@/lib/platform';
import { logoutAction } from '@/app/login/actions';

/**
 * Home.
 *
 * Role-adaptive by design (Master Spec §16) - one Home for everyone, not
 * separate role portals. Phase 0 shows identity, effective roles and build
 * metadata; dashboards, projects and attention items arrive with their
 * milestones.
 */
export default async function HomePage() {
  const t = await getTranslations();

  const status = await getPlatformStatus();
  if (status === null) return <ServiceUnavailable />;
  if (status.initState === 'uninitialized') redirect('/setup');

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const fullName = `${user.user.firstName} ${user.user.lastName}`.trim();

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

        <Card title={t('home.nextMilestone')}>
          <p className="text-secondary">{t('home.nextMilestoneBody')}</p>
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
