'use server';

import { redirect } from 'next/navigation';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import { clearSessionCookie, readSessionToken, writeSessionCookie } from '@/lib/session';

export interface LoginFormState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
  readonly action?: string;
  readonly correlationId?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Preserved so a failed attempt does not clear the address field. */
  readonly email?: string;
}

interface LoginResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly userId: string;
  readonly mustChangePassword: boolean;
}

/**
 * Local sign-in.
 *
 * A Server Action rather than a browser fetch: the credentials go straight from
 * the form post to the Next.js server, which calls the API and stores the
 * session in an httpOnly cookie. Next verifies the request origin for Server
 * Actions, which is what covers CSRF here.
 */
export async function loginAction(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  try {
    const result = await apiRequest<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    await writeSessionCookie(result.token, new Date(result.expiresAt));
  } catch (error) {
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      action: resolved.action,
      correlationId: resolved.correlationId,
      fieldErrors: resolved.fieldErrors,
      email,
    };
  }

  // Outside the try block: `redirect` signals by throwing, and catching it here
  // would turn a successful sign-in into an error message.
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    try {
      await apiRequest('/auth/logout', { method: 'POST', token });
    } catch {
      // The local cookie is dropped either way: a user who asked to sign out
      // must end up signed out even if the API call fails.
    }
  }
  await clearSessionCookie();
  redirect('/login');
}
