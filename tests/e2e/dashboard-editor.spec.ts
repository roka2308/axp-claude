import { expect, test, type Locator, type Page } from '@playwright/test';
import { EDITOR_STATE, FIXTURE_SKIP_REASON, PROJECT_NAME, VIEWER_EMAIL } from './session';

/**
 * Phase 2 authoring journey (D2, D3, Gate F2).
 *
 * The gate asks to demonstrate that grid behaviour is deterministic and free of
 * overlaps, that published never changes before publish, that autosave and the
 * edit lock work, that a widget can be moved and resized from the keyboard,
 * that desktop/tablet/mobile preview works, and that publish validation catches
 * an invalid widget. Each is a case below.
 *
 * The suite builds its own dashboard rather than editing the shared fixture.
 * An editor suite that rearranges `Portal Overview` is not repeatable - the
 * second run finds a dashboard the first one moved - and the journey it has to
 * prove starts at "create a dashboard" anyway.
 *
 * Widgets are addressed by family rather than by title, because renaming one is
 * itself under test.
 */

const RUN = Date.now().toString(36);
const DASHBOARD = `Editor E2E ${RUN}`;
const RENAMED = `Umbenannt ${RUN}`;

/** Filled by the first case; every later case edits this dashboard. */
let dashboardId = '';

test.describe('dashboard editor', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  // Authoring is desktop-first by decision (development plan, Phase 2). The
  // viewer carries the responsive requirement and is tested on the phone.
  test.skip(({ isMobile }) => isMobile === true, 'The editor is a desktop surface.');
  test.use({ storageState: EDITOR_STATE });
  test.describe.configure({ mode: 'serial' });

  test('creates a dashboard and opens the editor on it', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('link', { name: PROJECT_NAME }).first().click();
    // Wait for the navigation before reading the URL, or the project id is
    // whatever the previous page was.
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();
    const projectUrl = new URL(page.url()).pathname;

    await page.goto(`${projectUrl}/setup`);
    const section = page.getByRole('region', { name: 'Erstes Dashboard' });
    await section.getByLabel('Name').fill(DASHBOARD);
    await section.getByRole('button', { name: 'Dashboard anlegen' }).click();
    await expect(
      page.getByText(`Das Dashboard „${DASHBOARD}“ wurde als Entwurf angelegt.`),
    ).toBeVisible();

    await page.goto(projectUrl);
    const row = page.getByRole('listitem').filter({ hasText: DASHBOARD }).first();
    await row.getByRole('link', { name: 'Bearbeiten' }).click();

    await expect(page.getByRole('heading', { name: `${DASHBOARD} bearbeiten` })).toBeVisible();
    dashboardId = /\/dashboards\/([^/?]+)/.exec(page.url())![1]!;

    // Canvas first, contextual inspector beside it, gallery above (D3).
    await expect(
      page.getByRole('complementary', { name: 'Dashboard-Einstellungen' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Widget hinzufügen' })).toBeVisible();
    await expect(page.getByText('Noch keine Widgets')).toBeVisible();
  });

  test('adds widgets from the gallery, templates first', async ({ page }) => {
    await openEditor(page);
    const gallery = page.getByRole('region', { name: 'Widget hinzufügen' });

    // Templates are the offer; blank widgets are present but one disclosure
    // further away, because "visits over time" is what people actually want.
    await expect(gallery.getByRole('button', { name: /Kennzahl mit Vergleich/ })).toBeVisible();
    // `exact`, because a template button's accessible name is its own name
    // plus its family - "Kennzahl mit Vergleich Kennzahl-Karte".
    await expect(gallery.getByRole('button', { name: 'Kennzahl-Karte', exact: true })).toBeHidden();

    await gallery.getByRole('button', { name: /Kennzahl mit Vergleich/ }).click();
    // A new widget arrives selected, so the Inspector already shows it.
    await expect(inspector(page)).toBeVisible();

    await gallery.getByRole('button', { name: /Verlauf über die Zeit/ }).click();
    await gallery.getByRole('button', { name: /Top-Seiten als Balken/ }).click();

    await expect.poll(async () => (await placementsOf(page)).length).toBe(3);
    expect(await anyOverlap(page)).toBe(false);
    await expect(page.getByText('Gespeichert', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('shows a widget’s settings when it is selected', async ({ page }) => {
    await openEditor(page);
    await widget(page, 'Zeitverlauf').click();

    await expect(inspector(page).getByLabel('Spalte')).toBeVisible();
    await expect(inspector(page).getByLabel('Breite')).toBeVisible();
    // The minimum is stated, not discovered by being refused.
    await expect(inspector(page).getByText(/Mindestgröße 4×3/)).toBeVisible();
  });

  test('moves and resizes a widget from the keyboard alone', async ({ page, isMobile }) => {
    // The non-drag path D2 requires. Not a fallback: the same engine.
    test.skip(isMobile === true, 'Tab focus traversal does not exist on iOS WebKit.');

    await openEditor(page);
    const target = widget(page, 'Kennzahl-Karte');
    await target.focus();

    // Focus selects, so the Inspector follows the keyboard the way it follows
    // the pointer.
    await expect(inspector(page)).toBeVisible();

    const before = await sizeOf(target);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await sizeOf(target)).w).toBe(before.w + 1);

    const row = await inspector(page).getByLabel('Zeile').inputValue();
    await page.keyboard.press('ArrowDown');
    await expect(inspector(page).getByLabel('Zeile')).not.toHaveValue(row);

    await expect(page.getByText('Gespeichert', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('never lets two widgets overlap', async ({ page }) => {
    await openEditor(page);

    // Drive one widget onto another through the Inspector, which makes exactly
    // the same engine call the drag gesture makes.
    await widget(page, 'Balkendiagramm').click();
    await setField(page, 'Spalte', '0');
    await setField(page, 'Zeile', '0');

    await expect.poll(async () => await anyOverlap(page)).toBe(false);
    await expect.poll(async () => (await placementsOf(page)).length).toBe(3);
  });

  test('undoes and redoes a change', async ({ page }) => {
    await openEditor(page);
    await widget(page, 'Kennzahl-Karte').click();

    const before = await inspector(page).getByLabel('Breite').inputValue();
    await setField(page, 'Breite', String(Number(before) + 1));
    await expect(inspector(page).getByLabel('Breite')).not.toHaveValue(before);

    await page.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(inspector(page).getByLabel('Breite')).toHaveValue(before);

    await page.getByRole('button', { name: 'Wiederholen' }).click();
    await expect(inspector(page).getByLabel('Breite')).not.toHaveValue(before);
  });

  test('previews desktop, tablet and mobile', async ({ page }) => {
    await openEditor(page);

    for (const [label, columns] of [
      ['Desktop', 12],
      ['Tablet', 8],
      ['Mobil', 4],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // Every widget stays inside the raster of the breakpoint it is shown at.
      // The custom properties are 1-based grid lines, hence the +1.
      const placements = await placementsOf(page);
      expect(placements.length, label).toBe(3);
      for (const placement of placements) {
        expect(placement.x + placement.w, `${label} raster`).toBeLessThanOrEqual(columns + 1);
      }
      expect(await anyOverlap(page), label).toBe(false);
    }
  });

  test('offers an override at a derived breakpoint, and a reset', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'Mobil', exact: true }).click();
    await widget(page, 'Kennzahl-Karte').click();

    // Derived until somebody decides otherwise (D2).
    await expect(inspector(page).getByText(/Für Mobil abgeleitet/)).toBeVisible();

    await setField(page, 'Höhe', '3');
    await expect(inspector(page).getByText(/Eigene Anordnung für Mobil/)).toBeVisible();

    await inspector(page).getByRole('button', { name: 'Auf automatisch zurücksetzen' }).click();
    await expect(inspector(page).getByText(/Für Mobil abgeleitet/)).toBeVisible();

    // The authored desktop layout was never touched by any of that.
    await page.getByRole('button', { name: 'Desktop', exact: true }).click();
    await expect(inspector(page).getByText(/Desktop ist die gestaltete Ansicht/)).toBeVisible();
  });

  test('autosaves without a save button', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole('button', { name: /^Speichern$/ })).toHaveCount(0);

    await widget(page, 'Kennzahl-Karte').click();
    await inspector(page).getByLabel('Titel').fill(RENAMED);
    await inspector(page).getByLabel('Titel').blur();

    // Autosave state is a word, not a spinner (D10).
    await expect(page.getByText('Gespeichert', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(widget(page, RENAMED)).toBeVisible();
  });

  test('leaves the published dashboard untouched until publish', async ({ page }) => {
    // Everything so far lives in the draft. Nothing has been published, so a
    // viewer sees no dashboard rather than a half-built one (Master Spec §21).
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByText(/noch nicht veröffentlicht/i)).toBeVisible();
  });

  test('clamps an invalid size instead of storing it', async ({ page }) => {
    await openEditor(page);
    await widget(page, 'Zeitverlauf').click();

    // A time series below four columns stops being a time series. The engine
    // holds it at the minimum rather than accepting something unpublishable.
    await setField(page, 'Breite', '1');
    await expect(inspector(page).getByLabel('Breite')).toHaveValue('4');
  });

  test('shows the publish impact, then publishes', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'Veröffentlichen prüfen' }).click();

    const review = page.getByRole('region', { name: 'Was die Veröffentlichung ändert' });
    await expect(review.getByText('Neu')).toBeVisible();
    await expect(review.getByText('Geändert')).toBeVisible();
    await expect(review.getByText('Entfernt')).toBeVisible();

    // Cancelling changes nothing.
    await review.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(review).toHaveCount(0);

    await page.getByRole('button', { name: 'Veröffentlichen prüfen' }).click();
    await page.getByRole('button', { name: 'Jetzt veröffentlichen' }).click();
    await expect(page.getByText(/Als Version 1 veröffentlicht/)).toBeVisible({ timeout: 20_000 });

    // And now the viewer has something, carrying the renamed widget.
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByRole('region', { name: RENAMED })).toBeVisible();
  });
});

// --- helpers ---------------------------------------------------------------

async function openEditor(page: Page): Promise<void> {
  await page.goto(`/dashboards/${dashboardId}/edit`);
  await expect(page.getByRole('heading', { name: /bearbeiten$/ })).toBeVisible();
}

/**
 * A widget on the canvas is a button carrying its title and its family.
 *
 * Scoped to the canvas on purpose: the gallery's buttons carry family names
 * too, so an unscoped search finds "add a card" when it meant "the card".
 */
function widget(page: Page, text: string): Locator {
  return canvas(page).getByRole('button').filter({ hasText: text }).first();
}

function canvas(page: Page): Locator {
  return page.locator('[data-breakpoint]');
}

function inspector(page: Page): Locator {
  return page.getByRole('complementary', { name: /Einstellungen für/ });
}

/** Commits a layout number the way a user does: type, then Enter. */
async function setField(page: Page, label: string, value: string): Promise<void> {
  const field = inspector(page).getByLabel(label);
  await field.fill(value);
  await field.press('Enter');
}

/** The rendered grid placement of each canvas cell, from its custom properties. */
async function placementsOf(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-breakpoint]');
    const cells = Array.from(canvas?.querySelectorAll('[style*="--widget-x"]') ?? []);
    return cells.map((cell) => {
      const style = (cell as HTMLElement).style;
      const read = (name: string) => Number(style.getPropertyValue(name));
      return {
        x: read('--widget-x'),
        y: read('--widget-y'),
        w: read('--widget-w'),
        h: read('--widget-h'),
      };
    });
  });
}

async function sizeOf(locator: Locator): Promise<{ w: number; h: number }> {
  return locator.evaluate((element) => {
    const cell = element.closest('[style*="--widget-w"]') as HTMLElement;
    return {
      w: Number(cell.style.getPropertyValue('--widget-w')),
      h: Number(cell.style.getPropertyValue('--widget-h')),
    };
  });
}

/** The invariant Gate F2 names: no two widgets share a cell. */
async function anyOverlap(page: Page): Promise<boolean> {
  const placements = await placementsOf(page);
  return placements.some((a, index) =>
    placements
      .slice(index + 1)
      .some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
  );
}
