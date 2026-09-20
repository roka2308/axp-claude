import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '@axp/contracts';

export const LOCALE_COOKIE = 'axp_locale';

/**
 * Locale resolution (Master Spec §19).
 *
 * UI language is a user preference, not a URL segment: the product has no
 * locale-prefixed routes, so a shared link works regardless of who opens it.
 * Order is user cookie -> Accept-Language -> default. Tenant and project
 * fallbacks join once those settings exist.
 *
 * Customer-authored content is never auto-translated.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const requested = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isSupportedLocale(requested) ? requested : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // No ambient time zone: system timestamps are UTC, and every displayed
    // instant is formatted with the time zone its context defines - Matomo site
    // time zone for analytics calendars, project time zone for scheduling.
  };
});

export function isSupportedLocale(value: string | undefined): value is Locale {
  return value !== undefined && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
