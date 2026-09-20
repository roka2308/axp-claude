import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { listProjects } from '@/lib/analytics';
import { logoutAction } from '@/app/login/actions';
import { Button } from '@axp/ui';
import styles from './projects.module.css';

/**
 * Project list.
 *
 * What a caller sees is decided server-side from their resolved access; a
 * project outside it never reaches the response.
 */
export default async function ProjectsPage() {
  const t = await getTranslations();

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const projects = await listProjects();

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
          <h1>{t('projects.title')}</h1>
          <p className="text-secondary">{t('projects.subtitle')}</p>
        </div>

        {projects.length === 0 ? (
          <Callout tone="info" title={t('projects.emptyTitle')}>
            {t('projects.emptyBody')}
          </Callout>
        ) : (
          <ul className={styles.list}>
            {projects.map((project) => (
              <li key={project.id}>
                <Card>
                  <div className={styles.row}>
                    <div className="stack stack--tight">
                      <Link href={`/projects/${project.id}`} className={styles.name}>
                        {project.name}
                      </Link>
                      <span className="text-muted">
                        {project.tenantName} · {project.timezone}
                      </span>
                    </div>
                    <span className={styles.readiness} data-state={project.setupState}>
                      {t(`setupReadiness.${project.setupState}`)}
                    </span>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
