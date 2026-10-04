'use client';

import { useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { EntitlementState, FeatureFlagState } from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { setEntitlementAction } from '@/app/admin/productization-actions';
import styles from './EntitlementsPanel.module.css';

/**
 * A customer's modules (Master Spec §23), decided by platform administrators.
 *
 * Kept visibly apart from the installation's feature flags, which are
 * technical switches of the deployment and not something a customer has or
 * does not have. Switching a module off is reversible and deletes nothing.
 */
export function EntitlementsPanel({
  tenantId,
  initial,
  featureFlags,
}: {
  readonly tenantId: string;
  readonly initial: readonly EntitlementState[];
  readonly featureFlags: readonly FeatureFlagState[];
}) {
  const t = useTranslations('entitlements');
  const format = useFormatter();
  const [entries, setEntries] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (entry: EntitlementState) =>
    startTransition(async () => {
      setError(null);
      const outcome = await setEntitlementAction(tenantId, entry.entitlement, !entry.enabled);
      if (outcome.status === 'ok' && outcome.data) setEntries(outcome.data.entitlements);
      else if (outcome.status === 'error') setError(outcome.message);
    });

  return (
    <div className="stack">
      <p className="text-secondary">{t('intro')}</p>
      {error ? (
        <Callout tone="critical" live>
          {error}
        </Callout>
      ) : null}
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li
            key={entry.entitlement}
            className={styles.item}
            aria-label={t(`module.${entry.entitlement.replace('.', '_')}`)}
          >
            <div className="stack stack--tight">
              <strong>{t(`module.${entry.entitlement.replace('.', '_')}`)}</strong>
              <span className="text-muted">
                {t(`explain.${entry.entitlement.replace('.', '_')}`)}
              </span>
              <span className={styles.meta}>
                {entry.changedAt
                  ? t('changed', {
                      when: format.dateTime(new Date(entry.changedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                      by: entry.changedBy ?? '—',
                    })
                  : t('default')}
              </span>
            </div>
            <div className={styles.control}>
              <span className={styles.state} data-enabled={entry.enabled}>
                {entry.enabled ? t('enabled') : t('disabled')}
              </span>
              <Button type="button" disabled={pending} onClick={() => toggle(entry)}>
                {entry.enabled ? t('disable') : t('enable')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-muted">{t('keepsConfiguration')}</p>

      <h3 className={styles.heading}>{t('flagsTitle')}</h3>
      <p className="text-secondary">{t('flagsIntro')}</p>
      <ul className={styles.list}>
        {featureFlags.map((flag) => (
          <li key={flag.flag} className={styles.item}>
            <div className="stack stack--tight">
              <strong>{t(`flag.${flag.flag.replace('.', '_')}`)}</strong>
              <span className={styles.meta}>{t('flagSetting', { setting: flag.setting })}</span>
            </div>
            <span className={styles.state} data-enabled={flag.enabled}>
              {flag.enabled ? t('flagOn') : t('flagOff')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
