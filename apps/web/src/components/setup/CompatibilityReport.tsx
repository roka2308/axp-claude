'use client';

import { useTranslations } from 'next-intl';
import {
  capabilityTier,
  type CapabilityProbeResult,
  type CapabilityTier,
  type MatomoCompatibility,
} from '@axp/contracts';
import { Callout, type CalloutTone } from '@axp/ui';
import styles from './CompatibilityReport.module.css';

export interface CompatibilityReportProps {
  readonly compatibility: MatomoCompatibility;
  readonly matomoVersion: string | null;
  readonly probes: readonly CapabilityProbeResult[];
  readonly limitationKeys: readonly string[];
  readonly detectedAt?: string;
  readonly siteCount?: number | null;
  /** Collapses the probe list behind a disclosure. */
  readonly compact?: boolean;
}

/**
 * What a Matomo installation was observed to be able to do (Master Spec §22).
 *
 * The four compatibility states are shown as text with their own explanation,
 * never as a coloured dot: "supported with limitations" and "not supported" are
 * different situations and must read differently (D10, G3).
 *
 * The version is printed beside the conclusion, never instead of it - the
 * conclusion comes from the probes.
 */
export function CompatibilityReport({
  compatibility,
  matomoVersion,
  probes,
  limitationKeys,
  detectedAt,
  siteCount,
  compact = false,
}: CompatibilityReportProps) {
  const t = useTranslations('matomoCompatibility');
  const tCapability = useTranslations('matomoCapability');
  const tMatomo = useTranslations('matomo');

  const byTier = groupByTier(probes);

  return (
    <div className="stack stack--tight">
      <Callout tone={TONE[compatibility]} title={`${t('label')}: ${t(compatibility)}`}>
        <div className="stack stack--tight">
          <span>{t(`${compatibility}Hint`)}</span>
          <span className={styles.meta}>
            {matomoVersion ? t('version', { version: matomoVersion }) : t('versionUnknown')}
            {detectedAt ? ` · ${t('detectedAt', { when: formatDate(detectedAt) })}` : ''}
            {typeof siteCount === 'number' ? ` · ${t('siteCount', { count: siteCount })}` : ''}
          </span>
        </div>
      </Callout>

      {limitationKeys.length > 0 ? (
        <section className={styles.limitations} aria-label={t('limitations')}>
          <h4 className={styles.heading}>{t('limitations')}</h4>
          <ul className={styles.list}>
            {limitationKeys.map((key) => (
              <li key={key}>{translate(tMatomo, key)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {probes.length > 0 ? (
        <details className={styles.probes} open={!compact}>
          <summary className={styles.summary}>{t('capabilities')}</summary>
          {(['technical', 'core', 'optional'] as const).map((tier) =>
            byTier[tier].length === 0 ? null : (
              <section key={tier} className={styles.tier}>
                <h4 className={styles.heading}>{t(`tier.${tier}`)}</h4>
                <ul className={styles.probeList}>
                  {byTier[tier].map((probe) => (
                    <li key={probe.capability} className={styles.probe} data-state={probe.state}>
                      <span className={styles.probeName}>
                        {translateCapability(tCapability, probe.capability)}
                      </span>
                      {/* The state is a word, so it does not depend on the marker. */}
                      <span className={styles.probeState}>{t(`state.${probe.state}`)}</span>
                      {probe.detailKey ? (
                        <span className={styles.probeDetail}>
                          {translate(tMatomo, probe.detailKey)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </details>
      ) : null}
    </div>
  );
}

const TONE: Record<MatomoCompatibility, CalloutTone> = {
  supported: 'success',
  supported_with_limitations: 'warning',
  technically_compatible_not_certified: 'info',
  unsupported: 'critical',
};

type Translator = ReturnType<typeof useTranslations>;

function groupByTier(
  probes: readonly CapabilityProbeResult[],
): Record<CapabilityTier, CapabilityProbeResult[]> {
  const grouped: Record<CapabilityTier, CapabilityProbeResult[]> = {
    technical: [],
    core: [],
    optional: [],
  };
  for (const probe of probes) grouped[capabilityTier(probe.capability)].push(probe);
  return grouped;
}

/**
 * Resolves a key the API produced, falling back to the key's own tail.
 *
 * A missing translation must not print `matomo.capability.something` at a user;
 * it degrades to something readable instead.
 */
function translate(t: Translator, key: string): string {
  const relative = key.startsWith('matomo.') ? key.slice('matomo.'.length) : key;
  return t.has(relative) ? t(relative) : relative.split('.').pop()!;
}

function translateCapability(t: Translator, capability: string): string {
  return t.has(capability) ? t(capability) : capability;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
