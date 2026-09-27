import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { Callout } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { getAudit } from '@/lib/admin';
import styles from '../admin.module.css';

interface PageProps {
  readonly searchParams: Promise<{ readonly tenant?: string; readonly before?: string }>;
}

/**
 * The audit trail (D5: "Audit für privilegierte Änderungen").
 *
 * Who did what, when - newest first, paged by time. Shows names and actions,
 * never values: the trail records that a profile changed, not what it said.
 */
export default async function AuditPage({ searchParams }: PageProps) {
  const { tenant: requested, before } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="audit" requestedTenant={requested}>
      {async ({ tenant }) => {
        if (!tenant) return null;
        const events = await getAudit(tenant.id, before).catch(() => null);
        if (events === null) {
          return <Callout tone="warning">{t('administration.audit.notAllowed')}</Callout>;
        }
        const last = events[events.length - 1];

        return (
          <div className="stack">
            {events.length === 0 ? (
              <p className="text-muted">{t('administration.audit.empty')}</p>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('administration.section.audit')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('administration.audit.when')}</th>
                      <th scope="col">{t('administration.audit.who')}</th>
                      <th scope="col">{t('administration.audit.what')}</th>
                      <th scope="col">{t('administration.audit.outcome')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id}>
                        <td>
                          {new Date(event.occurredAt).toLocaleString('de-DE', {
                            dateStyle: 'short',
                            timeStyle: 'medium',
                            timeZone: 'UTC',
                          })}{' '}
                          UTC
                        </td>
                        <td>{event.actor?.name ?? t('administration.audit.system')}</td>
                        <td>
                          {t.has(`auditAction.${event.action}`)
                            ? t(`auditAction.${event.action}`)
                            : event.action}
                          {event.targetType ? (
                            <span className={styles.muted}>{event.targetType}</span>
                          ) : null}
                        </td>
                        <td>{t(`administration.audit.outcomeValue.${event.outcome}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {last && events.length >= 50 ? (
              <Link
                href={
                  `/admin/audit?tenant=${tenant.id}&before=${encodeURIComponent(last.occurredAt)}` as Route
                }
              >
                {t('administration.audit.older')}
              </Link>
            ) : null}
          </div>
        );
      }}
    </AdminFrame>
  );
}
