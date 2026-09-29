import ExcelJS from 'exceljs';
import type { ExportCell, ExportDocument, ExportTable, ExportWidget } from './document';
import { EXPORT_PALETTE } from './palette';

/**
 * A dashboard as a workbook (Master Spec §15).
 *
 * The first sheet says what the workbook describes - scope, period,
 * comparison, version, when it was made - and lists its widgets with their
 * state. Every card's values share one sheet; every series, table and list
 * gets its own. Numbers are real numbers with the dashboard's decimals, so
 * a reader can calculate with them; a value without a number is its state in
 * words, in italics, and never a zero or an empty cell (D10).
 */
export async function renderXlsx(document: ExportDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Analytics Experience';
  workbook.title = document.title;
  workbook.subject = document.periodText;
  workbook.created = document.generatedAt;
  workbook.modified = document.generatedAt;

  const labels = document.labels;
  const names = new Set<string>();

  // --- Overview ------------------------------------------------------------
  const overview = workbook.addWorksheet(sheetName(labels.overview, names));
  overview.columns = [{ width: 26 }, { width: 70 }, { width: 28 }];
  overview.addRow([document.title]).font = { bold: true, size: 14 };
  if (document.description) overview.addRow([document.description]);
  overview.addRow([]);
  for (const row of document.meta) {
    const added = overview.addRow([row.label, row.value]);
    added.getCell(1).font = { bold: true };
  }
  overview.addRow([]);
  const contentsHeader = overview.addRow([labels.contents, labels.columns.state]);
  contentsHeader.font = { bold: true };

  // --- Metrics: every card on one sheet -------------------------------------
  const cards = document.widgets.filter((widget) => widget.kind === 'metrics');
  let metricsSheet: string | undefined;
  if (cards.length > 0) {
    metricsSheet = sheetName(labels.metricsSheet, names);
    const sheet = workbook.addWorksheet(metricsSheet, { views: [{ state: 'frozen', ySplit: 3 }] });
    sheet.addRow([labels.metricsSheet]).font = { bold: true, size: 13 };
    sheet.addRow([document.periodText]);
    const first = cards[0]!.table!;
    const header = sheet.addRow([
      labels.columns.widget,
      ...first.columns.map((column) => column.label),
    ]);
    styleHeader(header);
    for (const card of cards) {
      for (const row of card.table!.rows) {
        const added = sheet.addRow([card.title, ...row.map(cellValue)]);
        row.forEach((cell, index) => styleCell(added.getCell(index + 2), cell));
      }
    }
    sheet.columns = [
      { width: 32 },
      { width: 30 },
      { width: 14 },
      { width: 12 },
      { width: 16 },
      { width: 18 },
      { width: 16 },
    ];
    sheet.autoFilter = {
      from: { row: 3, column: 1 },
      to: { row: 3, column: first.columns.length + 1 },
    };
  }

  // --- One sheet per series, table and list ---------------------------------
  const targets = new Map<string, string>();
  for (const widget of document.widgets) {
    if (!widget.table || widget.kind === 'metrics') continue;
    const name = sheetName(widget.title, names);
    targets.set(widget.id, name);
    writeTableSheet(
      workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] }),
      widget,
      widget.table,
      document,
    );
  }

  for (const widget of document.widgets) {
    const target = widget.kind === 'metrics' ? metricsSheet : targets.get(widget.id);
    const added = overview.addRow([widget.title, stateText(widget)]);
    if (target) {
      added.getCell(1).value = {
        text: widget.title,
        hyperlink: `#'${target.replace(/'/g, "''")}'!A1`,
      };
      added.getCell(1).font = {
        color: { argb: argb(EXPORT_PALETTE.accentDefault) },
        underline: true,
      };
    }
    if (widget.text) overview.addRow(['', widget.text]).getCell(2).alignment = { wrapText: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

function writeTableSheet(
  sheet: ExcelJS.Worksheet,
  widget: ExportWidget,
  table: ExportTable,
  document: ExportDocument,
): void {
  sheet.addRow([widget.title]).font = { bold: true, size: 13 };
  sheet.addRow([document.periodText]);
  const notes = [widget.message, ...widget.dataQuality, widget.context].filter(Boolean).join(' · ');
  sheet.addRow([notes]);
  styleHeader(sheet.addRow(table.columns.map((column) => column.label)));
  for (const row of table.rows) {
    const added = sheet.addRow(row.map(cellValue));
    row.forEach((cell, index) => styleCell(added.getCell(index + 1), cell));
  }
  sheet.columns = table.columns.map((column, index) => ({
    width: index === 0 ? 34 : Math.max(14, Math.min(40, column.label.length + 4)),
  }));
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: table.columns.length } };
}

function cellValue(cell: ExportCell): string | number {
  return cell.number ?? cell.text;
}

function styleCell(target: ExcelJS.Cell, cell: ExportCell): void {
  if (cell.number !== undefined) {
    const decimals = cell.decimals ?? 0;
    target.numFmt = decimals > 0 ? `#,##0.${'0'.repeat(decimals)}` : '#,##0';
    target.alignment = { horizontal: 'right' };
    return;
  }
  if (cell.state && cell.state !== 'ready') {
    // A state, not a value: said in words and set apart, never a blank.
    target.font = { italic: true, color: { argb: argb(EXPORT_PALETTE.textMuted) } };
  }
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: argb(EXPORT_PALETTE.surfaceSunken) },
    };
    cell.border = {
      bottom: { style: 'thin', color: { argb: argb(EXPORT_PALETTE.borderDefault) } },
    };
  });
}

function stateText(widget: ExportWidget): string {
  const parts = [widget.stateLabel];
  if (widget.message) parts.push(widget.message);
  return parts.join(' – ');
}

/** Worksheet names: 31 characters, no `[]:*?/\`, unique within the book. */
function sheetName(title: string, taken: Set<string>): string {
  const base =
    title
      .replace(/[[\]:*?/\\]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, 28) || 'Widget';
  let name = base;
  for (let counter = 2; taken.has(name.toLowerCase()); counter += 1) {
    name = `${base.slice(0, 26)} ${counter}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}
