import { describe, expect, it } from 'vitest';
import {
  renderThemeCss,
  THEME_CONTRAST_PAIRS,
  THEMEABLE_TOKENS,
  validateThemeTokens,
} from './theme-contract';

/**
 * Themes are untrusted customer input (Master Spec §16): a theme may change
 * token values and nothing else. "No arbitrary customer CSS/JS" is a Gate F9
 * criterion, and the boundary is enforced here rather than at render time.
 */
describe('theme token validation', () => {
  it('accepts allowlisted tokens with safe colour values', () => {
    const result = validateThemeTokens({
      '--accent-default': '#E20074',
      '--surface-card': '#ffffff',
      '--chart-series-1': '#2a78d6',
    });
    expect(result.issues).toEqual([]);
    expect(result.accepted['--accent-default']).toBe('#E20074');
  });

  it('rejects tokens outside the allowlist', () => {
    const result = validateThemeTokens({
      '--grid-columns-desktop': '16',
      '--focus-ring-width': '0px',
      '--target-size-min': '1px',
    });
    // Layout and accessibility guarantees are not brandable.
    expect(result.accepted).toEqual({});
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      'not_themeable',
      'not_themeable',
      'not_themeable',
    ]);
  });

  it('rejects values that would smuggle CSS through a token', () => {
    const hostile = {
      '--surface-card': 'url(https://evil.example/pixel.png)',
      '--accent-default': 'red; } body { display: none } :root {',
      '--text-primary': 'var(--some-other-token)',
      '--font-sans': 'Arial; background: url(javascript:alert(1))',
      '--shadow-md': 'expression(alert(1))',
    };
    const result = validateThemeTokens(hostile);
    expect(result.accepted).toEqual({});
    expect(result.issues).toHaveLength(Object.keys(hostile).length);
    for (const issue of result.issues) expect(issue.reason).toBe('unsafe_value');
  });

  it('renders only declarations, never a selector a theme controls', () => {
    const { accepted } = validateThemeTokens({ '--accent-default': '#123456' });
    const css = renderThemeCss(accepted);
    expect(css).toBe(':root {\n  --accent-default: #123456;\n}');
    expect(css).not.toContain('@import');
  });

  it('renders nothing when a theme sets no tokens', () => {
    expect(renderThemeCss({})).toBe('');
  });

  it('declares contrast pairs only over themeable tokens', () => {
    // A pair referencing a non-themeable token could never fail, which would
    // make the Phase 9 validation gate silently useless.
    for (const pair of THEME_CONTRAST_PAIRS) {
      expect(THEMEABLE_TOKENS).toContain(pair.foreground);
      expect(THEMEABLE_TOKENS).toContain(pair.background);
      expect(pair.minimumRatio).toBeGreaterThanOrEqual(3);
    }
  });
});
