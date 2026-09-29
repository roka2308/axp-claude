'use client';

import { useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { SHARE_RIGHTS, type ShareSummary } from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { revokeShareAction } from '@/app/sharing/actions';
import styles from './sharing.module.css';

/**
 * A dashboard's external links, with their standing.
 *
 * The status is a word, never a colour alone, and a link that stopped working
 * for a reason other than its own expiry or revocation says why - that is the
 * part its owner can do something about (D10).
 */
export function ShareList({
  dashboardId,
  shares,
}: {
  readonly dashboardId: string;
  readonly shares: readonly ShareSummary[];
}) {
  const t = useTranslations('share');
  const format = useFormatter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (shares.length === 0) return <p className="text-muted">{t('list.empty')}</p>;

  const revoke = (shareId: string) =>
    startTransition(async () => {
      setError(null);
      const outcome = await revokeShareAction(dashboardId, shareId);
      if (outcome.status === 'error') setError(outcome.message);
      setConfirming(null);
    });

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="stack">
      {error ? (
        <Callout tone="critical" title={t('list.revokeFailed')}>
          {error}
        </Callout>
      ) : null}
      <ul className={styles.shares}>
        {shares.map((share) => {
          const granted = SHARE_RIGHTS.filter((right) => share.rights[right]);
          return (
            <li key={share.id} className={styles.share} aria-label={share.label}>
              <div className={styles.shareHead}>
                <strong className={styles.shareLabel}>{share.label}</strong>
                <span className={styles.status} data-status={share.status}>
                  {t(`status.${share.status}`)}
                </span>
              </div>
              {share.unavailableReason ? (
                <p className={styles.reason}>{t(`unavailableReason.${share.unavailableReason}`)}</p>
              ) : null}
              <dl className={styles.facts}>
                <div>
                  <dt>{t('list.expires')}</dt>
                  <dd>{when(share.expiresAt)}</dd>
                </div>
                <div>
                  <dt>{t('list.rights')}</dt>
                  <dd>
                    {granted.length === 0
                      ? t('list.rightsNone')
                      : granted.map((right) => t(`rights.${right}`)).join(', ')}
                  </dd>
                </div>
                <div>
                  <dt>{t('list.password')}</dt>
                  <dd>{share.passwordProtected ? t('list.passwordYes') : t('list.passwordNo')}</dd>
                </div>
                <div>
                  <dt>{t('list.createdBy')}</dt>
                  <dd>
                    {share.createdBy ?? t('list.unknownCreator')} · {when(share.createdAt)}
                  </dd>
                </div>
                <div>
                  <dt>{t('list.usage')}</dt>
                  <dd>
                    {share.lastAccessedAt
                      ? t('list.usageSeen', {
                          count: share.accessCount,
                          last: when(share.lastAccessedAt),
                        })
                      : t('list.usageNever')}
                  </dd>
                </div>
              </dl>
              {share.status !== 'revoked' ? (
                confirming === share.id ? (
                  <div className={styles.confirm} role="group" aria-label={t('list.confirmLabel')}>
                    <span>{t('list.confirmText')}</span>
                    <Button
                      type="button"
                      variant="danger"
                      disabled={pending}
                      onClick={() => revoke(share.id)}
                    >
                      {t('list.confirmRevoke')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
                      {t('list.cancel')}
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Button type="button" onClick={() => setConfirming(share.id)}>
                      {t('list.revoke')}
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
