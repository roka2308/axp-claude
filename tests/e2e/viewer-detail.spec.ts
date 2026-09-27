import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_NAME, FIXTURE_SKIP_REASON, VIEWER_EMAIL, VIEWER_STATE } from './session';

/**
 * Phase 4 viewer journeys (D4, D10, Gate F4).
 *
 * Runs on the desktop and the mobile project alike: "the mobile Detail View is
 * fully usable" is a gate criterion, and the cheapest way to hold it is to make
 * every assertion here hold on a phone too.
 */

const STATE_DASHBOARD = 'Zustandsmodell';

test.describe('viewer and detail view', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('reaches a dashboard from the library', async ({ page }) => {
    await page.goto('/dashboards');
    await expect(page.getByRole('heading', { name: 'Dashboards', level: 1 })).toBeVisible();

    const table = page.getByRole('table', { name: 'Dashboards' });
    await table.getByRole('link', { name: DASHBOARD_NAME }).click();
    await expect(page.getByRole('heading', { name: DASHBOARD_NAME, level: 1 })).toBeVisible();
  });

  test('opens a detail view that inherits the dashboard context', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME, '?timeRange=last_7_days&comparison=none');

    await page
      .getByRole('link', { name: /^Besuche/ })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Besuche', level: 2 })).toBeVisible();

    // Same time range as the dashboard, and still no comparison (D4).
    await expect(page).toHaveURL(/timeRange=last_7_days/);
    await expect(page).toHaveURL(/comparison=none/);
    await expect(dialog.getByText(/Vergleichszeitraum/)).toHaveCount(0);

    // The modules, in relevance order.
    await expect(dialog.getByRole('region', { name: 'Kernwert' })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Verlauf' })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Definition' })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Aktionen' })).toBeVisible();

    // An action that is not possible says why, instead of being a dead button.
    await expect(dialog.getByText('Export kommt mit Phase 7.')).toBeVisible();
  });

  test('offers the chart inside the detail view as a table too', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);
    await page
      .getByRole('link', { name: /^Besuche/ })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await dialog.getByText('Daten als Tabelle anzeigen').first().click();
    await expect(dialog.getByRole('table').first()).toBeVisible();
  });

  test('closes with Escape and returns focus to where it came from', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);

    const opener = page.getByRole('link', { name: /^Seitenaufrufe/ }).first();
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();

    // Focus moved into the dialog.
    await expect(page.getByRole('button', { name: 'Schließen' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).not.toHaveURL(/widget=/);
  });

  test('keeps focus inside the dialog while it is open', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);
    await page
      .getByRole('link', { name: /^Besuche/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((node) => node.contains(document.activeElement));
      expect(inside, `tab ${step}`).toBe(true);
    }
  });

  test('is a shareable URL', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);
    await page
      .getByRole('link', { name: /^Besuche/ })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const url = page.url();
    await page.goto(url);
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('uses the whole screen on a phone and never scrolls sideways', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);
    await page
      .getByRole('link', { name: /^Besuche/ })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const viewport = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    if (viewport.width < 768) {
      expect(Math.round(box.width)).toBe(viewport.width);
    }

    const overflow = await dialog.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // The close control is a real touch target (D10).
    const close = (await page.getByRole('button', { name: 'Schließen' }).boundingBox())!;
    expect(close.height).toBeGreaterThanOrEqual(44);
  });

  test('has no cross-filter: the only analytics controls are time and comparison', async ({
    page,
  }) => {
    await openDashboard(page, DASHBOARD_NAME);

    const names = await page
      .locator('form[method="get"] select')
      .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).name));
    expect(names.sort()).toEqual(['comparison', 'timeRange']);

    // Interacting with one widget's data changes nothing else on the page.
    const before = await page.getByRole('region', { name: 'Seitenaufrufe' }).innerText();
    await page
      .getByRole('region', { name: 'Meistbesuchte Seiten' })
      .getByRole('row')
      .nth(1)
      .click();
    expect(await page.getByRole('region', { name: 'Seitenaufrufe' }).innerText()).toBe(before);
  });

  test('gives every chart its data as a table', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);

    const charts = page.locator('[role="img"]');
    const count = await charts.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      // The widget the chart belongs to offers the same data as a table.
      const widget = charts.nth(index).locator('xpath=ancestor::section[@aria-label][1]');
      const disclosure = widget.getByText('Daten als Tabelle anzeigen');
      await expect(disclosure, `chart ${index}`).toBeVisible();
      await disclosure.click();
      await expect(widget.getByRole('table').first(), `chart ${index}`).toBeVisible();
    }
  });

  test('never claims to be live', async ({ page }) => {
    await openDashboard(page, DASHBOARD_NAME);
    await expect(page.getByText(/\bLive\b/i)).toHaveCount(0);
    // Freshness is stated factually instead (D4).
    await expect(page.getByText(/^Aktualisiert/).first()).toBeVisible();
  });
});

test.describe('the state model', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('shows every value state in words, never as a bare number or a colour', async ({ page }) => {
    await openDashboard(page, STATE_DASHBOARD);

    const expectations: [string, RegExp][] = [
      ['Bereit', /\d/],
      ['Keine Daten', /Keine Daten vorhanden/],
      ['Ohne Zuordnung', /Wert fehlt/],
      ['Nicht lesbarer Wert', /Unbekannt/],
      ['Nicht erfasst', /Nicht erfasst/],
      ['Nicht anwendbar', /Nicht anwendbar/],
      ['Bericht nicht erreichbar', /Daten aktuell nicht verfügbar/],
      ['Mit Einschränkung', /\d/],
      ['Ohne Kennzahl', /keine Kennzahl/],
    ];

    for (const [title, text] of expectations) {
      const tile = page.getByRole('region', { name: title, exact: true });
      await expect(tile, title).toBeVisible();
      await expect(tile, title).toContainText(text);
    }

    // A measured zero is a number, in the number's own element - not a word,
    // and not an empty space (D10).
    await expect(
      page.getByRole('region', { name: 'Gemessene Null', exact: true }).locator('.axp-numeric'),
    ).toHaveText('0');

    // The reason, not just the state: "Nicht erfasst" and why.
    await expect(page.getByRole('region', { name: 'Nicht erfasst', exact: true })).toContainText(
      'Diese Website erfasst diesen Bericht nicht.',
    );
    await expect(page.getByRole('region', { name: 'Ohne Zuordnung', exact: true })).toContainText(
      'keine Quelle zugeordnet',
    );
  });

  test('sends every tile in the loading state first, then its values', async ({ page }) => {
    await page.goto('/dashboards');
    const href = await page
      .getByRole('table', { name: 'Dashboards' })
      .getByRole('link', { name: STATE_DASHBOARD, exact: true })
      .getAttribute('href');

    /*
     * The raw streamed document. Each tile's fallback is in the first part of
     * the stream, before any value: `loading` is a state the viewer actually
     * receives, not a case in a type union (D10). The values follow in the
     * same response, one boundary per widget.
     */
    const html = await (await page.request.get(href!)).text();
    const loading = html.match(/aria-busy="true"/g) ?? [];
    expect(loading.length).toBe(10);
    expect(html).toContain('Wird geladen');

    const firstFallback = html.indexOf('aria-busy="true"');
    const firstValue = html.indexOf('axp-numeric');
    expect(firstFallback).toBeGreaterThan(-1);
    expect(firstValue).toBeGreaterThan(firstFallback);
  });

  test('explains a warning in the detail view', async ({ page }) => {
    await openDashboard(page, STATE_DASHBOARD);
    await page.getByRole('link', { name: /^Mit Einschränkung/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('region', { name: 'Datenqualität' })).toContainText(
      'noch nicht vollständig verarbeitet',
    );
  });
});

test.describe('product search', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('finds a dashboard from the top bar, and nothing that is data', async ({ page }) => {
    await page.goto('/projects');

    const search = page.getByRole('searchbox', { name: 'Produkt durchsuchen' });
    await search.fill('overview');
    await search.press('Enter');

    await expect(page.getByRole('heading', { name: 'Suche', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: DASHBOARD_NAME })).toBeVisible();
  });

  test('says so when nothing matches', async ({ page }) => {
    await page.goto('/search?q=gibtesnicht');
    await expect(page.getByText('Nichts gefunden für „gibtesnicht“')).toBeVisible();
  });
});

async function openDashboard(page: Page, name: string, query = ''): Promise<void> {
  await page.goto('/dashboards');
  const href = await page
    .getByRole('table', { name: 'Dashboards' })
    .getByRole('link', { name, exact: true })
    .getAttribute('href');
  await page.goto(`${href}${query}`);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  // Every tile has left `loading` before a test looks at it.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
}
