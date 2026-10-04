import { getSharedThemeCss, getThemeCss } from '@/lib/theming';

/** CSS escape for `<`, so no value can ever close the style element. */
const ESCAPED_LESS_THAN = '\\3c ';

/**
 * The customer's theme, as token declarations (Master Spec §16).
 *
 * The stylesheet is built by the API from allowlisted tokens with validated
 * values - custom properties and nothing else. `<` cannot occur in a valid
 * value; it is escaped anyway. Rendered after the product's tokens, so the
 * theme's values win.
 */
export async function ThemeStyle(
  props:
    | { readonly projectId?: string; readonly dashboardId?: string }
    | { readonly shareToken: string },
) {
  const css =
    'shareToken' in props ? await getSharedThemeCss(props.shareToken) : await getThemeCss(props);
  return <ThemeStyleSheet css={css} />;
}

/**
 * The same, for a stylesheet the page already fetched - so a page that
 * streams (the dashboard viewer) does not hold its first flush for the theme.
 */
export function ThemeStyleSheet({ css }: { readonly css: string }) {
  if (!css) return null;
  return (
    <style
      data-axp-theme=""
      dangerouslySetInnerHTML={{ __html: css.replace(/</g, ESCAPED_LESS_THAN) }}
    />
  );
}
