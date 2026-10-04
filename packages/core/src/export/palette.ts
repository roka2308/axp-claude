/**
 * The colours an export file is drawn with.
 *
 * Exports cannot read CSS, so the default theme's token values are repeated
 * here - and `palette.test.ts` compares them with `tokens.css`, so the two
 * cannot drift apart silently. A customer's published theme replaces them per
 * file (`paletteFromTheme`), so a file looks like the product it came from.
 */
export const EXPORT_PALETTE = {
  textPrimary: '#101828',
  textSecondary: '#475467',
  textMuted: '#667085',
  borderSubtle: '#e4e7ec',
  borderDefault: '#868e9c',
  surfaceSunken: '#eef0f3',
  accentDefault: '#1c5cab',
  chartSeries1: '#2a78d6',
  chartComparison: '#98a2b3',
  chartGrid: '#e4e7ec',
  chartAxis: '#98a2b3',
  evaluationBand: ['#d03b3b', '#ec835a', '#fab219', '#7ab648', '#0ca30c'],
} as const;

export type ExportPalette = {
  readonly [K in Exclude<keyof typeof EXPORT_PALETTE, 'evaluationBand'>]: string;
} & { readonly evaluationBand: readonly string[] };

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

/**
 * The palette for a customer's file: the default, with every colour their
 * effective light theme sets. Only plain colours are taken; anything else in
 * a token keeps the default.
 */
export function paletteFromTheme(tokens: Readonly<Record<string, string>>): ExportPalette {
  const hex = (value: string | undefined) =>
    value && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : undefined;
  const palette: Record<string, unknown> = { ...EXPORT_PALETTE };
  for (const [key, token] of Object.entries(EXPORT_PALETTE_TOKENS)) {
    const value = hex(tokens[token]);
    if (value) palette[key] = value;
  }
  palette.evaluationBand = EXPORT_PALETTE.evaluationBand.map(
    (fallback, index) => hex(tokens[`--evaluation-band-${index + 1}`]) ?? fallback,
  );
  return palette as ExportPalette;
}
