'use client';

import { useId, useMemo } from 'react';
import styles from './DonutChart.module.css';

export interface DonutSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export interface DonutChartProps {
  readonly slices: readonly DonutSlice[];
  readonly numberFormat?: { readonly locale: string; readonly decimals?: number };
  readonly ariaLabel: string;
  readonly emptyLabel: string;
  /** Everything past this many slices folds into one "Other" segment. */
  readonly maxSlices?: number;
  readonly otherLabel: string;
  /** Shown in the hole. The whole, in the unit the parts are in. */
  readonly totalLabel: string;
}

const SIZE = 200;
const RADIUS = 80;
const THICKNESS = 28;
/** A 2px surface gap separates touching segments; no stroke does that job. */
const GAP_DEGREES = 1.2;

/**
 * Part-to-whole for a small number of categories.
 *
 * A donut rather than a pie, and never more than a handful of segments: angle
 * is a weak channel, so the reader is given the numbers as well and the tail is
 * folded into one "Other" instead of becoming a ring of slivers.
 *
 * Categorical colours are assigned in fixed order and never cycled - a ninth
 * category folds into "Other" rather than reusing slot 1, so a colour always
 * means the same category.
 */
export function DonutChart({
  slices,
  numberFormat,
  ariaLabel,
  emptyLabel,
  maxSlices = 6,
  otherLabel,
  totalLabel,
}: DonutChartProps) {
  const titleId = useId();

  const format = useMemo(() => {
    const formatter = new Intl.NumberFormat(numberFormat?.locale ?? 'de-DE', {
      minimumFractionDigits: numberFormat?.decimals ?? 0,
      maximumFractionDigits: numberFormat?.decimals ?? 0,
    });
    const percent = new Intl.NumberFormat(numberFormat?.locale ?? 'de-DE', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return { value: formatter.format.bind(formatter), percent: percent.format.bind(percent) };
  }, [numberFormat?.locale, numberFormat?.decimals]);

  const folded = useMemo(
    () => fold(slices, maxSlices, otherLabel),
    [slices, maxSlices, otherLabel],
  );
  const total = folded.reduce((sum, slice) => sum + slice.value, 0);

  if (folded.length === 0 || total <= 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  let cursor = -90; // Twelve o'clock, so the largest share starts where a reader looks.
  const arcs = folded.map((slice, index) => {
    const sweep = (slice.value / total) * 360;
    const start = cursor + GAP_DEGREES / 2;
    const end = cursor + sweep - GAP_DEGREES / 2;
    cursor += sweep;

    return {
      ...slice,
      share: slice.value / total,
      // A slice too small to carry a gap is drawn without one rather than
      // inverted into a backwards arc.
      path: end > start ? arcPath(start, end) : null,
      color: slice.key === '__other__' ? 'var(--chart-series-other)' : seriesColor(index),
    };
  });

  return (
    <div className={styles.chart}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={styles.svg}
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{ariaLabel}</title>
        {arcs.map((arc) =>
          arc.path ? <path key={arc.key} d={arc.path} fill={arc.color} /> : null,
        )}
        <text className={styles.total} x={SIZE / 2} y={SIZE / 2 - 4} textAnchor="middle">
          {format.value(total)}
        </text>
        <text className={styles.totalLabel} x={SIZE / 2} y={SIZE / 2 + 14} textAnchor="middle">
          {totalLabel}
        </text>
      </svg>

      {/*
        The legend is always present: identity must never depend on telling two
        hues apart. The swatch carries the colour, the text stays in ink.
      */}
      <ul className={styles.legend}>
        {arcs.map((arc) => (
          <li key={arc.key} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: arc.color }} aria-hidden="true" />
            <span className={styles.legendLabel} title={arc.label}>
              {arc.label}
            </span>
            <span className={`${styles.legendValue} axp-numeric`}>
              {format.percent(arc.share * 100)} %
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Keeps the largest categories and sums the rest into one segment.
 *
 * A ring of slivers is unreadable and, worse, implies the tail matters
 * individually when the chart cannot show that it does.
 */
function fold(slices: readonly DonutSlice[], maxSlices: number, otherLabel: string): DonutSlice[] {
  const sorted = [...slices].filter((slice) => slice.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= maxSlices) return sorted;

  const kept = sorted.slice(0, maxSlices - 1);
  const rest = sorted.slice(maxSlices - 1);
  return [
    ...kept,
    {
      key: '__other__',
      label: otherLabel,
      value: rest.reduce((sum, slice) => sum + slice.value, 0),
    },
  ];
}

/** Fixed slot order, never cycled: a ninth category folds into "Other". */
function seriesColor(index: number): string {
  return `var(--chart-series-${Math.min(index + 1, 8)})`;
}

function arcPath(startDegrees: number, endDegrees: number): string {
  const outer = RADIUS;
  const inner = RADIUS - THICKNESS;
  const center = SIZE / 2;

  const p = (radius: number, degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return [center + radius * Math.cos(radians), center + radius * Math.sin(radians)] as const;
  };

  const largeArc = endDegrees - startDegrees > 180 ? 1 : 0;
  const [x1, y1] = p(outer, startDegrees);
  const [x2, y2] = p(outer, endDegrees);
  const [x3, y3] = p(inner, endDegrees);
  const [x4, y4] = p(inner, startDegrees);

  return [
    `M ${x1} ${y1}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}
