import { getTranslations } from 'next-intl/server';
import { DataTable, LineChart, type LineSeries } from '@axp/ui';
import { hasNumericValue, type WidgetPresentation } from '@axp/contracts';
import styles from './WidgetContent.module.css';

/**
 * Renders the data of a widget whose state carries values.
 *
 * States without a value never reach this component - `WidgetFrame` handles
 * those - so nothing here has to invent a placeholder number.
 */
export async function WidgetContent({ widget }: { readonly widget: WidgetPresentation }) {
  switch (widget.content?.kind) {
    case 'card':
      return <CardContent widget={widget} />;
    case 'time_series':
      return <SeriesContent widget={widget} />;
    case 'table':
      return <TableContent widget={widget} />;
    case 'text':
      return <p className={styles.text}>{widget.content.body}</p>;
    default:
      return null;
  }
}

async function CardContent({ widget }: { readonly widget: WidgetPresentation }) {
  const t = await getTranslations();
  if (widget.content?.kind !== 'card') return null;

  return (
    <div className={styles.metrics}>
      {widget.content.metrics.map((metric) => {
        const ratio = metric.comparison?.changeRatio;
        const direction =
          ratio === undefined ? null : ratio > 0 ? 'up' : ratio < 0 ? 'down' : 'flat';

        return (
          <div key={metric.semanticVersionId} className={styles.metric}>
            <span className={`${styles.value} axp-numeric`}>{metric.formatted}</span>

            {metric.comparison ? (
              <span className={styles.comparison} data-direction={direction ?? 'none'}>
                {/*
                  An arrow plus a signed number plus a label: three channels, so
                  the direction never depends on colour (D10).
                */}
                <span aria-hidden="true">
                  {direction === 'up' ? '▲' : direction === 'down' ? '▼' : '■'}
                </span>
                <span className="axp-numeric">
                  {ratio === undefined
                    ? t('viewer.noComparableValue')
                    : `${ratio > 0 ? '+' : ''}${(ratio * 100).toLocaleString('de-DE', {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })} %`}
                </span>
                <span className={styles.comparisonLabel}>{t('viewer.comparedToPrevious')}</span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

async function SeriesContent({ widget }: { readonly widget: WidgetPresentation }) {
  const t = await getTranslations();
  if (widget.content?.kind !== 'time_series') return null;

  const [primary] = widget.content.series;
  if (!primary) return null;

  const label = widget.content.labels[0] ?? widget.title;
  const dateLabels = primary.points.map((point) => formatShortDate(point.date));

  const series: LineSeries[] = [
    {
      id: primary.semanticVersionId,
      label,
      colorSlot: 1,
      points: primary.points.map((point) =>
        hasNumericValue(point.value) ? point.value.value : null,
      ),
    },
  ];

  if (primary.comparisonPoints) {
    series.push({
      id: `${primary.semanticVersionId}-comparison`,
      label: t('viewer.previousPeriod'),
      role: 'comparison',
      points: primary.comparisonPoints.map((point) =>
        hasNumericValue(point.value) ? point.value.value : null,
      ),
    });
  }

  return (
    <div className={styles.chart}>
      <LineChart
        labels={dateLabels}
        series={series}
        ariaLabel={t('viewer.chartAria', { title: widget.title, points: primary.points.length })}
        numberFormat={{ locale: 'de-DE' }}
      />

      {/*
        Every chart ships its data as a table. Required by D10, and the same
        table is what an export reads.
      */}
      <details className={styles.dataAlternative}>
        <summary className={styles.dataAlternativeSummary}>{t('viewer.showDataTable')}</summary>
        <DataTable
          caption={t('viewer.chartTableCaption', { title: widget.title })}
          captionHidden
          columns={[
            { key: 'date', label: t('viewer.date') },
            { key: 'value', label, numeric: true },
            ...(primary.comparisonPoints
              ? [{ key: 'comparison', label: t('viewer.previousPeriod'), numeric: true }]
              : []),
          ]}
          rows={primary.points.map((point, index) => ({
            key: point.date,
            cells: {
              date: formatShortDate(point.date),
              value: hasNumericValue(point.value)
                ? point.value.value.toLocaleString('de-DE')
                : t(`states.${point.value.state}`),
              comparison: (() => {
                const comparison = primary.comparisonPoints?.[index]?.value;
                if (!comparison) return '';
                return hasNumericValue(comparison)
                  ? comparison.value.toLocaleString('de-DE')
                  : t(`states.${comparison.state}`);
              })(),
            },
          }))}
        />
      </details>
    </div>
  );
}

async function TableContent({ widget }: { readonly widget: WidgetPresentation }) {
  const t = await getTranslations();
  if (widget.content?.kind !== 'table') return null;

  const { columns, rows } = widget.content;

  return (
    <DataTable
      caption={widget.title}
      captionHidden
      emptyLabel={t('states.empty')}
      columns={columns.map((column, index) => ({
        key: column.key,
        label: column.label,
        numeric: index > 0,
      }))}
      rows={rows.map((row) => ({
        key: row.key,
        cells: {
          label: row.label,
          ...Object.fromEntries(
            row.metrics.map((metric) => [
              metric.semanticVersionId,
              hasNumericValue(metric.value)
                ? metric.value.value.toLocaleString('de-DE')
                : t(`states.${metric.value.state}`),
            ]),
          ),
        },
      }))}
    />
  );
}

/** `2026-09-19` becomes `19.09.` - enough to read an axis without crowding it. */
function formatShortDate(date: string): string {
  const [, month, day] = date.split('-');
  return month && day ? `${day}.${month}.` : date;
}
