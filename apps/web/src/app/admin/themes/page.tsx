import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { Callout } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { ThemeEditor } from '@/components/theming/ThemeEditor';
import { listProjects } from '@/lib/analytics';
import { getTheme, type ThemeScopePath } from '@/lib/theming';
import styles from '../admin.module.css';

interface PageProps {
  readonly searchParams: Promise<{
    readonly tenant?: string;
    readonly scope?: string;
    readonly project?: string;
  }>;
}

/**
 * Administration → Themes (D1, D9).
 *
 * The three levels side by side: the platform's theme (platform
 * administrators), the customer's own on top, and optionally a project's on
 * top of that. Each level shows what it inherits.
 */
export default async function ThemesPage({ searchParams }: PageProps) {
  const { tenant: requested, scope, project } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="themes" {...(requested ? { requestedTenant: requested } : {})}>
      {async ({ context, tenant }) => {
        const projects = tenant
          ? (await listProjects().catch(() => [])).filter((entry) => entry.tenantId === tenant.id)
          : [];
        const selected =
          scope === 'platform' && context.platformAdmin
            ? { path: 'platform' as ThemeScopePath, title: t('themes.scope.platform') }
            : scope === 'project' && project && projects.some((entry) => entry.id === project)
              ? {
                  path: `projects/${project}` as ThemeScopePath,
                  title: projects.find((entry) => entry.id === project)!.name,
                }
              : tenant
                ? { path: `tenants/${tenant.id}` as ThemeScopePath, title: tenant.name }
                : context.platformAdmin
                  ? { path: 'platform' as ThemeScopePath, title: t('themes.scope.platform') }
                  : null;

        const href = (next: Record<string, string>) =>
          `/admin/themes?${new URLSearchParams({ ...(tenant ? { tenant: tenant.id } : {}), ...next })}` as Route;

        let overview;
        try {
          overview = selected ? await getTheme(selected.path) : null;
        } catch {
          overview = null;
        }

        return (
          <div className="stack stack--loose">
            <div className="stack stack--tight">
              <h2>{t('themes.title')}</h2>
              <p className="text-secondary">{t('themes.intro')}</p>
            </div>

            <nav aria-label={t('themes.levels')}>
              <ul className={styles.tabs}>
                {context.platformAdmin ? (
                  <li>
                    <Link
                      href={href({ scope: 'platform' })}
                      aria-current={selected?.path === 'platform' ? 'page' : undefined}
                    >
                      {t('themes.scope.platform')}
                    </Link>
                  </li>
                ) : null}
                {tenant ? (
                  <li>
                    <Link
                      href={href({ scope: 'tenant' })}
                      aria-current={selected?.path === `tenants/${tenant.id}` ? 'page' : undefined}
                    >
                      {t('themes.scopeTenant', { name: tenant.name })}
                    </Link>
                  </li>
                ) : null}
                {projects.map((entry) => (
                  <li key={entry.id}>
                    <Link
                      href={href({ scope: 'project', project: entry.id })}
                      aria-current={selected?.path === `projects/${entry.id}` ? 'page' : undefined}
                    >
                      {t('themes.scopeProject', { name: entry.name })}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {selected && overview ? (
              <section className="stack" aria-labelledby="theme-editor-title">
                <h3 id="theme-editor-title">{t('themes.editing', { title: selected.title })}</h3>
                <ThemeEditor
                  key={selected.path}
                  path={selected.path}
                  overview={overview}
                  title={selected.title}
                />
              </section>
            ) : (
              <Callout tone="info" title={t('themes.notAllowedTitle')}>
                {t('themes.notAllowedBody')}
              </Callout>
            )}
          </div>
        );
      }}
    </AdminFrame>
  );
}
