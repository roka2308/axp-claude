'use client';

import { useId, useMemo, useState } from 'react';
import styles from './LineChart.module.css';

export interface LineSeries {
  readonly id: string;
  readonly label: string;
  /** Null marks a gap: a point without a value is not plotted as zero. */
  readonly points: readonly (number | null)[];
  /** Comparison series are drawn in the neutral comparison tone. */
  readonly role?: 'primary' | 'comparison';
  /** Slot 1-8 of the categorical palette. Assigned by the caller, never cycled. */
  readonly colorSlot?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export interface LineChartProps {
  readonly labels: readonly string[];
  readonly series: readonly LineSeries[];
  readonly height?: number;
  /**
   * How numbers are written on the axis and in the tooltip.
   *
   * A locale string rather than a formatter function: this is a client
   * component, and a function cannot cross the server/client boundary.
   */
  readonly numberFormat?: { readonly locale: string; readonly decimals?: number };
  /** Accessible summary read instead of the drawing. */
  readonly ariaLabel: string;
}

const PADDING = { top: 16, right: 12, bottom: 28, left: 52 };

/**
 * Time series chart.
 *
 * Deliberate choices, all of them from the specification rather than taste:
 *
 *   - straight line segments, no curve smoothing: a smoothed line invents
 *     values between measurements (D2);
 *   - a null point breaks the line rather than being drawn at zero, because
 *     "no value" and "zero" are different facts (D10);
 *   - the comparison series uses the neutral comparison tone, not a second
 *     series colour, so it can never be mistaken for another entity;
 *   - a legend is always present for two or more series, so identity never
 *     depends on colour alone;
 *   - the accessible data alternative is a real table, rendered by the caller
 *     beside the chart.
 */
export function LineChart({
  labels,
  series,
  height = 240,
  numberFormat,
  ariaLabel,
}: LineChartProps) {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const formatValue = useMemo(() => {
    const formatter = new Intl.NumberFormat(numberFormat?.locale ?? 'de-DE', {
      minimumFractionDigits: numberFormat?.decimals ?? 0,
      maximumFractionDigits: numberFormat?.decimals ?? 0,
    });
    return (value: number) => formatter.format(value);
  }, [numberFormat?.locale, numberFormat?.decimals]);

  const width = 640;
  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;

  const { min, max } = useMemo(() => bounds(series), [series]);

  const xFor = (index: number) =>
    labels.length <= 1
      ? PADDING.left + plotWidth / 2
      : PADDING.left + (index / (labels.length - 1)) * plotWidth;

  const yFor = (value: number) =>
    PADDING.top + plotHeight - ((value - min) / (max - min || 1)) * plotHeight;

  const ticks = useMemo(() => niceTicks(min, max, 4), [min, max]);

  return (
    <figure className={styles.figure}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio="none"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <title id={titleId}>{ariaLabel}</title>

        {/* Recessive grid: present enough to read a level, quiet enough to ignore. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={styles.grid}
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
            />
            <text
              className={styles.axisLabel}
              x={PADDING.left - 8}
              y={yFor(tick) + 4}
              textAnchor="end"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}

        {series.map((line) => (
          <path
            key={line.id}
            className={line.role === 'comparison' ? styles.comparisonLine : styles.line}
            style={
              line.role === 'comparison'
                ? undefined
                : { stroke: `var(--chart-series-${line.colorSlot ?? 1})` }
            }
            d={buildPath(line.points, xFor, yFor)}
            fill="none"
          />
        ))}

        {/* Crosshair on hover. An HTML chart is interactive by default. */}
        {hoverIndex !== null ? (
          <line
            className={styles.crosshair}
            x1={xFor(hoverIndex)}
            x2={xFor(hoverIndex)}
            y1={PADDING.top}
            y2={PADDING.top + plotHeight}
          />
        ) : null}

        {series.map((line) =>
          hoverIndex !== null && typeof line.points[hoverIndex] === 'number' ? (
            <circle
              key={`${line.id}-marker`}
              className={styles.marker}
              cx={xFor(hoverIndex)}
              cy={yFor(line.points[hoverIndex])}
              r={4}
              style={
                line.role === 'comparison'
                  ? { fill: 'var(--chart-comparison)' }
                  : { fill: `var(--chart-series-${line.colorSlot ?? 1})` }
              }
            />
          ) : null,
        )}

        {/* Invisible hit areas: the target is wider than the mark. */}
        {labels.map((label, index) => (
          <rect
            key={label + String(index)}
            x={xFor(index) - plotWidth / Math.max(labels.length, 1) / 2}
            y={PADDING.top}
            width={plotWidth / Math.max(labels.length, 1)}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(index)}
          />
        ))}

        <text className={styles.axisLabel} x={PADDING.left} y={height - 8}>
          {labels[0]}
        </text>
        <text
          className={styles.axisLabel}
          x={width - PADDING.right}
          y={height - 8}
          textAnchor="end"
        >
          {labels[labels.length - 1]}
        </text>
      </svg>

      {hoverIndex !== null ? (
        <div className={styles.tooltip} role="status">
          <span className={styles.tooltipDate}>{labels[hoverIndex]}</span>
          {series.map((line) => {
            const value = line.points[hoverIndex];
            return (
              <span key={line.id} className={styles.tooltipRow}>
                <span
                  className={styles.swatch}
                  style={{
                    background:
                      line.role === 'comparison'
                        ? 'var(--chart-comparison)'
                        : `var(--chart-series-${line.colorSlot ?? 1})`,
                  }}
                  aria-hidden="true"
                />
                {line.label}: {typeof value === 'number' ? formatValue(value) : '–'}
              </span>
            );
          })}
        </div>
      ) : null}

      {series.length >= 2 ? (
        <figcaption className={styles.legend}>
          {series.map((line) => (
            <span key={line.id} className={styles.legendItem}>
              <span
                className={styles.swatch}
                style={{
                  background:
                    line.role === 'comparison'
                      ? 'var(--chart-comparison)'
                      : `var(--chart-series-${line.colorSlot ?? 1})`,
                }}
                aria-hidden="true"
              />
              {line.label}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Builds the path, breaking it wherever a value is absent. */
function buildPath(
  points: readonly (number | null)[],
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): string {
  let path = '';
  let penDown = false;

  points.forEach((value, index) => {
    if (typeof value !== 'number') {
      penDown = false;
      return;
    }
    const command = penDown ? 'L' : 'M';
    path += `${command}${xFor(index).toFixed(1)},${yFor(value).toFixed(1)} `;
    penDown = true;
  });

  return path.trim();
}

function bounds(series: readonly LineSeries[]): { min: number; max: number } {
  const values = series.flatMap((line) =>
    line.points.filter((value): value is number => typeof value === 'number'),
  );
  if (values.length === 0) return { min: 0, max: 1 };

  const max = Math.max(...values);
  // Count scales start at zero: a truncated axis exaggerates change.
  return { min: Math.min(0, ...values), max: max === 0 ? 1 : max };
}

/** Round tick values, so the axis reads in human numbers. */
function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= rawStep) ?? magnitude * 10;

  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}
