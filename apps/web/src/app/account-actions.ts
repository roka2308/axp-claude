'use server';

import { revalidatePath } from 'next/cache';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import { clearSessionCookie } from '@/lib/session';
import type { AdminOutcome } from './admin/outcome';

/**
 * Links that arrive by mail (Master Spec §6, §12): "Passwort vergessen", the
 * reset itself, and the verified change of one's own e-mail address.
 */

async function run<T>(call: () => Promise<T>): Promise<AdminOutcome<T>> {
  try {
    return { status: 'ok', data: await call() };
  } catch (error) {
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      ...(resolved.fieldErrors ? { fieldErrors: resolved.fieldErrors } : {}),
    };
  }
}

/** Always answers the same; the page never learns whether the address exists. */
export async function requestPasswordResetAction(email: string): Promise<AdminOutcome> {
  return run(async () => {
    await apiRequest('/auth/password-reset', { method: 'POST', body: { email } });
  });
}

export async function completePasswordResetAction(input: {
  token: string;
  newPassword: string;
}): Promise<AdminOutcome> {
  const outcome = await run(async () => {
    await apiRequest('/auth/password-reset/complete', { method: 'POST', body: input });
  });
  // Every session of the account ended; a cookie here would only point at one.
  if (outcome.status === 'ok') await clearSessionCookie();
  return outcome;
}

export async function requestEmailChangeAction(input: {
  newEmail: string;
  currentPassword: string;
}): Promise<AdminOutcome<{ newEmail: string; expiresAt: string }>> {
  const outcome = await run(async () => {
    const result = await apiRequest<{
      pendingEmailChange: { newEmail: string; expiresAt: string };
    }>('/me/email', { method: 'POST', body: input, authenticated: true });
    return result.pendingEmailChange;
  });
  revalidatePath('/profile');
  return outcome;
}

export async function cancelEmailChangeAction(): Promise<AdminOutcome> {
  const outcome = await run(async () => {
    await apiRequest('/me/email', { method: 'DELETE', authenticated: true });
  });
  revalidatePath('/profile');
  return outcome;
}

export async function confirmEmailChangeAction(
  token: string,
): Promise<AdminOutcome<{ email: string }>> {
  return run(() =>
    apiRequest<{ email: string }>('/auth/email-change/confirm', {
      method: 'POST',
      body: { token },
    }),
  );
}
