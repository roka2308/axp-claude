'use server';

import { getTranslations } from 'next-intl/server';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';

export interface SetupFormState {
  readonly status: 'idle' | 'error' | 'success';
  readonly message?: string;
  readonly action?: string;
  readonly correlationId?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly values?: {
    readonly firstName?: string;
    readonly lastName?: string;
    readonly email?: string;
  };
}

type SetupMode = 'bootstrap' | 'recovery';

/**
 * Creates the first platform admin, or restores access through break-glass.
 *
 * The two modes share this action because the form is identical; the endpoints,
 * token purposes and audit trails on the server are separate (Gap Review G4).
 *
 * No redirect on success: the account exists but is not signed in, and the
 * success screen states that explicitly rather than silently starting a session.
 */
async function submit(
  mode: SetupMode,
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const t = await getTranslations('setup');

  const token = String(formData.get('token') ?? '');
  const firstName = String(formData.get('firstName') ?? '').trim();
  const lastName = String(formData.get('lastName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const passwordConfirm = String(formData.get('passwordConfirm') ?? '');

  const values = { firstName, lastName, email };

  // Confirmation is a client-side concept: the API never receives it, so the
  // mismatch is caught here rather than modelled as a server error.
  if (password !== passwordConfirm) {
    return {
      status: 'error',
      message: t('passwordMismatch'),
      fieldErrors: { passwordConfirm: t('passwordMismatch') },
      values,
    };
  }

  const endpoint =
    mode === 'bootstrap' ? '/platform/bootstrap/complete' : '/platform/recovery/complete';

  try {
    await apiRequest(endpoint, {
      method: 'POST',
      body: { token, firstName, lastName, email, password },
    });
    return { status: 'success' };
  } catch (error) {
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      action: resolved.action,
      correlationId: resolved.correlationId,
      fieldErrors: resolved.fieldErrors,
      values,
    };
  }
}

export async function completeBootstrapAction(
  previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  return submit('bootstrap', previous, formData);
}

export async function completeRecoveryAction(
  previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  return submit('recovery', previous, formData);
}
