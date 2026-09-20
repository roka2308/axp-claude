import { getTranslations } from 'next-intl/server';
import type { ProductErrorBody } from '@axp/contracts';
import { ApiError, ApiUnreachableError } from './api-client';

export interface ResolvedError {
  /** What happened, in the user's language. */
  readonly message: string;
  /** What the user can do next, when there is something concrete. */
  readonly action?: string;
  /** Shown only on request; connects a user report to the server logs. */
  readonly correlationId?: string;
  /** Field-level messages, already resolved, keyed by field name. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

/**
 * Turns a transport failure into product copy.
 *
 * Error messages answer three questions (Master Spec §17): what happened, what
 * it means, and what the user can do. Technical detail stays behind the
 * correlation id. A missing translation degrades to the generic message rather
 * than leaking a key or a vendor string into the UI.
 */
export async function resolveError(error: unknown): Promise<ResolvedError> {
  const t = await getTranslations();

  if (error instanceof ApiUnreachableError) {
    return {
      message: t('errors.unreachable'),
      action: t('errors.unreachableAction'),
      correlationId: error.correlationId,
    };
  }

  if (error instanceof ApiError) {
    return resolveProductError(t, error.body);
  }

  return { message: t('errors.generic'), action: t('errors.genericAction') };
}

type Translator = Awaited<ReturnType<typeof getTranslations>>;

function resolveProductError(t: Translator, body: ProductErrorBody): ResolvedError {
  const message = translateKey(t, body.messageKey, body.messageParams) ?? t('errors.generic');

  const fieldErrors = body.fieldErrors
    ? Object.fromEntries(
        Object.entries(body.fieldErrors).map(([field, key]) => [
          field,
          translateKey(t, key) ?? t('errors.generic'),
        ]),
      )
    : undefined;

  return {
    message,
    ...(body.correlationId ? { correlationId: body.correlationId } : {}),
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

/**
 * Resolves a message key coming from the API.
 *
 * Keys arrive either fully qualified (`errors.permission_denied.capability`) or
 * relative to the error namespace (`auth.invalid_credentials`); both are tried.
 */
function translateKey(
  t: Translator,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string | null {
  const candidates = key.startsWith('errors.') ? [key] : [`errors.${key}`, key];
  for (const candidate of candidates) {
    if (t.has(candidate)) {
      return t(candidate, params as never);
    }
  }
  return null;
}
