'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  type DashboardSnapshot,
  placeNewWidget,
  type SemanticDefinitionRef,
  type WidgetConfig,
  WIDGET_FAMILIES,
  type WidgetFamily,
} from '@axp/contracts';
import { Button, SelectField } from '@axp/ui';
import styles from './WidgetGallery.module.css';

export interface WidgetGalleryProps {
  readonly snapshot: DashboardSnapshot;
  readonly metrics: readonly SemanticDefinitionRef[];
  readonly onAdd: (widget: WidgetConfig) => void;
}

/** Which families a ready-made template can be built for from one metric. */
interface Template {
  readonly key: string;
  readonly family: WidgetFamily;
  readonly dimension?: string;
  readonly showComparison: boolean;
}

const TEMPLATES: readonly Template[] = [
  { key: 'kpi', family: 'card', showComparison: true },
  { key: 'trend', family: 'time_series', showComparison: true },
  { key: 'topPages', family: 'flexible_table', dimension: 'page_url', showComparison: false },
  { key: 'ranking', family: 'bar', dimension: 'page_url', showComparison: false },
  { key: 'share', family: 'donut', dimension: 'page_url', showComparison: false },
];

/**
 * Templates first, blank second (D3).
 *
 * The order is the decision: someone adding a widget usually wants "visits over
 * time", not "an empty time series I will now configure". Blank widgets stay
 * available for the case the templates do not cover, one click further away.
 *
 * A template is copied on insert - it becomes an ordinary widget with no link
 * back, so editing it later cannot be surprised by the template changing (D7).
 */
export function WidgetGallery({ snapshot, metrics, onAdd }: WidgetGalleryProps) {
  const t = useTranslations('editor');
  const usable = useMemo(() => metrics.filter((metric) => metric.currentVersionId), [metrics]);
  const [metricId, setMetricId] = useState(usable[0]?.currentVersionId ?? '');

  const metric = usable.find((candidate) => candidate.currentVersionId === metricId);

  function add(family: WidgetFamily, template?: Template) {
    const id = `w-${Math.random().toString(36).slice(2, 10)}`;

    onAdd({
      id,
      family,
      title: template && metric ? `${metric.name}` : t(`family.${family}`),
      placement: { desktop: placeNewWidget(snapshot.widgets, family) },
      data: {
        // A blank widget carries no metric on purpose: publishing warns about
        // it rather than the gallery inventing a choice.
        semanticVersionIds: template && metric?.currentVersionId ? [metric.currentVersionId] : [],
        ...(template?.dimension ? { dimension: template.dimension, topN: 8 } : {}),
        fixedFilters: [],
      },
      presentation: {
        showComparison: template?.showComparison ?? false,
        ...(family === 'card' ? { variant: 'kpi_comparison' } : {}),
      },
      context: { showDefinition: Boolean(template) },
    });
  }

  return (
    <section className={styles.gallery} aria-label={t('gallery')}>
      <h2 className={styles.heading}>{t('gallery')}</h2>

      {usable.length === 0 ? (
        <p className={styles.hint}>{t('noMetrics')}</p>
      ) : (
        <>
          <SelectField
            label={t('galleryMetric')}
            value={metricId}
            options={usable.map((candidate) => ({
              value: candidate.currentVersionId!,
              label: candidate.name,
            }))}
            onChange={(event) => setMetricId(event.target.value)}
          />

          <ul className={styles.templates}>
            {TEMPLATES.map((template) => (
              <li key={template.key}>
                <button
                  type="button"
                  className={styles.template}
                  onClick={() => add(template.family, template)}
                >
                  <span className={styles.templateName}>{t(`template.${template.key}`)}</span>
                  <span className={styles.templateFamily}>{t(`family.${template.family}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <details className={styles.blank}>
        <summary className={styles.blankSummary}>{t('blankWidgets')}</summary>
        <div className={styles.blankGrid}>
          {WIDGET_FAMILIES.map((family) => (
            <Button key={family} type="button" onClick={() => add(family)}>
              {t(`family.${family}`)}
            </Button>
          ))}
        </div>
      </details>
    </section>
  );
}
