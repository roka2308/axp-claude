import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { SemanticVersionRef } from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { SemanticLibrary } from '@/components/semantics/SemanticLibrary';
import { SourceMappings } from '@/components/semantics/SourceMappings';
import { getProject } from '@/lib/analytics';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import {
  describeActiveVersions,
  getBindingHealth,
  listBindings,
  listDefinitions,
} from '@/lib/semantics';
import { logoutAction } from '@/app/login/actions';
import styles from './semantics.module.css';

interface SemanticsPageProps {
  readonly params: Promise<{ readonly projectId: string }>;
}

/**
 * The project's semantic library (Master Spec §13, D6).
 *
 * Reading the catalog and changing it are different capabilities, so the page
 * is gated on `semantic.read` and the builders on `semantic.manage`. Somebody
 * who may only read still gets the whole answer to "what does this number
 * mean" - which is the point of having a catalog at all.
 */
export default async function SemanticsPage({ params }: SemanticsPageProps) {
  const t = await getTranslations();
  const { projectId } = await params;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const detail = await getProject(projectId);
  const canRead = detail.capabilities.includes('semantic.read');
  const canManage = detail.capabilities.includes('semantic.manage');

  if (!canRead) {
    return (
      <AppShell activeKey="projects" version={version}>
        <div className="stack">
          <Callout tone="warning" title={t('semantics.notAllowedTitle')}>
            {t('semantics.notAllowedBody')}
          </Callout>
          <Link href={`/projects/${projectId}`}>{t('projectSetup.backToProject')}</Link>
        </div>
      </AppShell>
    );
  }

  const definitions = await listDefinitions(projectId);
  const [active, bindings, health] = await Promise.all([
    describeActiveVersions(projectId, definitions),
    listBindings(projectId),
    getBindingHealth(projectId),
  ]);

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
          <h1>{t('semantics.title')}</h1>
          <p className="text-secondary">
            {detail.project.name} · {t('semantics.subtitle')}
          </p>
        </header>

        <SemanticLibrary
          projectId={projectId}
          definitions={definitions}
          active={Object.fromEntries(active) as Record<string, SemanticVersionRef>}
          siteId={detail.sites[0]?.id ?? null}
          canManage={canManage}
        />

        <SourceMappings
          projectId={projectId}
          bindings={bindings}
          health={health.health}
          available={health.available}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
