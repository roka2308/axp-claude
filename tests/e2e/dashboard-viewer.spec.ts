import { expect, test, type Page } from '@playwright/test';
import {
  DASHBOARD_NAME,
  DEMO_MATOMO_TOKEN,
  FIXTURE_SKIP_REASON,
  PROJECT_NAME,
  VIEWER_EMAIL,
  VIEWER_STATE,
} from './session';

/**
 * Phase 1 acceptance journey: the first vertical slice, end to end.
 *
 * Runs against the seeded canonical fixture:
 *
 *   npm run db:reset && npm run db:migrate
 *   npm run seed:demo -- --password <password> --json
 *   E2E_VIEWER_EMAIL=viewer.demo@example.invalid E2E_VIEWER_PASSWORD=<password> npm run test:e2e
 *
 * What this file checks is what only a browser can show: that a value state
 * arrives as text, that the two viewer interactions work, that a chart carries
 * its data alternative, and that the grid reflows on a phone (D4, D10,
 * Master Spec §27).
 *
 * The session comes from `auth.setup.ts` rather than from a sign-in per case:
 * login is rate limited on purpose, and exercising that safeguard fifteen times
 * would only prove it works.
 */

test.use({ storageState: VIEWER_STATE });

test.describe('dashboard viewer', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await openDashboard(page);
  });

  test('shows the dashboard with its data scope and all of its widgets', async ({ page }) => {
    await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();

    // Which snapshot this is. A viewer must be able to tell (Master Spec §21).
    await expect(page.getByText(new RegExp(`${PROJECT_NAME} · Version \\d+`))).toBeVisible();

    // Data Scope: what the numbers are about - visible, read-only (D4).
    await expect(page.getByText('Employee Portal Demo Site')).toBeVisible();
    await expect(page.getByText('Europe/Berlin')).toBeVisible();
    await expect(page.getByText(/Zeitraum: \d{4}-\d{2}-\d{2}/)).toBeVisible();

    for (const title of [
      'Besuche',
      'Seitenaufrufe',
      'Besuche im Zeitverlauf',
      'Meistbesuchte Seiten',
    ]) {
      await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
    }
  });

  test('renders a KPI as a number with a comparison, never as a colour alone', async ({ page }) => {
    const card = kpiCard(page);

    await expect(card).toContainText(/\d/);
    // Direction carried by a signed percentage and a label, not by hue (D10).
    await expect(card).toContainText(/[+-]?\d+,\d\s?%/);
    await expect(card).toContainText('Vorperiode');
  });

  test('offers the chart as a data table', async ({ page }) => {
    // D10: a chart is never the only representation of its values.
    const chart = page.getByRole('region', { name: 'Besuche im Zeitverlauf', exact: true });
    await chart.getByText('Daten als Tabelle anzeigen').click();

    await expect(chart.getByRole('table')).toBeVisible();
    await expect(chart.getByRole('columnheader', { name: 'Datum' })).toBeVisible();
  });

  test('explains the definition behind a number', async ({ page }) => {
    // Definitions are core product, not a tooltip afterthought (D4).
    const card = kpiCard(page);
    await card.getByText('Definition', { exact: true }).click();
    await expect(card.getByText(/Definitionsversion \d+/)).toBeVisible();
  });

  test('changes the time range, and the numbers follow', async ({ page }) => {
    const scope = page.getByText(/Zeitraum: \d{4}-\d{2}-\d{2}/);
    const rangeBefore = await scope.innerText();
    const valueBefore = await kpiValue(page);

    await timeRange(page).selectOption('last_7_days');
    await apply(page).click();

    await expect(page).toHaveURL(/timeRange=last_7_days/);
    await expect(scope).not.toHaveText(rangeBefore);
    // Seven days is a different question and must get a different answer.
    expect(await kpiValue(page)).not.toBe(valueBefore);
  });

  test('turns the comparison off and on again', async ({ page }) => {
    await expect(kpiCard(page)).toContainText('Vorperiode');

    await comparison(page).selectOption('none');
    await apply(page).click();
    await expect(page).toHaveURL(/comparison=none/);

    // No comparison means no comparison - not a zero and not a dash.
    await expect(kpiCard(page)).not.toContainText('Vorperiode');
    await expect(page.getByText(/Vergleichszeitraum/)).toHaveCount(0);

    await comparison(page).selectOption('prior_year');
    await apply(page).click();
    await expect(page.getByText(/Vergleichszeitraum: \d{4}-\d{2}-\d{2}/)).toBeVisible();
  });

  test('keeps the selection in the URL, so a view can be shared', async ({ page }) => {
    const id = dashboardIdOf(page);
    await page.goto(`/dashboards/${id}?timeRange=previous_month&comparison=prior_year`);

    await expect(timeRange(page)).toHaveValue('previous_month');
    await expect(comparison(page)).toHaveValue('prior_year');
    await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();
  });

  test('never ships a Matomo credential to the browser', async ({ page }) => {
    // The demo connection's token is a known literal, so its absence is
    // checkable rather than merely asserted (Master Spec §19, §27).
    const bodies: string[] = [];
    page.on('response', async (response) => {
      try {
        bodies.push(await response.text());
      } catch {
        // A body that cannot be read carries no credential either.
      }
    });

    await page.reload();
    await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();

    const everything = [await page.content(), ...bodies].join(' ');
    expect(everything).not.toContain(DEMO_MATOMO_TOKEN);
    // `token_auth=` is the leak shape - a Matomo request carrying the
    // credential. The bare word is a legitimate UI label on the setup form,
    // and next-intl ships every message to the client.
    expect(everything).not.toMatch(/token_auth=/i);
  });

  test('states every widget status as text', async ({ page }) => {
    // Whatever the state, it is readable - colour is never the only channel.
    for (const title of ['Besuche', 'Besuche im Zeitverlauf', 'Meistbesuchte Seiten']) {
      const region = page.getByRole('region', { name: title, exact: true });
      await expect(region).toBeVisible();
      expect((await region.innerText()).trim().length).toBeGreaterThan(title.length);
    }
  });
});

test.describe('dashboard viewer accessibility', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await openDashboard(page);
  });

  test('is operable from the keyboard alone', async ({ page, isMobile }) => {
    // Tab traversal is a desktop input model; iOS WebKit does not move focus
    // with Tab at all. The mobile project covers reflow and touch instead.
    test.skip(isMobile === true, 'Tab focus traversal does not exist on iOS WebKit.');

    await timeRange(page).focus();
    await page.keyboard.press('Tab');
    await expect(comparison(page)).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(apply(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();
  });

  test('shows a visible focus ring on a keyboard-focused control', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'A focus indicator is a keyboard concern.');

    // Focus has to arrive by keyboard: `:focus-visible` deliberately does not
    // match a pointer click, which is the whole point of the rule (D10).
    await comparison(page).focus();
    await page.keyboard.press('Shift+Tab');

    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        id: element.id,
        focusVisible: element.matches(':focus-visible'),
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
      };
    });

    expect(focused?.id).toBe('viewer-time-range');
    expect(focused?.focusVisible).toBe(true);
    expect(focused?.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(focused?.outlineWidth ?? '0')).toBeGreaterThan(0);
  });

  test('gives every widget an accessible name', async ({ page }) => {
    // Each widget is its own labelled region, so a screen reader can move
    // between them rather than through one undifferentiated grid.
    expect(await page.getByRole('region').count()).toBeGreaterThanOrEqual(4);
  });
});

test.describe('dashboard viewer on a phone', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);
  });

  test('reflows into a single column without horizontal scrolling', async ({ page }) => {
    await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The KPI cards stack instead of sitting side by side: reading order
    // survives the 4-column mobile raster (D2).
    const first = await page.getByRole('region', { name: 'Besuche', exact: true }).boundingBox();
    const second = await page
      .getByRole('region', { name: 'Seitenaufrufe', exact: true })
      .boundingBox();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height - 1);
  });

  test('keeps the chart inside the viewport', async ({ page }) => {
    const box = await page
      .getByRole('region', { name: 'Besuche im Zeitverlauf', exact: true })
      .boundingBox();

    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  });

  test('still changes the time range on a touch device', async ({ page }) => {
    await timeRange(page).selectOption('previous_month');
    await apply(page).click();

    await expect(page).toHaveURL(/timeRange=previous_month/);
    await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();
  });
});

// --- helpers ---------------------------------------------------------------

/** Navigates the way a user does: projects, the project, then the dashboard. */
async function openDashboard(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.getByRole('link', { name: PROJECT_NAME }).first().click();
  await page.getByRole('link', { name: DASHBOARD_NAME }).click();
  await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();
}

function dashboardIdOf(page: Page): string {
  const match = /\/dashboards\/([^/?]+)/.exec(page.url());
  if (!match) throw new Error(`Not on a dashboard page: ${page.url()}`);
  return match[1]!;
}

// `exact` throughout: the controls sit in a form labelled "Zeitraum und
// Vergleich", which a loose label match would also hit.
const timeRange = (page: Page) => page.getByLabel('Zeitraum', { exact: true });
const comparison = (page: Page) => page.getByLabel('Vergleich', { exact: true });
const apply = (page: Page) => page.getByRole('button', { name: 'Anwenden' });

function kpiCard(page: Page) {
  return page.getByRole('region', { name: 'Besuche', exact: true });
}

/** The first KPI value as rendered, so a change is observable. */
async function kpiValue(page: Page): Promise<string> {
  return kpiCard(page).locator('.axp-numeric').first().innerText();
}
