import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { TemplateSummary } from '@axp/contracts';
import { Button, Callout, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { CreateFromTemplateButton } from '@/components/templates/CreateFromTemplateButton';
import { ExportSolutionForm } from '@/components/templates/ExportSolutionForm';
import { getProject, listDashboards, listProjects } from '@/lib/analytics';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getSolutionCatalog, listInstallations, listTemplates } from '@/lib/solutions';
import { logoutAction } from '@/app/login/actions';
import styles from './templates.module.css';

const TABS = ['dashboards', 'widgets', 'solutions'] as const;
type Tab = (typeof TABS)[number];

interface PageProps {
  readonly searchParams: Promise<{ readonly project?: string; readonly tab?: string }>;
}

/**
 * Vorlagen (D1, D7): Dashboard-Vorlagen, Widget-Vorlagen, Lösungen.
 *
 * Templates belong to a project's context - whether one is ready depends on
 * what that project has mapped - so the page is always about one project,
 * chosen in the URL. The UI says "Lösung"; "Analytics Solution Package" is the
 * technical term and stays out of sight (Master Spec §14).
 */
export default async function TemplatesPage({ searchParams }: PageProps) {
  const t = await getTranslations();
  const { project: requested, tab: requestedTab } = await searchParams;
  const tab: Tab = TABS.find((entry) => entry === requestedTab) ?? 'dashboards';

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const projects = await listProjects();
  const current = projects.find((entry) => entry.id === requested) ?? projects[0];

  const shell = (children: React.ReactNode) => (
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
          <h1>{t('templates.title')}</h1>
          <p className="text-secondary">{t('templates.subtitle')}</p>
        </header>
        {children}
      </div>
    </AppShell>
  );

  if (!current) {
    return shell(<Callout tone="info">{t('templates.noProjects')}</Callout>);
  }

  const detail = await getProject(current.id);
  const can = (capability: string) => detail.capabilities.includes(capability as never);
  const href = (entry: Tab) => `/templates?project=${current.id}&tab=${entry}` as Route;

  return shell(
    <>
      {projects.length > 1 ? (
        <form method="get" className={styles.picker}>
          <input type="hidden" name="tab" value={tab} />
          <label htmlFor="templates-project" className={styles.pickerLabel}>
            {t('templates.project')}
          </label>
          <select
            id="templates-project"
            name="project"
            defaultValue={current.id}
            className={styles.select}
          >
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary">
            {t('templates.switchProject')}
          </Button>
        </form>
      ) : (
        <p className="text-secondary">
          {t('templates.project')}: <strong>{current.name}</strong>
        </p>
      )}

      <nav aria-label={t('templates.tabs')}>
        <ul className={styles.tabs}>
          {TABS.map((entry) => (
            <li key={entry}>
              <Link
                href={href(entry)}
                className={styles.tab}
                aria-current={entry === tab ? 'page' : undefined}
              >
                {t(`templates.tab.${entry}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {!can('semantic.read') ? (
        <Callout tone="warning" title={t('templates.notAllowedTitle')}>
          {t('templates.notAllowedBody')}
        </Callout>
      ) : tab === 'dashboards' ? (
        <TemplateList
          templates={await listTemplates(current.id, 'dashboard')}
          projectId={current.id}
          canCreate={can('dashboard.create')}
          canInstall={can('semantic.manage')}
        />
      ) : tab === 'widgets' ? (
        <TemplateList
          templates={await listTemplates(current.id, 'widget')}
          projectId={current.id}
          canCreate={false}
          canInstall={can('semantic.manage')}
        />
      ) : (
        <Solutions
          projectId={current.id}
          canManage={can('semantic.manage')}
          canExport={can('semantic.manage') && can('dashboard.edit_draft')}
        />
      )}
    </>,
  );
}

async function TemplateList({
  templates,
  projectId,
  canCreate,
  canInstall,
}: {
  readonly templates: readonly TemplateSummary[];
  readonly projectId: string;
  readonly canCreate: boolean;
  readonly canInstall: boolean;
}) {
  const t = await getTranslations();

  if (templates.length === 0) {
    return (
      <Callout tone="info" title={t('templates.emptyTitle')}>
        <div className="stack stack--tight">
          <span>{t('templates.emptyBody')}</span>
          {canInstall ? (
            <Link href={`/templates?project=${projectId}&tab=solutions` as Route}>
              {t('templates.toSolutions')}
            </Link>
          ) : null}
        </div>
      </Callout>
    );
  }

  return (
    <ul className={styles.grid}>
      {templates.map((template) => (
        <li key={template.id}>
          <Card title={template.name}>
            <div className="stack stack--tight">
              {template.description ? <p>{template.description}</p> : null}
              <p className={styles.readiness} data-readiness={template.readiness}>
                {t(`templates.readiness.${template.readiness}`)}
              </p>
              {template.missing.length > 0 ? (
                <p className="text-muted">
                  {t('templates.missing', { items: template.missing.join(', ') })}
                </p>
              ) : null}
              <p className="text-muted">
                {template.kind === 'dashboard'
                  ? t('templates.widgetCount', { count: template.widgetCount ?? 0 })
                  : t(`editor.family.${template.family ?? 'card'}`)}
                {' · '}
                {template.solution
                  ? t('templates.fromSolution', {
                      name: template.solution.name,
                      version: template.solution.version,
                    })
                  : t(`templates.layer.${template.layer}`)}
                {' · '}
                {t('templates.version', { version: template.version })}
              </p>
              {template.kind === 'dashboard' && canCreate ? (
                <CreateFromTemplateButton
                  projectId={projectId}
                  templateId={template.id}
                  templateName={template.name}
                />
              ) : null}
              {template.kind === 'widget' ? (
                <p className="text-muted">{t('templates.widgetHint')}</p>
              ) : null}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

async function Solutions({
  projectId,
  canManage,
  canExport,
}: {
  readonly projectId: string;
  readonly canManage: boolean;
  readonly canExport: boolean;
}) {
  const t = await getTranslations();
  const [catalog, installations, dashboards] = await Promise.all([
    getSolutionCatalog(),
    listInstallations(projectId),
    canExport ? listDashboards(projectId) : Promise.resolve([]),
  ]);
  const current = installations.filter((entry) => entry.current);
  const locale = t('templates.dateLocale');

  return (
    <div className="stack stack--loose">
      <Callout tone="info">{t('templates.solutionsExplain')}</Callout>

      <section className="stack" aria-labelledby="solutions-available">
        <h2 id="solutions-available">{t('templates.available')}</h2>
        <ul className={styles.grid}>
          {catalog.map((entry) => {
            const installed = current.find((item) => item.packageId === entry.packageId);
            return (
              <li key={entry.packageId}>
                <Card title={entry.name}>
                  <div className="stack stack--tight">
                    {entry.description ? <p>{entry.description}</p> : null}
                    <p className="text-muted">
                      {t('templates.solutionMeta', {
                        publisher: entry.publisher,
                        version: entry.packageVersion,
                      })}
                    </p>
                    <p>
                      {installed
                        ? t('templates.installedVersion', { version: installed.packageVersion })
                        : t('templates.notInstalled')}
                    </p>
                    {canManage ? (
                      <Link
                        href={
                          `/templates/install?project=${projectId}&package=${encodeURIComponent(entry.packageId)}` as Route
                        }
                        className={styles.primaryLink}
                      >
                        {installed ? t('templates.checkAgain') : t('templates.install')}
                      </Link>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
        {canManage ? (
          <Link href={`/templates/install?project=${projectId}` as Route}>
            {t('templates.uploadPackage')}
          </Link>
        ) : (
          <p className="text-muted">{t('templates.installNeedsRole')}</p>
        )}
      </section>

      <section className="stack" aria-labelledby="solutions-installed">
        <h2 id="solutions-installed">{t('templates.installed')}</h2>
        {installations.length === 0 ? (
          <p className="text-muted">{t('templates.noneInstalled')}</p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('templates.columnSolution')}</th>
                  <th scope="col">{t('templates.columnVersion')}</th>
                  <th scope="col">{t('templates.columnInstalled')}</th>
                  <th scope="col">{t('templates.columnStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {installations.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.name}</th>
                    <td>{entry.packageVersion}</td>
                    <td>
                      {new Date(entry.installedAt).toLocaleString(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'UTC',
                      })}{' '}
                      UTC{entry.installedBy ? ` · ${entry.installedBy}` : ''}
                    </td>
                    <td>{entry.current ? t('templates.current') : t('templates.superseded')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canExport ? (
        <Card title={t('templates.exportTitle')} description={t('templates.exportBody')}>
          <ExportSolutionForm
            projectId={projectId}
            dashboards={dashboards
              .filter((dashboard) => dashboard.publishedVersion !== null)
              .map((dashboard) => ({ id: dashboard.id, name: dashboard.name }))}
          />
        </Card>
      ) : null}
    </div>
  );
}
