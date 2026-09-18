import 'server-only';
import { cookies } from 'next/headers';
import { getConfig } from '@axp/config';

/**
 * Browser session handling.
 *
 * The session token lives in an httpOnly cookie on the web origin. It is read
 * server-side and forwarded to the API as a bearer token, which means:
 *   - no JavaScript in the browser can read it;
 *   - the API needs neither CORS nor CSRF handling, because no browser calls it;
 *   - `SameSite=Lax` plus Next.js Server Action origin checks cover CSRF here.
 */

export async function readSessionToken(): Promise<string | null> {
  const config = getConfig();
  const store = await cookies();
  return store.get(config.session.cookieName)?.value ?? null;
}

export async function writeSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const config = getConfig();
  const store = await cookies();
  store.set({
    name: config.session.cookieName,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    // Secure in every environment that is not plain-HTTP local development.
    secure: config.web.publicUrl.startsWith('https://'),
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const config = getConfig();
  const store = await cookies();
  store.set({
    name: config.session.cookieName,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.web.publicUrl.startsWith('https://'),
    path: '/',
    maxAge: 0,
  });
}
