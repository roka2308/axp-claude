import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { SolutionInstallWizard } from '@/components/templates/SolutionInstallWizard';
import { getProject } from '@/lib/analytics';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getSolutionCatalog } from '@/lib/solutions';
import { logoutAction } from '@/app/login/actions';

interface PageProps {
  readonly searchParams: Promise<{ readonly project?: string; readonly package?: string }>;
}

/**
 * "Lösung installieren" (Master Spec §14): Prüfen → Zuordnen → Konflikte →
 * Vorschau → Installieren. With a `package` from the catalogue, or with a file
 * the person chooses. Nothing is written before the last step.
 */
export default async function InstallSolutionPage({ searchParams }: PageProps) {
  const t = await getTranslations();
  const { project: projectId, package: packageId } = await searchParams;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');
  if (!projectId) redirect('/templates');

  const [detail, catalog] = await Promise.all([getProject(projectId), getSolutionCatalog()]);
  const entry = packageId ? catalog.find((item) => item.packageId === packageId) : undefined;
  const back = `/templates?project=${projectId}&tab=solutions` as Route;

  return (
    <AppShell
      activeKey="templates"
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
          <Link href={back}>{t('install.back')}</Link>
          <h1>{entry ? t('install.titleFor', { name: entry.name }) : t('install.title')}</h1>
          <p className="text-secondary">
            {t('install.subtitle', { project: detail.project.name })}
          </p>
        </header>

        {!detail.capabilities.includes('semantic.manage') ? (
          <Callout tone="warning" title={t('install.notAllowedTitle')}>
            {t('install.notAllowedBody')}
          </Callout>
        ) : (
          <Card>
            <SolutionInstallWizard
              projectId={projectId}
              {...(entry ? { catalog: { packageId: entry.packageId } } : {})}
            />
          </Card>
        )}
      </div>
    </AppShell>
  );
}
