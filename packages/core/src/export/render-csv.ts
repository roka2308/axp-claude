import type { Locale } from '@axp/contracts';
import type { ExportCell, ExportDocument, ExportWidget } from './document';

/**
 * One widget as CSV (Master Spec §15).
 *
 * The file opens with what it describes - dashboard, widget, scope, period,
 * comparison - as label/value lines, then an empty line, then the table. A
 * CSV without its period is a list of numbers nobody can interpret later.
 *
 * Written for the spreadsheet a reader will open it in: German files use `;`
 * and a decimal comma, English files `,` and a decimal point, both with a BOM
 * so the umlauts survive. Text that a spreadsheet would run as a formula is
 * neutralised (CSV injection), numbers are written without thousands
 * separators, and a value without a number is its state in words.
 */
export function renderCsv(document: ExportDocument, widget: ExportWidget): Buffer {
  const delimiter = document.locale === 'en' ? ',' : ';';
  const lines: string[][] = [];

  // Every text that came from a person - names, titles, labels - is
  // neutralised; only the numbers below are written as they are.
  for (const row of document.meta) lines.push([row.label, neutralise(row.value)]);
  lines.push([document.labels.columns.widget, neutralise(widget.title)]);
  if (widget.state !== 'ready' && widget.state !== 'zero') {
    lines.push([document.labels.columns.state, widget.stateLabel]);
  }
  if (widget.message) lines.push([document.labels.columns.state, neutralise(widget.message)]);
  for (const note of widget.dataQuality) lines.push([document.labels.dataQuality, note]);
  lines.push([]);

  if (widget.table) {
    lines.push(widget.table.columns.map((column) => neutralise(column.label)));
    for (const row of widget.table.rows) {
      lines.push(row.map((cell) => cellText(cell, document.locale)));
    }
  } else if (widget.text) {
    lines.push([neutralise(widget.text)]);
  }

  const body = lines.map((line) => line.map((value) => quote(value, delimiter)).join(delimiter));
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(body.join('\r\n') + '\r\n', 'utf8'),
  ]);
}

function cellText(cell: ExportCell, locale: Locale): string {
  if (cell.number === undefined) return neutralise(cell.text);
  const fixed =
    cell.decimals === undefined ? String(cell.number) : cell.number.toFixed(cell.decimals);
  return locale === 'en' ? fixed : fixed.replace('.', ',');
}

/**
 * A text cell a spreadsheet would treat as a formula gets a leading
 * apostrophe. Numbers never pass through here, so a negative number stays one.
 */
export function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}
