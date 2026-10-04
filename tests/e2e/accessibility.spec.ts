import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  DASHBOARD_NAME,
  EDITOR_STATE,
  FIXTURE_SKIP_REASON,
  PLATFORM_ADMIN_STATE,
  PROJECT_NAME,
  SEMANTIC_STATE,
  TENANT_ADMIN_STATE,
  VIEWER_EMAIL,
  VIEWER_STATE,
} from './session';

/**
 * Accessibility audit (Phase 10; acceptance C).
 *
 * An automated WCAG 2.1 A/AA scan (axe-core) of every core page, each in the
 * role that uses it, in both colour schemes on desktop. It finds what a
 * machine can - names, roles, contrast, structure, ARIA - and complements
 * the keyboard and focus journeys in the other specs, not replaces them.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page: Page, label: string) {
  // Tiles stream in; the scan reads the settled page.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const violations = result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
  expect(violations, `${label}: ${violations.join('\n')}`).toEqual([]);
}

async function openDashboard(page: Page) {
  await page.goto('/dashboards');
  await page.getByRole('link', { name: DASHBOARD_NAME, exact: true }).first().click();
  await page.waitForURL(/\/dashboards\/[^/?]+/);
}

async function openProject(page: Page) {
  await page.goto('/projects');
  await page.getByRole('link', { name: PROJECT_NAME }).first().click();
  await page.waitForURL(/\/projects\/[^/?]+$/);
}

test.describe.configure({ timeout: 120_000 });

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of [
    '/login',
    '/forgot-password',
    '/reset-password?token=unbekannt-0000000000',
    '/invite?token=unbekannt-0000000000',
    '/profile/email/confirm?token=unbekannt-0000000000',
    '/s/unbekannt-0000000000',
  ]) {
    test(`${path} has no WCAG violations`, async ({ page }) => {
      await page.goto(path);
      await audit(page, path);
    });
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`viewer, ${scheme}`, () => {
    test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
    test.use({ storageState: VIEWER_STATE, colorScheme: scheme });

    test('home, library, dashboard, detail view and profile', async ({ page }, testInfo) => {
      test.skip(
        scheme === 'dark' && testInfo.project.name !== 'chromium-desktop',
        'Dark mode is scanned once, on desktop.',
      );
      await page.goto('/');
      await audit(page, 'home');
      await page.goto('/dashboards');
      await audit(page, 'library');
      await openDashboard(page);
      await audit(page, 'dashboard');
      await page
        .getByRole('link', { name: /Details/ })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await audit(page, 'detail view');
      await page.goto('/profile');
      await audit(page, 'profile');
      await page.goto('/attention');
      await audit(page, 'attention');
      await page.goto('/search?q=Portal');
      await audit(page, 'search');
    });
  });
}

test.describe('editor', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: EDITOR_STATE });

  test('project, editor, reports and sharing', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await openProject(page);
    await audit(page, 'project');
    const projectUrl = page.url();
    await page.goto(`${projectUrl}/reports`);
    await audit(page, 'reports');
    await openDashboard(page);
    const dashboardUrl = new URL(page.url()).pathname;
    await page.goto(`${dashboardUrl}/share`);
    await audit(page, 'share');
    await page.goto(`${dashboardUrl}/edit`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await audit(page, 'editor');
    await page.goto('/templates');
    await audit(page, 'templates');
    await page.goto('/templates/install');
    await audit(page, 'solution install');
  });
});

test.describe('semantic catalog manager', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: SEMANTIC_STATE });

  test('catalog and builders', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await openProject(page);
    await page.goto(`${page.url()}/semantics`);
    await audit(page, 'semantics');
  });
});

test.describe('tenant administrator', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: TENANT_ADMIN_STATE });

  test('people, groups, access, audit and themes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Administration is desktop-first.');
    for (const path of [
      '/admin',
      '/admin/users',
      '/admin/groups',
      '/admin/access',
      '/admin/audit',
      '/admin/themes',
      '/admin/users/new',
      '/projects/new',
    ]) {
      await page.goto(path);
      await audit(page, path);
    }
    await page.goto('/admin/users');
    await page
      .getByRole('link', { name: /Viewer/ })
      .first()
      .click();
    await audit(page, 'user detail');
    await openProject(page);
    await page.goto(`${page.url()}/setup`);
    await audit(page, 'project setup');
  });
});

test.describe('platform administrator', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: PLATFORM_ADMIN_STATE });

  test('tenants, wizard and system', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Administration is desktop-first.');
    for (const path of ['/admin/tenants', '/admin/tenants/new', '/admin/system']) {
      await page.goto(path);
      await audit(page, path);
    }
  });
});

test.describe('reduced motion', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('nothing moves when the system asks for less motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDashboard(page);
    const durations = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('button, a, [aria-busy]'))
        .slice(0, 40)
        .map((el) => {
          const style = getComputedStyle(el);
          return [style.transitionDuration, style.animationDuration].flatMap((value) =>
            value
              .split(',')
              .map((part) => Number.parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000)),
          );
        }),
    );
    const longest = Math.max(0, ...durations.flat().filter((value) => Number.isFinite(value)));
    expect(longest).toBeLessThanOrEqual(0.01);
  });
});
