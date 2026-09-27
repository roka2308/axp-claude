import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PRODUCT_SEARCH_KINDS, type ProductSearchHit } from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { searchProductObjects } from '@/lib/analytics';
import { logoutAction } from '@/app/login/actions';
import styles from './search.module.css';

interface SearchPageProps {
  readonly searchParams: Promise<{ readonly q?: string }>;
}

/**
 * Product search results (D1).
 *
 * Grouped by kind, because "Besuche" the dashboard and "Besuche" the metric are
 * different things to open. Everything listed has already been filtered to
 * what this caller may see, on the server.
 */
export default async function SearchPage({ searchParams }: SearchPageProps) {
  const t = await getTranslations();
  const { q = '' } = await searchParams;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const query = q.trim();
  const result = query.length >= 2 ? await searchProductObjects(query) : { query, hits: [] };

  const groups = PRODUCT_SEARCH_KINDS.map((kind) => ({
    kind,
    hits: result.hits.filter((hit) => hit.kind === kind),
  })).filter((group) => group.hits.length > 0);

  return (
    <AppShell
      activeKey="search"
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
          <h1>{t('search.title')}</h1>
          {query ? (
            <p className="text-secondary" role="status">
              {t('search.resultCount', { count: result.hits.length, query })}
            </p>
          ) : null}
        </header>

        {query.length < 2 ? (
          <Callout tone="info" title={t('search.tooShortTitle')}>
            {t('search.tooShortBody')}
          </Callout>
        ) : groups.length === 0 ? (
          <Callout tone="info" title={t('search.emptyTitle', { query })}>
            {t('search.emptyBody')}
          </Callout>
        ) : (
          groups.map((group) => (
            <section
              key={group.kind}
              className="stack stack--tight"
              aria-labelledby={`hits-${group.kind}`}
            >
              <h2 id={`hits-${group.kind}`} className={styles.group}>
                {t(`search.kind.${group.kind}`)}
              </h2>
              <ul className={styles.hits}>
                {group.hits.map((hit: ProductSearchHit) => (
                  <li key={`${hit.kind}-${hit.id}`} className={styles.hit}>
                    {/* The API decides the route; the kinds it can produce are fixed. */}
                    <Link href={hit.href as Route} className={styles.title}>
                      {hit.title}
                    </Link>
                    <span className={styles.context}>{hit.context}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </AppShell>
  );
}
