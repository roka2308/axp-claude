import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { VersionResponse } from '@axp/contracts';
import styles from './AppShell.module.css';

/**
 * Application shell with the D1 information architecture.
 *
 * Primary navigation is exactly the five entries decided in D1 - Home,
 * Projekte, Dashboards, Vorlagen, Administration - plus the global top bar
 * functions. No Search/Interests, Funnel/Processes, analytics alerts or generic
 * data explorer: those were explicitly excluded.
 *
 * Entries whose milestone has not landed are rendered as plain text with a
 * visible "not yet available" badge rather than as links. The shell shows the
 * agreed structure without implying features that do not exist.
 */

interface NavEntry {
  readonly key: 'home' | 'projects' | 'dashboards' | 'templates' | 'administration';
  readonly href?: Route;
  /** Milestone that will make this entry usable. */
  readonly pendingPhase?: string;
}

const NAV_ENTRIES: readonly NavEntry[] = [
  { key: 'home', href: '/' },
  { key: 'projects', href: '/projects' },
  // The cross-project library: every dashboard the caller may open.
  { key: 'dashboards', href: '/dashboards' },
  { key: 'templates', pendingPhase: 'Phase 6' },
  { key: 'administration', pendingPhase: 'Phase 5' },
];

export interface AppShellProps {
  readonly activeKey: NavEntry['key'] | 'search';
  readonly version: VersionResponse | null;
  readonly headerEnd?: React.ReactNode;
  readonly children: React.ReactNode;
}

export async function AppShell({ activeKey, version, headerEnd, children }: AppShellProps) {
  const t = await getTranslations('nav');
  const tProduct = await getTranslations('product');
  const tSystem = await getTranslations('system');
  const tSearch = await getTranslations('search');

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarStart}>
          <span className={styles.brandName}>{tProduct('name')}</span>
          {/*
            Tenant/project switcher placeholder. Rendered as static text until
            tenants and projects are selectable (Phase 1 / Phase 5).
          */}
          <span className={styles.contextSwitcher}>{t('tenantSwitcher')}</span>
        </div>
        {/*
          Product search (D1). A plain GET form, so it works without
          JavaScript and the results page is a URL like any other. It finds
          projects, dashboards and definitions - never data.
        */}
        <form action="/search" method="get" role="search" className={styles.search}>
          <label htmlFor="product-search" className="sr-only">
            {tSearch('label')}
          </label>
          <input
            id="product-search"
            name="q"
            type="search"
            className={styles.searchInput}
            placeholder={tSearch('placeholder')}
            minLength={2}
            maxLength={100}
            autoComplete="off"
          />
        </form>
        <div className={styles.topbarEnd}>{headerEnd}</div>
      </header>

      <nav className={styles.sidebar} aria-label={t('primary')}>
        <ul className={styles.navList}>
          {NAV_ENTRIES.map((entry) => {
            const label = t(entry.key);
            if (!entry.href) {
              return (
                <li key={entry.key}>
                  <span
                    className={[styles.navLink, styles.navLinkPending].join(' ')}
                    aria-disabled="true"
                  >
                    {label}
                    <span className={styles.pendingBadge}>{entry.pendingPhase}</span>
                  </span>
                </li>
              );
            }
            const active = entry.key === activeKey;
            return (
              <li key={entry.key}>
                <Link
                  href={entry.href}
                  className={[styles.navLink, active ? styles.navLinkActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={active ? 'page' : undefined}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className={styles.content} id="main-content">
        {children}

        <footer className={styles.footer}>
          {version ? (
            <>
              <span>
                {tSystem('versionLabel', {
                  version: version.version,
                  schemaVersion: version.schemaVersion,
                  commit: version.commit,
                })}
              </span>
              <span>{tSystem('environmentLabel', { env: version.appEnv })}</span>
              <span>{tSystem(`deploymentProfile.${version.deploymentProfile}`)}</span>
            </>
          ) : null}
        </footer>
      </main>
    </div>
  );
}
