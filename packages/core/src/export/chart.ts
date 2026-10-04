import type { Locale } from '@axp/contracts';
import type { ExportChart } from './document';
import { formatNumber } from './document';
import { EXPORT_PALETTE, type ExportPalette } from './palette';

/**
 * Line chart geometry for export files.
 *
 * One computation, two drawings: the PDF renderer draws it as vectors, the
 * PPTX renderer as an image made from the SVG below. Straight segments only
 * (D2), and a value without a number breaks the line - a gap is drawn as a
 * gap, never as a drop to zero (D10).
 */

export interface ChartBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartGeometry {
  readonly plot: ChartBox;
  readonly yTicks: readonly { readonly y: number; readonly label: string }[];
  readonly xLabels: readonly { readonly x: number; readonly label: string }[];
  readonly series: readonly {
    readonly label: string;
    readonly role: 'primary' | 'comparison';
    /** Runs of consecutive points with a value; a gap starts a new run. */
    readonly segments: readonly (readonly { readonly x: number; readonly y: number }[])[];
  }[];
}

export function chartGeometry(chart: ExportChart, box: ChartBox, locale: Locale): ChartGeometry {
  const values = chart.series.flatMap((series) =>
    series.values.filter((value): value is number => value !== null),
  );
  const { min, max, step } = niceScale(values);

  const labelWidth = 44;
  const plot: ChartBox = {
    x: box.x + labelWidth,
    y: box.y + 6,
    width: Math.max(10, box.width - labelWidth - 36),
    height: Math.max(10, box.height - 34),
  };

  const count = Math.max(1, chart.dates.length);
  const xOf = (index: number) =>
    count === 1 ? plot.x + plot.width / 2 : plot.x + (index / (count - 1)) * plot.width;
  const yOf = (value: number) =>
    max === min
      ? plot.y + plot.height / 2
      : plot.y + plot.height - ((value - min) / (max - min)) * plot.height;

  const yTicks: { y: number; label: string }[] = [];
  for (let value = min; value <= max + step / 2; value += step) {
    yTicks.push({ y: yOf(value), label: formatNumber(value, decimalsFor(step), locale) });
  }

  // At most eight date labels, evenly spread, always including the last.
  const every = Math.max(1, Math.ceil(count / 8));
  const xLabels = chart.dates
    .map((label, index) => ({ x: xOf(index), label, index }))
    .filter((entry) => entry.index % every === 0 || entry.index === count - 1)
    .map(({ x, label }) => ({ x, label }));

  return {
    plot,
    yTicks,
    xLabels,
    series: chart.series.map((series) => {
      const segments: { x: number; y: number }[][] = [];
      let current: { x: number; y: number }[] = [];
      series.values.forEach((value, index) => {
        if (value === null) {
          if (current.length > 0) segments.push(current);
          current = [];
          return;
        }
        current.push({ x: xOf(index), y: yOf(value) });
      });
      if (current.length > 0) segments.push(current);
      return { label: series.label, role: series.role, segments };
    }),
  };
}

/** Axis bounds on round numbers; zero is included when the data allows it. */
export function niceScale(values: readonly number[]): { min: number; max: number; step: number } {
  if (values.length === 0) return { min: 0, max: 1, step: 0.25 };
  let low = Math.min(0, ...values);
  let high = Math.max(...values);
  if (low === high) high = low + 1;

  const rough = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((s) => s >= rough)!;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  return { min: low, max: high, step };
}

function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step)));
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The chart as SVG, for the image fallback in presentations.
 *
 * Carries its own legend, because an image cannot rely on the slide around it
 * for which line is which; the comparison line is dashed as well as grey, so
 * the difference does not depend on colour alone (D10).
 */
export function chartSvg(
  chart: ExportChart,
  options: {
    width: number;
    height: number;
    locale: Locale;
    title: string;
    palette?: ExportPalette;
  },
): string {
  const palette = options.palette ?? EXPORT_PALETTE;
  const legendHeight = 26;
  const geometry = chartGeometry(
    chart,
    {
      x: 8,
      y: legendHeight + 4,
      width: options.width - 16,
      height: options.height - legendHeight - 8,
    },
    options.locale,
  );
  const { plot } = geometry;
  const font = `font-family="DejaVu Sans" font-size="12"`;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">`,
    `<title>${escapeXml(options.title)}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];

  for (const tick of geometry.yTicks) {
    parts.push(
      `<line x1="${plot.x}" y1="${tick.y}" x2="${plot.x + plot.width}" y2="${tick.y}" stroke="${palette.chartGrid}" stroke-width="1"/>`,
      `<text x="${plot.x - 6}" y="${tick.y + 4}" text-anchor="end" fill="${palette.textMuted}" ${font}>${escapeXml(tick.label)}</text>`,
    );
  }
  parts.push(
    `<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="${palette.chartAxis}" stroke-width="1"/>`,
  );
  for (const label of geometry.xLabels) {
    parts.push(
      `<text x="${label.x}" y="${plot.y + plot.height + 18}" text-anchor="middle" fill="${palette.textMuted}" ${font}>${escapeXml(label.label)}</text>`,
    );
  }

  // Comparison first, so the primary line is drawn on top of it.
  const ordered = [
    ...geometry.series.filter((series) => series.role === 'comparison'),
    ...geometry.series.filter((series) => series.role !== 'comparison'),
  ];
  for (const series of ordered) {
    const colour = series.role === 'comparison' ? palette.chartComparison : palette.chartSeries1;
    const dash = series.role === 'comparison' ? ` stroke-dasharray="6 4"` : '';
    for (const segment of series.segments) {
      if (segment.length === 1) {
        parts.push(`<circle cx="${segment[0]!.x}" cy="${segment[0]!.y}" r="3" fill="${colour}"/>`);
        continue;
      }
      const points = segment
        .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
        .join(' ');
      parts.push(
        `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="2.5" stroke-linejoin="round"${dash}/>`,
      );
    }
  }

  // Legend: a sample of each line and its name.
  let legendX = 12;
  for (const series of chart.series) {
    const colour = series.role === 'comparison' ? palette.chartComparison : palette.chartSeries1;
    const dash = series.role === 'comparison' ? ` stroke-dasharray="6 4"` : '';
    parts.push(
      `<line x1="${legendX}" y1="14" x2="${legendX + 24}" y2="14" stroke="${colour}" stroke-width="2.5"${dash}/>`,
      `<text x="${legendX + 30}" y="18" fill="${palette.textSecondary}" ${font}>${escapeXml(series.label)}</text>`,
    );
    legendX += 40 + series.label.length * 7.5;
  }

  parts.push('</svg>');
  return parts.join('');
}
