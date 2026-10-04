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

// --- Defaults, contrast and the theme model (Phase 9) -------------------------

/**
 * The product's own colour values - what a token resolves to when no theme
 * overrides it. Mirrors `tokens.css` (a test compares them), so a theme's
 * contrast is always judged against what will really be on screen.
 */
export const DEFAULT_LIGHT_COLORS: Readonly<Partial<Record<ThemeableToken, string>>> = {
  '--surface-page': '#f6f7f9',
  '--surface-card': '#ffffff',
  '--surface-raised': '#ffffff',
  '--surface-sunken': '#eef0f3',
  '--surface-overlay': '#ffffff',
  '--surface-chart': '#ffffff',
  '--surface-hover': '#f1f3f6',
  '--surface-selected': '#e8f0fb',
  '--border-subtle': '#e4e7ec',
  '--border-default': '#868e9c',
  '--border-strong': '#667085',
  '--text-primary': '#101828',
  '--text-secondary': '#475467',
  '--text-muted': '#667085',
  '--text-link': '#1c5cab',
  '--text-on-accent': '#ffffff',
  '--accent-subtle': '#e8f0fb',
  '--accent-muted': '#86b6ef',
  '--accent-default': '#1c5cab',
  '--accent-hover': '#184f95',
  '--accent-active': '#104281',
  '--accent-contrast': '#ffffff',
  '--chart-series-1': '#2a78d6',
  '--chart-series-2': '#eb6834',
  '--chart-series-3': '#1baf7a',
  '--chart-series-4': '#eda100',
  '--chart-series-5': '#e87ba4',
  '--chart-series-6': '#008300',
  '--chart-series-7': '#4a3aa7',
  '--chart-series-8': '#e34948',
  '--chart-series-other': '#98a2b3',
  '--chart-sequential-100': '#cde2fb',
  '--chart-sequential-200': '#9ec5f4',
  '--chart-sequential-300': '#6da7ec',
  '--chart-sequential-400': '#3987e5',
  '--chart-sequential-500': '#256abf',
  '--chart-sequential-600': '#184f95',
  '--chart-sequential-700': '#0d366b',
  '--chart-diverging-low': '#2a78d6',
  '--chart-diverging-mid': '#f0efec',
  '--chart-diverging-high': '#d03b3b',
  '--chart-comparison': '#98a2b3',
  '--chart-comparison-muted': '#cdd3dd',
  '--chart-grid': '#e4e7ec',
  '--chart-axis': '#98a2b3',
  '--evaluation-band-1': '#d03b3b',
  '--evaluation-band-2': '#ec835a',
  '--evaluation-band-3': '#fab219',
  '--evaluation-band-4': '#7ab648',
  '--evaluation-band-5': '#0ca30c',
  '--focus-ring-color': '#1c5cab',
};

/** Dark mode defaults: prepared, not yet the reference (Master Spec §16). */
export const DEFAULT_DARK_COLORS: Readonly<Partial<Record<ThemeableToken, string>>> = {
  '--surface-page': '#101214',
  '--surface-card': '#191c20',
  '--surface-raised': '#1f2327',
  '--surface-sunken': '#0b0d0f',
  '--surface-overlay': '#1f2327',
  '--surface-chart': '#191c20',
  '--surface-hover': '#23272c',
  '--surface-selected': '#16304f',
  '--border-subtle': '#2a2f36',
  '--border-default': '#6b7480',
  '--border-strong': '#8a93a3',
  '--text-primary': '#f2f4f7',
  '--text-secondary': '#c3c9d2',
  '--text-muted': '#98a2b3',
  '--text-link': '#86b6ef',
  '--accent-subtle': '#16304f',
  '--accent-muted': '#256abf',
  '--accent-default': '#3987e5',
  '--accent-hover': '#5598e7',
  '--accent-active': '#6da7ec',
  '--accent-contrast': '#0b0d0f',
  '--chart-series-1': '#3987e5',
  '--chart-series-2': '#d95926',
  '--chart-series-3': '#199e70',
  '--chart-series-4': '#c98500',
  '--chart-series-5': '#d55181',
  '--chart-series-6': '#008300',
  '--chart-series-7': '#9085e9',
  '--chart-series-8': '#e66767',
  '--chart-series-other': '#667085',
  '--chart-diverging-mid': '#383835',
  '--chart-comparison': '#667085',
  '--chart-comparison-muted': '#3a4049',
  '--chart-grid': '#2a2f36',
  '--chart-axis': '#59616c',
  '--focus-ring-color': '#86b6ef',
};

/** sRGB colour of a validated token value, or null for a non-colour value. */
export function parseColor(value: string): { r: number; g: number; b: number } | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1]!;
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits.slice(0, 6);
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(value.trim());
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return null;
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio between two colours, rounded to two decimals. */
export function contrastRatio(foreground: string, background: string): number | null {
  const a = parseColor(foreground);
  const b = parseColor(background);
  if (!a || !b) return null;
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

export const THEME_MODES = ['light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface ContrastCheck {
  readonly mode: ThemeMode;
  readonly foreground: ThemeableToken;
  readonly background: ThemeableToken;
  readonly foregroundValue: string;
  readonly backgroundValue: string;
  readonly ratio: number | null;
  readonly minimumRatio: number;
  readonly reason: string;
  readonly pass: boolean;
}

/**
 * Every contrast pair, judged on the colours that will really be shown: the
 * product defaults, overridden by each inherited theme in order.
 */
export function evaluateContrast(
  layers: readonly ThemeTokenValues[],
  mode: ThemeMode = 'light',
): ContrastCheck[] {
  const effective: Record<string, string> =
    mode === 'light'
      ? { ...DEFAULT_LIGHT_COLORS }
      : { ...DEFAULT_LIGHT_COLORS, ...DEFAULT_DARK_COLORS };
  for (const layer of layers) Object.assign(effective, layer);
  return THEME_CONTRAST_PAIRS.map((pair) => {
    const foregroundValue = effective[pair.foreground] ?? '';
    const backgroundValue = effective[pair.background] ?? '';
    const ratio = contrastRatio(foregroundValue, backgroundValue);
    return {
      mode,
      foreground: pair.foreground,
      background: pair.background,
      foregroundValue,
      backgroundValue,
      ratio,
      minimumRatio: pair.minimumRatio,
      reason: pair.reason,
      pass: ratio !== null && ratio >= pair.minimumRatio,
    };
  });
}

/** Platform -> Tenant -> optional Project. There is no dashboard theme. */
export const THEME_SCOPES = ['platform', 'tenant', 'project'] as const;
export type ThemeScope = (typeof THEME_SCOPES)[number];

export interface ThemeVersionSummary {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string | null;
  readonly rolledBackFromVersion: number | null;
  readonly isCurrent: boolean;
  readonly tokenCount: number;
}

export interface ThemeOverview {
  readonly scope: ThemeScope;
  readonly tenantId: string | null;
  readonly projectId: string | null;
  readonly name: string;
  /** The working copy, when there is one. */
  readonly draft: {
    readonly name: string;
    readonly tokens: ThemeTokenValues;
    readonly darkTokens: ThemeTokenValues;
    readonly updatedAt: string;
  } | null;
  readonly published: {
    readonly version: number;
    readonly tokens: ThemeTokenValues;
    readonly darkTokens: ThemeTokenValues;
  } | null;
  readonly versions: readonly ThemeVersionSummary[];
  /** What this scope inherits from the scopes above it, as published. */
  readonly inherited: ThemeTokenValues;
  readonly inheritedDark: ThemeTokenValues;
  /** False when the tenant is not entitled to its own theme (it is kept, not applied). */
  readonly applied: boolean;
}

export interface ThemeValidation {
  readonly issues: readonly ThemeValidationIssue[];
  readonly contrast: readonly ContrastCheck[];
  /**
   * Themes further down that would fail once this one is published - a
   * platform theme is judged together with every tenant theme on it.
   */
  readonly dependents: readonly {
    readonly scope: ThemeScope;
    readonly name: string;
    readonly failing: number;
  }[];
  readonly publishable: boolean;
}

/** Ready-made starting points shipped with the product. */
export const THEME_PRESETS = {
  /**
   * Reference theme (Master Spec §16). The product stays brand-neutral; this
   * is one theme among others, shipped as a starting point.
   */
  'telekom-default': {
    name: 'Telekom Default',
    tokens: {
      '--accent-default': '#e20074',
      '--accent-hover': '#c00063',
      '--accent-active': '#a30055',
      '--accent-subtle': '#fbe5f1',
      '--accent-muted': '#f08fc2',
      '--accent-contrast': '#ffffff',
      '--text-link': '#c00063',
      '--focus-ring-color': '#c00063',
      '--surface-selected': '#fbe5f1',
      '--chart-series-1': '#e20074',
    },
  },
  /** A neutral customer theme, for fixtures and demonstrations. */
  'neutral-customer': {
    name: 'Neutral Kunde',
    tokens: {
      '--accent-default': '#0f6e6e',
      '--accent-hover': '#0b5a5a',
      '--accent-active': '#084646',
      '--accent-subtle': '#e3f2f2',
      '--accent-muted': '#7fc2c2',
      '--accent-contrast': '#ffffff',
      '--text-link': '#0b5a5a',
      '--focus-ring-color': '#0b5a5a',
      '--surface-selected': '#e3f2f2',
      '--chart-series-1': '#0f6e6e',
    },
  },
} as const satisfies Record<string, { name: string; tokens: ThemeTokenValues }>;

export type ThemePresetKey = keyof typeof THEME_PRESETS;

/**
 * A resolved theme as a stylesheet, one block per mode.
 *
 * Light values apply in light mode only and dark values in dark mode only, so
 * what the contrast check judged per mode is exactly what each mode shows: a
 * brand accent chosen for white cards never lands on a dark card unchecked.
 * Only allowlisted tokens with validated values reach this function - it
 * re-validates anyway - so the output is custom-property declarations and
 * nothing else.
 */
export function renderThemeStylesheet(theme: {
  readonly light: ThemeTokenValues;
  readonly dark: ThemeTokenValues;
}): string {
  const block = (tokens: ThemeTokenValues) =>
    Object.entries(validateThemeTokens(tokens as Record<string, string>).accepted)
      .map(([token, value]) => `${token}:${value};`)
      .join('');
  const light = block(theme.light);
  const dark = block(theme.dark);
  const parts: string[] = [];
  if (light) {
    parts.push(
      `@media (prefers-color-scheme: light){:root:where(:not([data-theme='dark'])){${light}}}`,
      `:root[data-theme='light']{${light}}`,
    );
  }
  if (dark) {
    parts.push(
      `@media (prefers-color-scheme: dark){:root:where(:not([data-theme='light'])){${dark}}}`,
      `:root[data-theme='dark']{${dark}}`,
    );
  }
  return parts.join('\n');
}
