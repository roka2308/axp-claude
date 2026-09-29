import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/**
 * Reads export files back, for tests.
 *
 * A test that checks bytes only proves a file was written. These read what a
 * person would read - the text of a PDF page, the cells of a sheet, the words
 * on a slide - so a test can assert on content.
 */

export async function pdfText(buffer: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
  }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join(''),
    );
  }
  await document.destroy();
  return pages;
}

export async function pdfInfo(
  buffer: Buffer,
): Promise<{ title?: string; lang?: string; tagged: boolean }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const metadata = await document.getMetadata();
  const markInfo = await document.getMarkInfo();
  const info = metadata.info as { Title?: string; Language?: string };
  await document.destroy();
  return {
    ...(info.Title ? { title: info.Title } : {}),
    ...(info.Language ? { lang: info.Language } : {}),
    tagged: Boolean(markInfo?.Marked),
  };
}

/** Every sheet as rows of cell values. */
export async function xlsxSheets(buffer: Buffer): Promise<Map<string, unknown[][]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets = new Map<string, unknown[][]>();
  workbook.eachSheet((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as unknown[])
        .slice(1)
        .map((value) =>
          value && typeof value === 'object' && 'text' in value
            ? (value as { text: string }).text
            : value,
        );
      rows.push(values);
    });
    sheets.set(sheet.name, rows);
  });
  return sheets;
}

export interface SlideContent {
  readonly texts: string[];
  readonly tables: number;
  readonly images: number;
  readonly altTexts: string[];
  readonly notes: string;
}

/** Each slide's words, native tables, images with their text alternative, and notes. */
export async function pptxSlides(buffer: Buffer): Promise<SlideContent[]> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));

  const slides: SlideContent[] = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async('string');
    const number = /(\d+)\.xml$/.exec(name)![1];
    const notesXml =
      (await zip.file(`ppt/notesSlides/notesSlide${number}.xml`)?.async('string')) ?? '';
    slides.push({
      texts: [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decodeXml(match[1]!)),
      tables: (xml.match(/<a:tbl>/g) ?? []).length,
      images: (xml.match(/<p:pic>/g) ?? []).length,
      altTexts: [...xml.matchAll(/descr="([^"]*)"/g)].map((match) => decodeXml(match[1]!)),
      notes: [...notesXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
        .map((match) => decodeXml(match[1]!))
        .join('\n'),
    });
  }
  return slides;
}

/** The CSV as rows, with the BOM and the delimiter handled. */
export function csvRows(buffer: Buffer, delimiter: string): string[][] {
  const bom = String.fromCharCode(0xfeff);
  const raw = buffer.toString('utf8');
  const text = raw.startsWith(bom) ? raw.slice(1) : raw;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell.length > 0 || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
