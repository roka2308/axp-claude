import PDFDocument from 'pdfkit';
import { chartGeometry } from './chart';
import type { ExportChart, ExportDocument, ExportTable, ExportWidget } from './document';
import { fill } from './labels';
import { exportFonts } from './fonts';
import { EXPORT_PALETTE } from './palette';

/**
 * A dashboard as PDF (Master Spec §15).
 *
 * Drawn from the presentation model, not photographed from the screen
 * (Shared Contract §10): text stays text, charts are vectors, and every chart
 * is followed by the table of its values. The file is tagged - headings,
 * paragraphs, figures with a text alternative, tables with header cells - and
 * carries its language and title, so a screen reader can read it (D10).
 */

const PAGE = { margin: 40, footer: 28 } as const;

type Doc = InstanceType<typeof PDFDocument>;
type StructElement = ReturnType<Doc['struct']>;

export async function renderPdf(document: ExportDocument): Promise<Buffer> {
  const fonts = exportFonts();
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: {
      top: PAGE.margin,
      left: PAGE.margin,
      right: PAGE.margin,
      bottom: PAGE.margin + PAGE.footer,
    },
    bufferPages: true,
    tagged: true,
    lang: document.locale === 'en' ? 'en-GB' : 'de-DE',
    displayTitle: true,
    pdfVersion: '1.7',
    info: {
      Title: document.title,
      Author: 'Analytics Experience',
      Subject: document.periodText,
      Creator: 'Analytics Experience',
      CreationDate: document.generatedAt,
      ModDate: document.generatedAt,
    },
  } as PDFKit.PDFDocumentOptions);

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('Regular', fonts.regular);
  doc.registerFont('Bold', fonts.bold);

  const root = doc.struct('Document');
  doc.addStructure(root);
  const width = doc.page.width - PAGE.margin * 2;

  // --- Title and what the file describes ----------------------------------
  text(doc, root, 'H1', document.title, { font: 'Bold', size: 20 });
  if (document.description) {
    text(doc, root, 'P', document.description, { size: 10, colour: EXPORT_PALETTE.textSecondary });
  }
  doc.moveDown(0.5);
  table(
    doc,
    root,
    {
      columns: [
        { label: document.labels.columns.key, numeric: false },
        { label: document.labels.columns.value, numeric: false },
      ],
      rows: document.meta.map((row) => [{ text: row.label }, { text: row.value }]),
    },
    width,
    [170, '*'],
  );

  // --- Widgets, in the order the dashboard shows them ----------------------
  for (const widget of document.widgets) {
    ensureSpace(doc, 120);
    doc.moveDown(1);
    renderWidget(doc, root, widget, document, width);
  }

  root.end();

  // --- Footer on every page, marked as an artifact, not content -------------
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.markContent('Artifact', { type: 'Pagination' });
    doc
      .font('Regular')
      .fontSize(8)
      .fillColor(EXPORT_PALETTE.textMuted)
      .text(
        `${fill(document.labels.footer, { period: document.periodText })} · ${document.generatedAtText}`,
        PAGE.margin,
        doc.page.height - PAGE.margin,
        { width: width - 120, lineBreak: false },
      )
      .text(
        fill(document.labels.page, { page: index - range.start + 1, pages: range.count }),
        doc.page.width - PAGE.margin - 120,
        doc.page.height - PAGE.margin,
        { width: 120, align: 'right', lineBreak: false },
      );
    doc.endMarkedContent();
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return finished;
}

function renderWidget(
  doc: Doc,
  root: StructElement,
  widget: ExportWidget,
  document: ExportDocument,
  width: number,
): void {
  const section = doc.struct('Sect');
  root.add(section);

  text(doc, section, 'H2', widget.title, { font: 'Bold', size: 13 });

  if (widget.state !== 'ready' && widget.state !== 'zero' && widget.kind !== 'text') {
    // Key figures state their own absence below; here only the reason.
    const line =
      widget.kind === 'metrics'
        ? widget.message
        : [widget.stateLabel, widget.message].filter(Boolean).join(' – ');
    if (line)
      text(doc, section, 'P', line, {
        size: 9,
        colour: EXPORT_PALETTE.textSecondary,
      });
  }

  switch (widget.kind) {
    case 'metrics':
      for (const metric of widget.metrics ?? []) {
        ensureSpace(doc, 60);
        text(doc, section, 'P', metric.label, { size: 9, colour: EXPORT_PALETTE.textSecondary });
        // The value is its state in words when it has no number (D10).
        text(doc, section, 'P', metric.value.text, {
          font: 'Bold',
          size: metric.value.number === undefined ? 12 : 20,
        });
        if (metric.evaluation) {
          const y = doc.y + 3;
          // The band's word carries the meaning; the square only repeats it.
          doc.markContent('Artifact');
          doc
            .rect(PAGE.margin, y, 8, 8)
            .fill(
              EXPORT_PALETTE.evaluationBand[metric.evaluation.band - 1] ?? EXPORT_PALETTE.textMuted,
            );
          doc.endMarkedContent();
          doc.x = PAGE.margin + 14;
          text(
            doc,
            section,
            'P',
            `${document.labels.evaluationPrefix}: ${metric.evaluation.label}`,
            { size: 9 },
          );
          doc.x = PAGE.margin;
        }
        if (metric.comparison || metric.change) {
          const parts = [
            metric.comparison
              ? `${document.labels.columns.comparisonValue}: ${metric.comparison.text}`
              : '',
            metric.change ? `${document.labels.columns.change}: ${metric.change.text}` : '',
          ].filter(Boolean);
          text(doc, section, 'P', parts.join(' · '), {
            size: 9,
            colour: EXPORT_PALETTE.textSecondary,
          });
        }
        doc.moveDown(0.3);
      }
      break;

    case 'series':
      if (widget.chart) drawChart(doc, section, widget.chart, widget.title, document, width);
      if (widget.table) {
        text(doc, section, 'P', fill(document.labels.tableCaption, { title: widget.title }), {
          size: 8,
          colour: EXPORT_PALETTE.textMuted,
        });
        table(doc, section, widget.table, width * 0.6);
      }
      break;

    case 'table':
    case 'annotations':
      if (widget.table && widget.table.rows.length > 0) table(doc, section, widget.table, width);
      else if (widget.kind === 'annotations') {
        text(doc, section, 'P', document.labels.noAnnotations, { size: 9 });
      }
      break;

    case 'text':
      text(doc, section, 'P', widget.text ?? '', { size: 10 });
      break;

    case 'none':
      break;
  }

  if (widget.context && widget.kind !== 'text') {
    text(doc, section, 'P', `${document.labels.context}: ${widget.context}`, {
      size: 8,
      colour: EXPORT_PALETTE.textSecondary,
    });
  }
  if (widget.definition) {
    text(doc, section, 'P', `${document.labels.definition}: ${widget.definition}`, {
      size: 8,
      colour: EXPORT_PALETTE.textSecondary,
    });
  }
  for (const note of widget.dataQuality) {
    text(doc, section, 'P', `${document.labels.dataQuality}: ${note}`, {
      size: 8,
      colour: EXPORT_PALETTE.textSecondary,
    });
  }

  section.end();
}

function drawChart(
  doc: Doc,
  parent: StructElement,
  chart: ExportChart,
  title: string,
  document: ExportDocument,
  width: number,
): void {
  const height = 170;
  ensureSpace(doc, height + 30);
  const top = doc.y + 4;
  const geometry = chartGeometry(
    chart,
    { x: PAGE.margin, y: top + 16, width: Math.min(width, 520), height },
    document.locale,
  );

  const figure = doc.struct('Figure', {
    alt: fill(document.labels.chartAlt, { title, points: chart.dates.length }),
  });
  parent.add(figure);
  const content = doc.markStructureContent('Figure');

  // Legend: a sample of each line with its name.
  let legendX = PAGE.margin;
  for (const series of chart.series) {
    const colour =
      series.role === 'comparison' ? EXPORT_PALETTE.chartComparison : EXPORT_PALETTE.chartSeries1;
    doc.save().lineWidth(2).strokeColor(colour);
    if (series.role === 'comparison') doc.dash(4, { space: 3 });
    doc
      .moveTo(legendX, top + 6)
      .lineTo(legendX + 18, top + 6)
      .stroke();
    doc.undash().restore();
    doc
      .font('Regular')
      .fontSize(8)
      .fillColor(EXPORT_PALETTE.textSecondary)
      .text(series.label, legendX + 22, top + 2, { lineBreak: false });
    legendX += 40 + doc.widthOfString(series.label);
  }

  const { plot } = geometry;
  doc.font('Regular').fontSize(7).fillColor(EXPORT_PALETTE.textMuted);
  for (const tick of geometry.yTicks) {
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(EXPORT_PALETTE.chartGrid)
      .moveTo(plot.x, tick.y)
      .lineTo(plot.x + plot.width, tick.y)
      .stroke()
      .restore();
    doc.text(tick.label, plot.x - 42, tick.y - 3, { width: 38, align: 'right', lineBreak: false });
  }
  doc
    .save()
    .lineWidth(0.8)
    .strokeColor(EXPORT_PALETTE.chartAxis)
    .moveTo(plot.x, plot.y + plot.height)
    .lineTo(plot.x + plot.width, plot.y + plot.height)
    .stroke()
    .restore();
  for (const label of geometry.xLabels) {
    doc.text(label.label, label.x - 30, plot.y + plot.height + 5, {
      width: 60,
      align: 'center',
      lineBreak: false,
    });
  }

  const ordered = [
    ...geometry.series.filter((series) => series.role === 'comparison'),
    ...geometry.series.filter((series) => series.role !== 'comparison'),
  ];
  for (const series of ordered) {
    const colour =
      series.role === 'comparison' ? EXPORT_PALETTE.chartComparison : EXPORT_PALETTE.chartSeries1;
    for (const segment of series.segments) {
      doc.save().lineWidth(1.6).strokeColor(colour).fillColor(colour);
      if (series.role === 'comparison') doc.dash(4, { space: 3 });
      if (segment.length === 1) {
        doc.circle(segment[0]!.x, segment[0]!.y, 2).fill();
      } else {
        doc.moveTo(segment[0]!.x, segment[0]!.y);
        for (const point of segment.slice(1)) doc.lineTo(point.x, point.y);
        doc.stroke();
      }
      doc.undash().restore();
    }
  }

  doc.endMarkedContent();
  figure.add(content);
  figure.end();

  doc.x = PAGE.margin;
  doc.y = plot.y + plot.height + 22;
}

function table(
  doc: Doc,
  parent: StructElement,
  data: ExportTable,
  maxWidth: number,
  columnStyles?: (number | string)[],
): void {
  ensureSpace(doc, 40);
  doc.x = PAGE.margin;
  const header = data.columns.map((column) => ({
    text: column.label,
    type: 'TH' as const,
    font: { src: 'Bold', size: 8 },
    backgroundColor: EXPORT_PALETTE.surfaceSunken,
    align: { x: column.numeric ? ('right' as const) : ('left' as const), y: 'center' as const },
  }));
  const rows = data.rows.map((row) =>
    row.map((cell, index) => ({
      text: cell.text,
      font: { src: 'Regular', size: 8 },
      ...(cell.number === undefined && cell.state && cell.state !== 'ready'
        ? { textColor: EXPORT_PALETTE.textSecondary }
        : { textColor: EXPORT_PALETTE.textPrimary }),
      align: {
        x:
          data.columns[index]?.numeric && cell.number !== undefined
            ? ('right' as const)
            : ('left' as const),
        y: 'center' as const,
      },
    })),
  );

  doc.table({
    data: [header, ...rows],
    maxWidth,
    ...(columnStyles ? { columnStyles } : {}),
    defaultStyle: {
      border: { top: 0, left: 0, right: 0, bottom: 0.5 },
      borderColor: EXPORT_PALETTE.borderSubtle,
      padding: [3, 5, 3, 5],
    },
    structParent: parent,
  } as PDFKit.Mixins.TableOptionsWithData);
  doc.x = PAGE.margin;
  doc.moveDown(0.4);
}

function text(
  doc: Doc,
  parent: StructElement,
  type: string,
  value: string,
  style: { font?: 'Regular' | 'Bold'; size?: number; colour?: string },
): void {
  doc
    .font(style.font ?? 'Regular')
    .fontSize(style.size ?? 10)
    .fillColor(style.colour ?? EXPORT_PALETTE.textPrimary)
    .text(value, { structParent: parent, structType: type } as PDFKit.Mixins.TextOptions);
}

function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}
