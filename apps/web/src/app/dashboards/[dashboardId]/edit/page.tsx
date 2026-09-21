import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { DashboardSnapshot, EditorLease, SemanticDefinitionRef } from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { EditorWorkbench } from '@/components/editor/EditorWorkbench';
import { ApiError, apiRequest } from '@/lib/api-client';
import { getProject } from '@/lib/analytics';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { resolveError } from '@/lib/error-messages';
import { logoutAction } from '@/app/login/actions';
import styles from './edit.module.css';

interface EditorPageProps {
  readonly params: Promise<{ readonly dashboardId: string }>;
}

interface DraftResponse {
  readonly dashboardId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly snapshot: DashboardSnapshot;
  readonly publishedVersion: number | null;
  readonly lease: EditorLease | null;
  readonly heartbeatSeconds: number;
}

/**
 * Dashboard editor (D3).
 *
 * The draft is loaded on the server with the caller's session, so an editor who
 * may not edit never reaches the canvas - and is told which capability is
 * missing rather than shown an empty screen.
 */
export default async function DashboardEditorPage({ params }: EditorPageProps) {
  const t = await getTranslations();
  const { dashboardId } = await params;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  let draft: DraftResponse;
  try {
    draft = await apiRequest<DraftResponse>(
      `/dashboards/${encodeURIComponent(dashboardId)}/draft`,
      { authenticated: true },
    );
  } catch (error) {
    return (
      <AppShell activeKey="dashboards" version={version}>
        <EditorUnavailable dashboardId={dashboardId} error={error} />
      </AppShell>
    );
  }

  // The project the dashboard belongs to decides what this caller may do here
  // and which metrics the gallery can offer.
  const [project, metrics] = await Promise.all([
    getProject(draft.projectId),
    listMetrics(draft.projectId),
  ]);

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
          <Link href={`/dashboards/${dashboardId}`} className={styles.back}>
            {t('editor.backToViewer')}
          </Link>
          <h1>{t('editor.title', { name: draft.snapshot.name })}</h1>
          <p className="text-secondary">
            {draft.publishedVersion === null
              ? t('project.notPublished')
              : t('project.publishedVersion', { version: draft.publishedVersion })}
          </p>
        </header>

        <EditorWorkbench
          dashboardId={dashboardId}
          initialSnapshot={draft.snapshot}
          initialRevisionId={draft.revisionId}
          initialLease={draft.lease}
          heartbeatSeconds={draft.heartbeatSeconds}
          metrics={metrics}
          canPublish={project.capabilities.includes('dashboard.publish')}
        />
      </div>
    </AppShell>
  );
}

/**
 * Why the editor cannot open.
 *
 * "You may not edit this" and "this dashboard does not exist" are different
 * answers and get different words (D10).
 */
async function EditorUnavailable({
  dashboardId,
  error,
}: {
  readonly dashboardId: string;
  readonly error: unknown;
}) {
  const t = await getTranslations();
  const resolved = await resolveError(error);
  const denied = error instanceof ApiError && error.body.category === 'permission_denied';

  return (
    <div className="stack">
      <Callout
        tone={denied ? 'warning' : 'critical'}
        title={denied ? t('editor.notAllowedTitle') : t('viewer.loadFailedTitle')}
      >
        <div className="stack stack--tight">
          <span>{resolved.message}</span>
          {resolved.action ? <span className="text-muted">{resolved.action}</span> : null}
        </div>
      </Callout>
      <Link href={`/dashboards/${dashboardId}`}>{t('editor.backToViewer')}</Link>
    </div>
  );
}

async function listMetrics(projectId: string): Promise<SemanticDefinitionRef[]> {
  try {
    const { definitions } = await apiRequest<{ definitions: SemanticDefinitionRef[] }>(
      `/projects/${encodeURIComponent(projectId)}/semantic-definitions`,
      { authenticated: true },
    );
    return definitions;
  } catch {
    // Without `semantic.read` the gallery offers blank widgets only, which is
    // a smaller editor rather than a broken one.
    return [];
  }
}
