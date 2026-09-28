import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { ProjectCreateWizard } from '@/components/projects/ProjectCreateWizard';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getCreationOptions } from '@/lib/solutions';
import { logoutAction } from '@/app/login/actions';

/**
 * Projektanlage (Master Spec §13): Grunddaten → Kontext → Datenquelle →
 * Fertig. Small on purpose - everything else is the setup checklist, which
 * can be picked up in any order afterwards.
 */
export default async function NewProjectPage() {
  const t = await getTranslations();
  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const options = await getCreationOptions();

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
          <Link href="/projects">{t('projectCreate.back')}</Link>
          <h1>{t('projectCreate.title')}</h1>
        </header>
        {options.tenants.length === 0 ? (
          <Callout tone="warning" title={t('projectCreate.notAllowedTitle')}>
            {t('projectCreate.notAllowedBody')}
          </Callout>
        ) : (
          <Card>
            <ProjectCreateWizard tenants={options.tenants} />
          </Card>
        )}
      </div>
    </AppShell>
  );
}
