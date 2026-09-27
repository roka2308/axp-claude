'use client';

import { useTranslations } from 'next-intl';
import type { ImpactPreview } from '@axp/contracts';
import { Callout } from '@axp/ui';
import styles from './ImpactPreviewPanel.module.css';

/**
 * What a permission change would do, before it is done (D5).
 *
 * One block per person the change reaches, each saying what they gain and
 * what they lose. A change that alters nothing says so explicitly - which is
 * itself worth knowing before confirming it.
 */
export function ImpactPreviewPanel({ preview }: { readonly preview: ImpactPreview }) {
  const t = useTranslations('administration.impact');
  const tCap = useTranslations('capability');

  if (preview.affected.length === 0 || preview.noEffect) {
    return (
      <Callout tone="info" title={t('noEffectTitle')} live>
        {t('noEffectBody')}
      </Callout>
    );
  }

  return (
    <section className={styles.panel} aria-label={t('title')} aria-live="polite">
      <h4 className={styles.title}>{t('title')}</h4>
      <p className={styles.lead}>{t('lead', { count: preview.affected.length })}</p>
      <ul className={styles.people}>
        {preview.affected.map((person) => (
          <li key={person.userId} className={styles.person}>
            <strong>{person.name}</strong>
            {person.unchanged ? (
              <span className="text-muted"> — {t('unchanged')}</span>
            ) : (
              <ul className={styles.changes}>
                {person.capabilitiesGained.map((entry) => (
                  <li key={`cg-${entry.scope}-${entry.capability}`} data-change="gain">
                    {t('gainsCapability', {
                      capability: tCap(entry.capability),
                      scope: entry.scope,
                    })}
                  </li>
                ))}
                {person.capabilitiesLost.map((entry) => (
                  <li key={`cl-${entry.scope}-${entry.capability}`} data-change="loss">
                    {t('losesCapability', {
                      capability: tCap(entry.capability),
                      scope: entry.scope,
                    })}
                  </li>
                ))}
                {person.dashboardsGained.map((entry) => (
                  <li key={`dg-${entry.id}-${entry.access}`} data-change="gain">
                    {t(`gainsDashboard.${entry.access}`, { name: entry.name })}
                  </li>
                ))}
                {person.dashboardsLost.map((entry) => (
                  <li key={`dl-${entry.id}-${entry.access}`} data-change="loss">
                    {t(`losesDashboard.${entry.access}`, { name: entry.name })}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
