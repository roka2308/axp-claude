import { describe, expect, it } from 'vitest';
import { buildExportDocument, slug } from './document';
import { renderCsv } from './render-csv';
import { renderXlsx } from './render-xlsx';
import { renderPdf } from './render-pdf';
import { renderPptx } from './render-pptx';
import { chartGeometry, niceScale } from './chart';
import { samplePresentation } from './fixtures.test-helper';
import { csvRows, pdfInfo, pdfText, pptxSlides, xlsxSheets } from './readers.test-helper';

const GENERATED = new Date('2026-09-29T10:00:00.000Z');

function documentFor(locale: 'de' | 'en' = 'de', audience: 'internal' | 'share' = 'internal') {
  return buildExportDocument(samplePresentation(), {
    locale,
    generatedAt: GENERATED,
    audience,
    ...(audience === 'share' ? { shareExpiresAt: new Date('2026-10-15T21:59:59.000Z') } : {}),
  });
}

describe('export document', () => {
  it('states what it describes: scope, period, comparison, version, time of creation', () => {
    const meta = Object.fromEntries(documentFor().meta.map((row) => [row.key, row.value]));
    expect(meta).toMatchObject({
      dashboard: 'Executive Health Overview',
      tenant: 'Demo Kunde',
      project: 'Employee Portal',
      site: 'Employee Portal Demo Site',
      timezone: 'Europe/Berlin',
      period: 'Letzte 7 Tage (22.09.2026 – 28.09.2026)',
      comparison: 'Vorperiode (15.09.2026 – 21.09.2026)',
      filters: 'Bereich: Intranet',
      version: 'Veröffentlichte Version 3',
      generatedAt: '29.09.2026, 12:00 (Europe/Berlin)',
    });
  });

  it('tells a share recipient how long the view is valid, and leaves the project out', () => {
    const meta = Object.fromEntries(
      documentFor('de', 'share').meta.map((row) => [row.key, row.value]),
    );
    expect(meta.share).toBe('Geteilte Ansicht, gültig bis 15.10.2026, 23:59 (Europe/Berlin)');
    expect(meta.project).toBeUndefined();
  });

  it('orders widgets as the dashboard shows them', () => {
    expect(documentFor().widgets.map((widget) => widget.id)).toEqual([
      'w-pulse',
      'w-missing',
      'w-trend',
      'w-pages',
      'w-text',
    ]);
  });

  it('never turns a missing value into a number', () => {
    const missing = documentFor().widgets.find((widget) => widget.id === 'w-missing')!;
    expect(missing.metrics![0]!.value).toEqual({ text: 'Wert fehlt', state: 'missing' });
    expect(missing.message).toBe('Für „Creators“ ist keine Quelle zugeordnet.');

    const trend = documentFor().widgets.find((widget) => widget.id === 'w-trend')!;
    expect(trend.chart!.series[0]!.values).toEqual([700, 720, null, 690, 0]);
    expect(trend.table!.rows[2]![1]).toEqual({
      text: 'Daten aktuell nicht verfügbar',
      state: 'unavailable',
    });
    // A measured zero stays a zero: it is a value, not an absence.
    expect(trend.table!.rows[4]![1]!.number).toBe(0);
  });

  it('writes English files in English', () => {
    const meta = Object.fromEntries(documentFor('en').meta.map((row) => [row.key, row.value]));
    expect(meta.period).toBe('Last 7 days (2026-09-22 – 2026-09-28)');
    expect(meta.comparison).toBe('Previous period (2026-09-15 – 2026-09-21)');
  });

  it('names files safely', () => {
    expect(documentFor().fileBase).toBe('executive-health-overview_2026-09-22_2026-09-28');
    expect(slug('Übersicht: Größe / Ärger?')).toBe('uebersicht-groesse-aerger');
    expect(slug('///')).toBe('dashboard');
  });
});

describe('CSV', () => {
  it('opens with the scope and period, then the table', () => {
    const document = documentFor();
    const trend = document.widgets.find((widget) => widget.id === 'w-trend')!;
    const buffer = renderCsv(document, trend);
    expect([...buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const rows = csvRows(buffer, ';');
    expect(rows).toContainEqual(['Zeitraum', 'Letzte 7 Tage (22.09.2026 – 28.09.2026)']);
    expect(rows).toContainEqual(['Vergleich', 'Vorperiode (15.09.2026 – 21.09.2026)']);
    expect(rows).toContainEqual(['Datum', 'Aktive Nutzer:innen', 'Vergleichszeitraum']);
    expect(rows).toContainEqual(['24.09.2026', 'Daten aktuell nicht verfügbar', '640']);
  });

  it('neutralises text a spreadsheet would run as a formula', () => {
    const document = documentFor();
    const pages = document.widgets.find((widget) => widget.id === 'w-pages')!;
    const rows = csvRows(renderCsv(document, pages), ';');
    expect(rows).toContainEqual(['\'=HYPERLINK("http://evil.example")', '1234']);
    expect(rows).toContainEqual(['News', 'Nicht erfasst']);
  });

  it('uses comma and decimal point for English', () => {
    const document = documentFor('en');
    const pulse = document.widgets.find((widget) => widget.id === 'w-pulse')!;
    const rows = csvRows(renderCsv(document, pulse), ',');
    expect(rows).toContainEqual(['PULSE Score', '40.32', 'Points', 'solide', '38.10', '5.8']);
  });
});

describe('XLSX', () => {
  it('describes itself on the first sheet and keeps numbers as numbers', async () => {
    const sheets = await xlsxSheets(await renderXlsx(documentFor()));
    // `:` is not allowed in a sheet name, so it becomes a space.
    expect([...sheets.keys()]).toEqual([
      'Übersicht',
      'Kennzahlen',
      'Aktive Nutzer innen',
      'Beliebte Seiten',
    ]);

    const overview = sheets.get('Übersicht')!;
    expect(overview).toContainEqual(['Zeitraum', 'Letzte 7 Tage (22.09.2026 – 28.09.2026)']);
    expect(overview).toContainEqual(['Vergleich', 'Vorperiode (15.09.2026 – 21.09.2026)']);

    const metrics = sheets.get('Kennzahlen')!;
    expect(metrics).toContainEqual(['PULSE', 'PULSE Score', 40.32, 'Punkte', 'solide', 38.1, 5.8]);
    // Missing is a word, never 0 and never blank.
    expect(metrics.find((row) => row[0] === 'Creation Rate')![2]).toBe('Wert fehlt');

    const trend = sheets.get('Aktive Nutzer innen')!;
    expect(trend).toContainEqual(['24.09.2026', 'Daten aktuell nicht verfügbar', 640]);
  });

  it('stores formula-looking text as text', async () => {
    const sheets = await xlsxSheets(await renderXlsx(documentFor()));
    const pages = sheets.get('Beliebte Seiten')!;
    expect(pages).toContainEqual(['=HYPERLINK("http://evil.example")', 1234]);
  });
});

describe('PDF', () => {
  it('is tagged, titled and in the right language', async () => {
    const info = await pdfInfo(await renderPdf(documentFor()));
    expect(info).toMatchObject({ title: 'Executive Health Overview', lang: 'de-DE', tagged: true });
  }, 30_000);

  it('reads like the dashboard: metadata, values, states and chart data', async () => {
    const text = (await pdfText(await renderPdf(documentFor()))).join('\n');
    for (const expected of [
      'Letzte 7 Tage (22.09.2026 – 28.09.2026)',
      'Vorperiode (15.09.2026 – 21.09.2026)',
      'Veröffentlichte Version 3',
      '40,32',
      'Bewertung: solide',
      'Wert fehlt',
      'Daten aktuell nicht verfügbar',
      'Werte zu „Aktive Nutzer:innen“',
      'Seite 1 von',
    ]) {
      expect(text).toContain(expected);
    }
  }, 30_000);
});

describe('PPTX (hybrid)', () => {
  it('keeps simple content native and makes charts images with values in the notes', async () => {
    const slides = await pptxSlides(await renderPptx(documentFor()));
    const [title, metrics, chart, table, text] = slides;

    expect(title!.texts).toContain('Executive Health Overview');
    expect(title!.tables).toBe(1);
    expect(title!.texts).toContain('Letzte 7 Tage (22.09.2026 – 28.09.2026)');

    // Key figures: editable text, with the evaluation in words.
    expect(metrics!.images).toBe(0);
    expect(metrics!.texts).toEqual(
      expect.arrayContaining(['40,32', 'Bewertung: solide', 'Wert fehlt']),
    );

    // The chart: an image with a text alternative, its values in the notes.
    expect(chart!.images).toBe(1);
    expect(chart!.altTexts[0]).toContain('Aktive Nutzer:innen');
    expect(chart!.notes).toContain('24.09.2026\tDaten aktuell nicht verfügbar\t640');

    // Tables: a native table.
    expect(table!.tables).toBe(1);
    expect(table!.texts).toContain('Nicht erfasst');

    expect(text!.texts.join(' ')).toContain('täglich aktualisiert');
  }, 30_000);
});

describe('chart geometry', () => {
  it('breaks the line at a value without a number instead of dropping to zero', () => {
    const geometry = chartGeometry(
      {
        dates: ['a', 'b', 'c', 'd'],
        series: [{ label: 'x', role: 'primary', values: [1, 2, null, 4] }],
        decimals: 0,
        unit: 'count',
      },
      { x: 0, y: 0, width: 400, height: 200 },
      'de',
    );
    expect(geometry.series[0]!.segments.map((segment) => segment.length)).toEqual([2, 1]);
  });

  it('puts the axis on round numbers and includes zero', () => {
    expect(niceScale([12, 87])).toEqual({ min: 0, max: 100, step: 25 });
    expect(niceScale([])).toEqual({ min: 0, max: 1, step: 0.25 });
  });
});
