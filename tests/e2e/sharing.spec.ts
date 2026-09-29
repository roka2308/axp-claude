import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { EDITOR_STATE, FIXTURE_SKIP_REASON, VIEWER_EMAIL, VIEWER_STATE } from './session';

/**
 * Phase 7: exports of the current view and external shares (D8, Gate F7).
 *
 * What only a browser shows: that the export a person downloads is the view
 * they were looking at, that a link opened without any session shows the
 * published dashboard with only the rights it was given, that a password
 * stands in front of a protected link, and that a revoked link turns into
 * the neutral "not available" page.
 */

const RUN = Date.now().toString(36);

// Creating a link, opening it in a second browser and rendering an export
// file together take longer than a single page visit.
test.describe.configure({ timeout: 120_000 });
const DASHBOARD = 'Executive Health Overview';

async function openDashboard(page: Page) {
  await page.goto('/dashboards');
  await page.getByRole('link', { name: DASHBOARD }).first().click();
  await expect(page.getByRole('heading', { name: DASHBOARD, level: 1 })).toBeVisible();
}

/**
 * Waits for the finished export and takes it through its visible link. The
 * page also starts the download by itself, but a browser may refuse that
 * after an asynchronous step (WebKit does); the link is what always works.
 */
async function downloadFrom(scope: Page | Locator) {
  const page = 'page' in scope ? scope.page() : scope;
  await expect(scope.getByText('Export bereit')).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent('download');
  await scope.getByRole('link', { name: /herunterladen$/ }).click();
  return download;
}

/** A browser with no session at all - a share recipient. */
async function asRecipient(browser: Browser, baseURL: string | undefined, url: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  // The created link carries the configured public origin; the test server
  // may run elsewhere, so only the path is used.
  await page.goto(new URL(url).pathname);
  return { page, close: () => context.close() };
}

test.describe('exports of the current view', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('downloads a workbook of exactly the view on screen', async ({ page }) => {
    await openDashboard(page);
    await page.getByLabel('Zeitraum', { exact: true }).selectOption('last_14_days');
    await page.waitForURL(/timeRange=last_14_days/);
    await page.getByLabel('Vergleich', { exact: true }).selectOption('prior_year');
    await page.waitForURL(/comparison=prior_year/);

    await expect(
      page.getByText('Exportiert wird die aktuelle Ansicht: Letzte 14 Tage · Vorjahreszeitraum.'),
    ).toBeVisible();
    await page.getByLabel('Format', { exact: true }).selectOption('xlsx');

    await page.getByRole('button', { name: 'Export erstellen' }).click();
    const file = await downloadFrom(page);
    expect(file.suggestedFilename()).toMatch(/^executive-health-overview_.+\.xlsx$/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await readFile((await file.path())!)) as unknown as ArrayBuffer);
    const overview = workbook.getWorksheet('Übersicht')!;
    const rows = new Map<string, string>();
    overview.eachRow((row) => rows.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(rows.get('Zeitraum')).toMatch(/^Letzte 14 Tage \(/);
    expect(rows.get('Vergleich')).toMatch(/^Vorjahreszeitraum \(/);
    expect(rows.get('Site')).toBeTruthy();
  });

  test('exports one widget as CSV from its detail view', async ({ page }) => {
    await openDashboard(page);
    await page.getByRole('link', { name: /PULSE/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Als CSV exportieren' }).click();
    const file = await downloadFrom(dialog);
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const text = await readFile((await file.path())!, 'utf8');
    expect(text).toContain('Zeitraum;Letzte 7 Tage');
    expect(text).toContain('40,32');
  });

  test('offers no share link to a viewer', async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByRole('link', { name: 'Teilen', exact: true })).toHaveCount(0);
  });
});

test.describe('external shares', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: EDITOR_STATE });

  async function createLink(
    page: Page,
    options: { label: string; rights?: string[]; password?: string },
  ): Promise<string> {
    await openDashboard(page);
    await page.getByRole('link', { name: 'Teilen', exact: true }).click();
    await expect(page.getByRole('heading', { name: `„${DASHBOARD}“ teilen` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Innerhalb der Organisation' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Bezeichnung' }).fill(options.label);
    for (const right of options.rights ?? []) await page.getByLabel(right).check();
    if (options.password) {
      await page.getByLabel('Link zusätzlich mit einem Passwort schützen').check();
      await page.getByLabel('Passwort für den Link').fill(options.password);
    }
    await page.getByRole('button', { name: 'Link erstellen' }).click();

    const link = page.getByRole('textbox', { name: 'Link zum geteilten Dashboard' });
    await expect(link).toBeFocused();
    return link.inputValue();
  }

  test('a link shows the published dashboard, with only the rights it grants', async ({
    page,
    browser,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    const url = await createLink(page, { label: `Vorstand ${RUN}` });
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{40,}$/);

    const recipient = await asRecipient(browser, baseURL, url);
    try {
      const shared = recipient.page;
      await expect(shared.getByRole('heading', { name: DASHBOARD, level: 1 })).toBeVisible();
      await expect(shared.getByText('Geteilte Ansicht')).toBeVisible();
      await expect(shared.getByText(/^Dieser Link ist gültig bis /)).toBeVisible();
      // View only: no controls, no export, no detail links, no way into the product.
      await expect(shared.getByLabel('Zeitraum', { exact: true })).toHaveCount(0);
      await expect(shared.getByRole('button', { name: 'Export erstellen' })).toHaveCount(0);
      await expect(shared.getByRole('link', { name: /Details/ })).toHaveCount(0);
      await expect(shared.getByRole('link', { name: 'Dashboards' })).toHaveCount(0);
      const pulse = shared.getByRole('region', { name: 'PULSE', exact: true });
      await expect(pulse.getByText('40,32')).toBeVisible();
    } finally {
      await recipient.close();
    }

    // Revoked: the same link now answers with the neutral page.
    const item = page.getByRole('listitem', { name: `Vorstand ${RUN}` });
    await expect(item.getByText('Aktiv')).toBeVisible();
    await item.getByRole('button', { name: 'Widerrufen' }).click();
    await item.getByRole('button', { name: 'Endgültig widerrufen' }).click();
    await expect(item.getByText('Widerrufen', { exact: true })).toBeVisible();

    const after = await asRecipient(browser, baseURL, url);
    try {
      await expect(
        after.page.getByRole('heading', { name: 'Dieser Link ist nicht verfügbar' }),
      ).toBeVisible();
      await expect(after.page.getByText(DASHBOARD)).toHaveCount(0);
    } finally {
      await after.close();
    }
  });

  test('a protected link asks for its password first', async ({
    page,
    browser,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    const password = `Lageplan-${RUN}-Sommer`;
    const url = await createLink(page, {
      label: `Partner ${RUN}`,
      rights: ['Zeitraum ändern', 'Exportieren (PDF, XLSX, PPTX, CSV)'],
      password,
    });

    const recipient = await asRecipient(browser, baseURL, url);
    try {
      const shared = recipient.page;
      await expect(shared.getByRole('heading', { name: 'Passwort erforderlich' })).toBeVisible();
      await expect(shared.getByText(DASHBOARD)).toHaveCount(0);

      await shared.getByLabel(/^Passwort/).fill('falsch-falsch');
      await shared.getByRole('button', { name: 'Dashboard öffnen' }).click();
      await expect(shared.getByText('Das Passwort stimmt nicht.').first()).toBeVisible();

      await shared.getByLabel(/^Passwort/).fill(password);
      await shared.getByRole('button', { name: 'Dashboard öffnen' }).click();
      await expect(shared.getByRole('heading', { name: DASHBOARD, level: 1 })).toBeVisible();

      // The rights it was given: the time range, and exports - not the comparison.
      await expect(shared.getByLabel('Zeitraum', { exact: true })).toBeVisible();
      await expect(shared.getByLabel('Vergleich', { exact: true })).toHaveCount(0);
      await shared.getByRole('button', { name: 'Export erstellen' }).click();
      expect((await downloadFrom(shared)).suggestedFilename()).toMatch(/\.pdf$/);
    } finally {
      await recipient.close();
    }
  });

  test('an unknown link shows the neutral page', async ({ browser, baseURL }) => {
    const recipient = await asRecipient(
      browser,
      baseURL,
      'http://example.invalid/s/kein-gueltiger-link-0000000000000000000000000',
    );
    try {
      await expect(
        recipient.page.getByRole('heading', { name: 'Dieser Link ist nicht verfügbar' }),
      ).toBeVisible();
    } finally {
      await recipient.close();
    }
  });

  test('the share page reflows on a phone', async ({ page }) => {
    await openDashboard(page);
    await page.getByRole('link', { name: 'Teilen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Externer Link' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
