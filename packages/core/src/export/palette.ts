/**
 * The colours an export file is drawn with.
 *
 * Exports cannot read CSS, so the default theme's token values are repeated
 * here - and `palette.test.ts` compares them with `tokens.css`, so the two
 * cannot drift apart silently. Tenant themes reach exports with the theme
 * work of Phase 9 (DEV-007).
 */
export const EXPORT_PALETTE = {
  textPrimary: '#101828',
  textSecondary: '#475467',
  textMuted: '#667085',
  borderSubtle: '#e4e7ec',
  borderDefault: '#d0d5dd',
  surfaceSunken: '#eef0f3',
  accentDefault: '#1c5cab',
  chartSeries1: '#2a78d6',
  chartComparison: '#98a2b3',
  chartGrid: '#e4e7ec',
  chartAxis: '#98a2b3',
  evaluationBand: ['#d03b3b', '#ec835a', '#fab219', '#7ab648', '#0ca30c'],
} as const;

/** Token names behind each entry, for the drift test. */
export const EXPORT_PALETTE_TOKENS: Readonly<Record<string, string>> = {
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  borderSubtle: '--border-subtle',
  borderDefault: '--border-default',
  surfaceSunken: '--surface-sunken',
  accentDefault: '--accent-default',
  chartSeries1: '--chart-series-1',
  chartComparison: '--chart-comparison',
  chartGrid: '--chart-grid',
  chartAxis: '--chart-axis',
};
