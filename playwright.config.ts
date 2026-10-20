import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);

/**
 * The journeys every browser of the matrix walks (D10). Keyboard journeys stay
 * in Chromium: Safari's engine skips links on Tab unless the user turns that on.
 */
const SMOKE = new RegExp(
  [
    'signs in and lands on Home',
    'shows the dashboard with its data scope',
    'changes the time range, and the numbers follow',
    'opens a detail view that inherits the dashboard context',
    'closes with Escape and returns focus',
    'a link shows the published dashboard',
    'gives the same answer for any address',
    'shows the canonical Pulse values',
  ].join('|'),
);

const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

/**
 * End-to-end acceptance.
 *
 * Phase 0 covers the bootstrap and sign-in journey plus the accessibility
 * smoke checks Gate F0 asks for; Phase 1 adds the dashboard viewer journey.
 * The remaining D10 journeys are added as their milestones land; the browser
 * matrix covers Chromium, Firefox and WebKit (desktop) plus mobile Safari.
 *
 * The `setup` project signs in once and hands the session to the specs that
 * only need to be signed in - `/auth/login` is rate limited on purpose, and a
 * suite that signs in per case would trip that safeguard.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // Browser matrix (Phase 10): the core journeys once more in desktop
    // Safari's engine, and in Firefox where it can run (E2E_FIREFOX=1).
    // Chromium carries the full suite.
    ...(process.env.E2E_FIREFOX === '1'
      ? [
          {
            name: 'firefox-desktop',
            use: { ...devices['Desktop Firefox'] },
            dependencies: ['setup'],
            grep: SMOKE,
          },
        ]
      : []),
    {
      name: 'webkit-desktop',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
      grep: SMOKE,
    },
    // The viewer is fully responsive on phones; authoring is desktop-first.
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      dependencies: ['setup'],
    },
  ],
});
