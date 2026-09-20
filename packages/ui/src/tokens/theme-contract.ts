/**
 * The themeable token allowlist (Master Spec §16, Shared Contract §18).
 *
 * A customer theme may change the VALUE of a token on this list and nothing
 * else: no arbitrary CSS, no new selectors, no component anatomy, no navigation
 * logic. Structural tokens (grid columns, breakpoints, focus ring width, touch
 * target size) are deliberately absent - they carry layout and accessibility
 * guarantees that a brand must not be able to override.
 *
 * Theme inheritance is Platform -> Tenant -> optional Project. There is no
 * dashboard-level theme.
 */

export const THEMEABLE_TOKENS = [
  // Typography
  '--font-sans',
  '--font-mono',
  '--font-numeric',

  // Surfaces
  '--surface-page',
  '--surface-card',
  '--surface-raised',
  '--surface-sunken',
  '--surface-overlay',
  '--surface-chart',
  '--surface-hover',
  '--surface-selected',

  // Borders
  '--border-subtle',
  '--border-default',
  '--border-strong',

  // Text
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-link',
  '--text-on-accent',

  // Primary / accent
  '--accent-subtle',
  '--accent-muted',
  '--accent-default',
  '--accent-hover',
  '--accent-active',
  '--accent-contrast',

  // Radius and elevation
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--shadow-sm',
  '--shadow-md',
  '--shadow-lg',

  // Chart palette
  '--chart-series-1',
  '--chart-series-2',
  '--chart-series-3',
  '--chart-series-4',
  '--chart-series-5',
  '--chart-series-6',
  '--chart-series-7',
  '--chart-series-8',
  '--chart-series-other',
  '--chart-sequential-100',
  '--chart-sequential-200',
  '--chart-sequential-300',
  '--chart-sequential-400',
  '--chart-sequential-500',
  '--chart-sequential-600',
  '--chart-sequential-700',
  '--chart-diverging-low',
  '--chart-diverging-mid',
  '--chart-diverging-high',
  '--chart-comparison',
  '--chart-comparison-muted',
  '--chart-grid',
  '--chart-axis',

  // Business evaluation bands
  '--evaluation-band-1',
  '--evaluation-band-2',
  '--evaluation-band-3',
  '--evaluation-band-4',
  '--evaluation-band-5',

  // Focus colour (width and offset stay fixed)
  '--focus-ring-color',
] as const;

export type ThemeableToken = (typeof THEMEABLE_TOKENS)[number];

const THEMEABLE_TOKEN_SET = new Set<string>(THEMEABLE_TOKENS);

/**
 * Token groups whose contrast has to be validated before a theme may be
 * published (Master Spec §16: "Accessibility Contrast Validation ist
 * Bestandteil des Theme Editors"). The validator itself lands in Phase 9; the
 * pairs are declared here so the contract is visible from the start.
 */
export const THEME_CONTRAST_PAIRS: readonly {
  readonly foreground: ThemeableToken;
  readonly background: ThemeableToken;
  readonly minimumRatio: number;
  readonly reason: string;
}[] = [
  {
    foreground: '--text-primary',
    background: '--surface-page',
    minimumRatio: 4.5,
    reason: 'body_text',
  },
  {
    foreground: '--text-primary',
    background: '--surface-card',
    minimumRatio: 4.5,
    reason: 'body_text',
  },
  {
    foreground: '--text-secondary',
    background: '--surface-card',
    minimumRatio: 4.5,
    reason: 'body_text',
  },
  {
    foreground: '--text-muted',
    background: '--surface-card',
    minimumRatio: 4.5,
    reason: 'body_text',
  },
  {
    foreground: '--accent-contrast',
    background: '--accent-default',
    minimumRatio: 4.5,
    reason: 'button_label',
  },
  {
    foreground: '--text-link',
    background: '--surface-card',
    minimumRatio: 4.5,
    reason: 'link_text',
  },
  {
    foreground: '--focus-ring-color',
    background: '--surface-card',
    minimumRatio: 3,
    reason: 'focus_indicator',
  },
  {
    foreground: '--border-default',
    background: '--surface-card',
    minimumRatio: 3,
    reason: 'control_boundary',
  },
];

export type ThemeTokenValues = Partial<Record<ThemeableToken, string>>;

/**
 * Values a theme may contain, with anything outside the allowlist rejected.
 *
 * Themes are untrusted input: a value is accepted only if it matches one of a
 * few safe shapes. This blocks `url(...)`, `expression(...)`, `@import` and
 * custom-property indirection that could otherwise smuggle CSS in through a
 * token value.
 */
const SAFE_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SAFE_RGB = /^rgb\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}(?:\s*\/\s*\d{1,3}%)?\s*\)$/;
const SAFE_LENGTH = /^-?\d+(?:\.\d+)?(?:px|rem|em|%)?$/;
const SAFE_SHADOW =
  /^(?:none|(?:-?\d+(?:\.\d+)?px\s+){2,3}rgb\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*\/\s*\d{1,3}%\s*\))$/;
const SAFE_FONT_STACK = /^[-\w\s,'"]+$/;

export interface ThemeValidationIssue {
  readonly token: string;
  readonly reason: 'not_themeable' | 'unsafe_value';
}

export function validateThemeTokens(input: Record<string, string>): {
  readonly accepted: ThemeTokenValues;
  readonly issues: readonly ThemeValidationIssue[];
} {
  const accepted: Record<string, string> = {};
  const issues: ThemeValidationIssue[] = [];

  for (const [token, value] of Object.entries(input)) {
    if (!THEMEABLE_TOKEN_SET.has(token)) {
      issues.push({ token, reason: 'not_themeable' });
      continue;
    }
    if (!isSafeTokenValue(token, value)) {
      issues.push({ token, reason: 'unsafe_value' });
      continue;
    }
    accepted[token] = value.trim();
  }

  return { accepted: accepted as ThemeTokenValues, issues };
}

function isSafeTokenValue(token: string, rawValue: string): boolean {
  const value = rawValue.trim();
  if (value.length === 0 || value.length > 200) return false;
  // No indirection, no functions beyond the ones matched below, no escapes.
  if (/[;{}()\\]/.test(value) && !SAFE_RGB.test(value) && !SAFE_SHADOW.test(value)) return false;

  if (token.startsWith('--font-')) return SAFE_FONT_STACK.test(value);
  if (token.startsWith('--radius-')) return SAFE_LENGTH.test(value);
  if (token.startsWith('--shadow-')) return SAFE_SHADOW.test(value);
  return SAFE_COLOR.test(value) || SAFE_RGB.test(value);
}

/**
 * Renders accepted tokens as a `:root` block for server-side injection.
 *
 * Only allowlisted names and validated values reach this function, so the
 * output cannot contain anything but custom-property declarations.
 */
export function renderThemeCss(tokens: ThemeTokenValues): string {
  const declarations = Object.entries(tokens)
    .filter(([token]) => THEMEABLE_TOKEN_SET.has(token))
    .map(([token, value]) => `  ${token}: ${value};`)
    .join('\n');
  return declarations.length > 0 ? `:root {\n${declarations}\n}` : '';
}
