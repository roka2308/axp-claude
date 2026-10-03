import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ATTENTION_SEVERITIES, type AttentionItem } from '@axp/contracts';
import { Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { CauseSurface } from '@/components/viewer/CauseSurface';
import { AcknowledgeButton } from '@/components/reporting/AcknowledgeButton';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getAttention } from '@/lib/reporting';
import styles from './attention.module.css';

/**
 * Attention Center (Master Spec §15).
 *
 * Operational things that need someone: a report that failed, a link about to
 * expire, a mapping to check, an account to review. Grouped - one entry per
 * problem with how often it happened - and ordered by what needs action. It
 * never says anything about what a metric did; that is not what it is for.
 */
export default async function AttentionPage() {
  const t = await getTranslations();
  const format = await getFormatter();
  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  let overview;
  try {
    overview = await getAttention();
  } catch (error) {
    return (
      <AppShell activeKey="attention" version={version}>
        <CauseSurface error={error} />
      </AppShell>
    );
  }

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  const text = (item: AttentionItem) => {
    const params: Record<string, string | number> = { ...item.messageParams };
    // A reason is itself a message key; a date is shown as a date.
    if (typeof params.reason === 'string' && t.has(params.reason)) params.reason = t(params.reason);
    if (typeof params.expiresAt === 'string') params.expiresAt = when(params.expiresAt);
    return t.has(item.messageKey) ? t(item.messageKey, params) : item.messageKey;
  };

  return (
    <AppShell activeKey="attention" version={version}>
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <h1>{t('attention.title')}</h1>
          <p className="text-secondary">{t('attention.intro')}</p>
        </header>

        {overview.items.length === 0 ? (
          <Callout tone="success" title={t('attention.emptyTitle')}>
            {t('attention.emptyBody')}
          </Callout>
        ) : null}

        {ATTENTION_SEVERITIES.map((severity) => {
          const items = overview.items.filter((item) => item.severity === severity);
          if (items.length === 0) return null;
          return (
            <section key={severity} className="stack" aria-labelledby={`attention-${severity}`}>
              <h2 id={`attention-${severity}`} className={styles.heading}>
                {t(`attention.severity.${severity}`)}{' '}
                <span className={styles.count}>({items.length})</span>
              </h2>
              <ul className={styles.list}>
                {items.map((item) => (
                  <li key={item.id} className={styles.item} data-severity={item.severity}>
                    <div className={styles.itemHead}>
                      <span className={styles.badge} data-severity={item.severity}>
                        {t(`attention.severity.${item.severity}`)}
                      </span>
                      <span className={styles.kind}>{t(`attention.kind.${item.kind}`)}</span>
                      {item.status === 'acknowledged' ? (
                        <span className={styles.acknowledged}>{t('attention.acknowledged')}</span>
                      ) : null}
                    </div>
                    <p className={styles.message}>{text(item)}</p>
                    <p className={styles.meta}>
                      {[item.tenantName, item.projectName].filter(Boolean).join(' · ')} ·{' '}
                      {item.occurrences > 1
                        ? t('attention.repeated', {
                            count: item.occurrences,
                            first: when(item.firstSeenAt),
                            last: when(item.lastSeenAt),
                          })
                        : t('attention.seenOnce', { when: when(item.lastSeenAt) })}
                    </p>
                    <div className={styles.actions}>
                      {item.href ? (
                        <Link href={item.href as Route} className={styles.fix}>
                          {t(`attention.fix.${item.kind}`)}
                        </Link>
                      ) : null}
                      {item.status === 'open' ? <AcknowledgeButton itemId={item.id} /> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        <p className={styles.note}>{t('attention.notAlerts')}</p>
      </div>
    </AppShell>
  );
}
