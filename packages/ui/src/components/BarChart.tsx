'use client';

import { useMemo } from 'react';
import styles from './BarChart.module.css';

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  /** Null is a gap, not a zero: a category without a value is not a short bar. */
  readonly value: number | null;
  /** Comparison value, drawn as a thin marker rather than a second bar. */
  readonly comparisonValue?: number | null;
}

export interface BarChartProps {
  readonly data: readonly BarDatum[];
  readonly numberFormat?: { readonly locale: string; readonly decimals?: number };
  readonly unitSuffix?: string;
  /** Accessible summary read instead of the drawing. */
  readonly ariaLabel: string;
  readonly comparisonLabel?: string;
  readonly emptyLabel: string;
}

/**
 * Horizontal bar chart for a ranked breakdown.
 *
 * Horizontal rather than vertical because the categories are page paths and
 * campaign names: rotated labels are a workaround for the wrong orientation.
 *
 * Built as layout rather than as a drawing - a bar chart is a list of rows with
 * a width, and expressing it that way makes it reflow, zoom and wrap like text
 * instead of like a picture.
 *
 * Mark conventions: bars capped at 24px so the row keeps its air, a rounded end
 * only where the data stops and a square edge at the baseline, one sequential
 * hue because this compares magnitude rather than identity, values at the tip
 * rather than on every gridline, and a comparison drawn as a tick so it cannot
 * be mistaken for a second category.
 */
export function BarChart({
  data,
  numberFormat,
  unitSuffix,
  ariaLabel,
  comparisonLabel,
  emptyLabel,
}: BarChartProps) {
  const format = useMemo(() => {
    const formatter = new Intl.NumberFormat(numberFormat?.locale ?? 'de-DE', {
      minimumFractionDigits: numberFormat?.decimals ?? 0,
      maximumFractionDigits: numberFormat?.decimals ?? 0,
    });
    return (value: number) => `${formatter.format(value)}${unitSuffix ? ` ${unitSuffix}` : ''}`;
  }, [numberFormat?.locale, numberFormat?.decimals, unitSuffix]);

  // The scale spans the comparison too, so a bar that shrank still reads as
  // shorter than the tick it is being compared against.
  const max = useMemo(() => {
    const values = data.flatMap((datum) =>
      [datum.value, datum.comparisonValue].filter(
        (value): value is number => value !== null && value !== undefined,
      ),
    );
    return values.length === 0 ? 0 : Math.max(...values);
  }, [data]);

  if (data.length === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  return (
    <div className={styles.chart} role="img" aria-label={ariaLabel}>
      <ul className={styles.rows}>
        {data.map((datum) => {
          const share = max > 0 && datum.value !== null ? (datum.value / max) * 100 : 0;
          const comparisonShare =
            max > 0 && datum.comparisonValue !== null && datum.comparisonValue !== undefined
              ? (datum.comparisonValue / max) * 100
              : null;

          return (
            <li key={datum.key} className={styles.row}>
              <span className={styles.label} title={datum.label}>
                {datum.label}
              </span>

              <span className={styles.track}>
                {/*
                  A missing value leaves the track empty rather than drawing a
                  zero-length bar, because "not measured" and "none" are
                  different facts (D10).
                */}
                {datum.value === null ? null : (
                  <span className={styles.bar} style={{ inlineSize: `${share}%` }} />
                )}

                {comparisonShare === null ? null : (
                  <span
                    className={styles.comparison}
                    style={{ insetInlineStart: `${comparisonShare}%` }}
                    title={comparisonLabel}
                  />
                )}
              </span>

              <span className={`${styles.value} axp-numeric`}>
                {datum.value === null ? '–' : format(datum.value)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
