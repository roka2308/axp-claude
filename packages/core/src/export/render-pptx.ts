import PptxGenJS from 'pptxgenjs';
import { Resvg } from '@resvg/resvg-js';
import { chartSvg } from './chart';
import type { ExportDocument, ExportMetric, ExportTable, ExportWidget } from './document';
import { fill } from './labels';
import { exportFonts } from './fonts';
import { EXPORT_PALETTE } from './palette';

/**
 * A dashboard as a presentation - hybrid (Master Spec §15).
 *
 * Simple elements are native and editable: titles, key figures with their
 * evaluation, comparisons, tables, text. Charts are a high-resolution image
 * rendered from the same model, because a native chart that looks different
 * from the dashboard is worse than a picture of the right one. Every image
 * carries a text alternative, and its values are in the slide notes, so the
 * numbers are never only pixels (D10).
 */

const SLIDE = { width: 13.333, height: 7.5, margin: 0.5 } as const;
const FONT = 'Arial';
const TABLE_ROWS_PER_SLIDE = 12;
const CARDS_PER_SLIDE = 6;

type Slide = ReturnType<PptxGenJS['addSlide']>;

export async function renderPptx(document: ExportDocument): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Analytics Experience';
  pptx.company = document.tenantName;
  pptx.title = document.title;
  pptx.subject = document.periodText;
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };

  const labels = document.labels;
  const hasCharts = document.widgets.some((widget) => widget.kind === 'series');

  // --- Title slide: what the deck describes ---------------------------------
  const title = pptx.addSlide();
  title.addText(document.title, {
    x: SLIDE.margin,
    y: 0.5,
    w: SLIDE.width - 1,
    h: 0.9,
    fontFace: FONT,
    fontSize: 30,
    bold: true,
    color: hex(EXPORT_PALETTE.textPrimary),
  });
  if (document.description) {
    title.addText(document.description, {
      x: SLIDE.margin,
      y: 1.4,
      w: SLIDE.width - 1,
      h: 0.6,
      fontFace: FONT,
      fontSize: 14,
      color: hex(EXPORT_PALETTE.textSecondary),
    });
  }
  title.addTable(
    document.meta.map((row) => [
      { text: row.label, options: { bold: true, color: hex(EXPORT_PALETTE.textSecondary) } },
      { text: row.value, options: { color: hex(EXPORT_PALETTE.textPrimary) } },
    ]),
    {
      x: SLIDE.margin,
      y: 2.2,
      w: SLIDE.width - 1,
      colW: [2.6, SLIDE.width - 3.6],
      fontFace: FONT,
      fontSize: 12,
      border: { type: 'solid', pt: 0.5, color: hex(EXPORT_PALETTE.borderSubtle) },
    },
  );
  if (hasCharts) {
    title.addText(labels.hybridNote, {
      x: SLIDE.margin,
      y: SLIDE.height - 1.0,
      w: SLIDE.width - 1,
      h: 0.4,
      fontFace: FONT,
      fontSize: 10,
      italic: true,
      color: hex(EXPORT_PALETTE.textMuted),
    });
  }

  // --- Key figures: native text boxes ---------------------------------------
  const cards = document.widgets.filter((widget) => widget.kind === 'metrics');
  const cardEntries = cards.flatMap((widget) =>
    (widget.metrics ?? []).map((metric) => ({ widget, metric })),
  );
  for (let start = 0; start < cardEntries.length; start += CARDS_PER_SLIDE) {
    const slide = pptx.addSlide();
    heading(
      slide,
      start === 0 ? labels.metricsSheet : fill(labels.continued, { title: labels.metricsSheet }),
    );
    cardEntries.slice(start, start + CARDS_PER_SLIDE).forEach((entry, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      card(slide, entry.widget, entry.metric, document, {
        x: SLIDE.margin + column * 4.15,
        y: 1.3 + row * 2.75,
      });
    });
    footer(slide, document);
  }

  // --- One slide per remaining widget ---------------------------------------
  for (const widget of document.widgets) {
    if (widget.kind === 'metrics') continue;

    if (widget.kind === 'series' && widget.chart) {
      const slide = pptx.addSlide();
      heading(slide, widget.title);
      const svg = chartSvg(widget.chart, {
        width: 1200,
        height: 520,
        locale: document.locale,
        title: widget.title,
      });
      const png = new Resvg(svg, {
        font: {
          fontFiles: [exportFonts().regular, exportFonts().bold],
          loadSystemFonts: false,
          defaultFontFamily: 'DejaVu Sans',
        },
        fitTo: { mode: 'width', value: 2400 },
        background: '#ffffff',
      })
        .render()
        .asPng();
      slide.addImage({
        data: `data:image/png;base64,${png.toString('base64')}`,
        x: SLIDE.margin,
        y: 1.2,
        w: SLIDE.width - 1,
        h: (SLIDE.width - 1) * (520 / 1200),
        altText: fill(labels.chartAltNotes, {
          title: widget.title,
          points: widget.chart.dates.length,
        }),
      });
      notes(slide, widget);
      footer(slide, document);
      continue;
    }

    if ((widget.kind === 'table' || widget.kind === 'annotations') && widget.table) {
      const pages = Math.max(1, Math.ceil(widget.table.rows.length / TABLE_ROWS_PER_SLIDE));
      for (let page = 0; page < pages; page += 1) {
        const slide = pptx.addSlide();
        heading(slide, page === 0 ? widget.title : fill(labels.continued, { title: widget.title }));
        if (widget.table.rows.length === 0) {
          body(slide, widget.kind === 'annotations' ? labels.noAnnotations : widget.stateLabel);
        } else {
          nativeTable(slide, widget.table, page * TABLE_ROWS_PER_SLIDE);
        }
        footer(slide, document);
      }
      continue;
    }

    // Text, and widgets without values: said in words on their own slide.
    const slide = pptx.addSlide();
    heading(slide, widget.title);
    body(
      slide,
      widget.kind === 'text'
        ? (widget.text ?? '')
        : [widget.stateLabel, widget.message].filter(Boolean).join(' – '),
    );
    footer(slide, document);
  }

  const output = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(output as ArrayBuffer);
}

function card(
  slide: Slide,
  widget: ExportWidget,
  metric: ExportMetric,
  document: ExportDocument,
  at: { x: number; y: number },
): void {
  const w = 3.95;
  slide.addShape('rect', {
    x: at.x,
    y: at.y,
    w,
    h: 2.5,
    fill: { color: 'FFFFFF' },
    line: { color: hex(EXPORT_PALETTE.borderDefault), width: 0.75 },
  });
  slide.addText(widget.metrics!.length > 1 ? `${widget.title} – ${metric.label}` : widget.title, {
    x: at.x + 0.15,
    y: at.y + 0.1,
    w: w - 0.3,
    h: 0.45,
    fontFace: FONT,
    fontSize: 12,
    color: hex(EXPORT_PALETTE.textSecondary),
  });
  slide.addText(metric.value.text, {
    x: at.x + 0.15,
    y: at.y + 0.55,
    w: w - 0.3,
    h: 0.8,
    fontFace: FONT,
    fontSize: metric.value.number === undefined ? 16 : 32,
    bold: true,
    color: hex(EXPORT_PALETTE.textPrimary),
  });
  let y = at.y + 1.4;
  if (metric.evaluation) {
    // The band's word carries the meaning; the square only repeats it (D10).
    slide.addShape('rect', {
      x: at.x + 0.15,
      y: y + 0.1,
      w: 0.16,
      h: 0.16,
      fill: {
        color: hex(
          EXPORT_PALETTE.evaluationBand[metric.evaluation.band - 1] ?? EXPORT_PALETTE.textMuted,
        ),
      },
      line: { color: 'FFFFFF', width: 0 },
    });
    slide.addText(`${document.labels.evaluationPrefix}: ${metric.evaluation.label}`, {
      x: at.x + 0.4,
      y,
      w: w - 0.55,
      h: 0.36,
      fontFace: FONT,
      fontSize: 12,
      color: hex(EXPORT_PALETTE.textPrimary),
    });
    y += 0.4;
  }
  if (metric.comparison || metric.change) {
    slide.addText(
      [
        metric.change ? `${document.labels.columns.change}: ${metric.change.text}` : '',
        metric.comparison
          ? `${document.labels.columns.comparisonValue}: ${metric.comparison.text}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        x: at.x + 0.15,
        y,
        w: w - 0.3,
        h: 0.6,
        fontFace: FONT,
        fontSize: 10,
        color: hex(EXPORT_PALETTE.textSecondary),
      },
    );
  }
}

function nativeTable(slide: Slide, table: ExportTable, offset: number): void {
  const rows = table.rows.slice(offset, offset + TABLE_ROWS_PER_SLIDE);
  const width = SLIDE.width - 1;
  const first = Math.min(4.2, width * 0.4);
  const rest = table.columns.length > 1 ? (width - first) / (table.columns.length - 1) : width;
  slide.addTable(
    [
      table.columns.map((column) => ({
        text: column.label,
        options: {
          bold: true,
          fill: { color: hex(EXPORT_PALETTE.surfaceSunken) },
          align: column.numeric ? ('right' as const) : ('left' as const),
        },
      })),
      ...rows.map((row) =>
        row.map((cell, index) => ({
          text: cell.text,
          options: {
            align:
              table.columns[index]?.numeric && cell.number !== undefined
                ? ('right' as const)
                : ('left' as const),
            ...(cell.number === undefined && cell.state && cell.state !== 'ready'
              ? { italic: true, color: hex(EXPORT_PALETTE.textSecondary) }
              : { color: hex(EXPORT_PALETTE.textPrimary) }),
          },
        })),
      ),
    ],
    {
      x: SLIDE.margin,
      y: 1.2,
      w: width,
      colW: table.columns.length > 1 ? [first, ...table.columns.slice(1).map(() => rest)] : [width],
      fontFace: FONT,
      fontSize: 11,
      border: { type: 'solid', pt: 0.5, color: hex(EXPORT_PALETTE.borderSubtle) },
    },
  );
}

/** The chart's values as text, so they are there for anyone who needs them. */
function notes(slide: Slide, widget: ExportWidget): void {
  if (!widget.table) return;
  const lines = [
    widget.table.columns.map((column) => column.label).join('\t'),
    ...widget.table.rows.map((row) => row.map((cell) => cell.text).join('\t')),
  ];
  slide.addNotes(lines.join('\n'));
}

function heading(slide: Slide, text: string): void {
  slide.addText(text, {
    x: SLIDE.margin,
    y: 0.35,
    w: SLIDE.width - 1,
    h: 0.7,
    fontFace: FONT,
    fontSize: 24,
    bold: true,
    color: hex(EXPORT_PALETTE.textPrimary),
  });
}

function body(slide: Slide, text: string): void {
  slide.addText(text, {
    x: SLIDE.margin,
    y: 1.3,
    w: SLIDE.width - 1,
    h: 4.5,
    fontFace: FONT,
    fontSize: 16,
    valign: 'top',
    color: hex(EXPORT_PALETTE.textPrimary),
  });
}

function footer(slide: Slide, document: ExportDocument): void {
  slide.addText(
    `${fill(document.labels.footer, { period: document.periodText })} · ${document.generatedAtText}`,
    {
      x: SLIDE.margin,
      y: SLIDE.height - 0.45,
      w: SLIDE.width - 2,
      h: 0.3,
      fontFace: FONT,
      fontSize: 9,
      color: hex(EXPORT_PALETTE.textMuted),
    },
  );
  slide.slideNumber = {
    x: SLIDE.width - 1.0,
    y: SLIDE.height - 0.45,
    fontFace: FONT,
    fontSize: 9,
    color: hex(EXPORT_PALETTE.textMuted),
  };
}

function hex(colour: string): string {
  return colour.replace('#', '').toUpperCase();
}
