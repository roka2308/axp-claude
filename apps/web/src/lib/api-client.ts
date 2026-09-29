import 'server-only';
import { headers } from 'next/headers';
import {
  CORRELATION_ID_HEADER,
  type ProductErrorBody,
  type ProductErrorResponse,
} from '@axp/contracts';
import { getConfig } from '@axp/config';
import { newCorrelationId, sanitizeCorrelationId } from '@axp/observability';
import { readSessionToken } from './session';

/**
 * Server-side client for the API process.
 *
 * This module is the only way the web app reaches the backend, and it is
 * `server-only`: the browser never calls the API directly, never sees a session
 * token in JavaScript, and never learns a Matomo credential exists.
 *
 * The correlation id is propagated on every call, so a user-visible error can
 * be traced through web -> api -> Matomo (Master Spec §24).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: ProductErrorBody;

  constructor(status: number, body: ProductErrorBody) {
    super(`${body.category}:${body.code}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** The API could not be reached at all - distinct from an API-reported error. */
export class ApiUnreachableError extends Error {
  readonly correlationId: string;

  constructor(correlationId: string, cause: unknown) {
    super('The API process could not be reached.', { cause });
    this.name = 'ApiUnreachableError';
    this.correlationId = correlationId;
  }
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Send the caller's session token. Off for public endpoints. */
  readonly authenticated?: boolean;
  /** Explicit token, for the moment right after login before the cookie is set. */
  readonly token?: string;
  readonly cache?: RequestCache;
  readonly timeoutMs?: number;
  /** Extra headers - the share token travels this way, never in a URL. */
  readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const config = getConfig();
  const correlationId = await currentCorrelationId();

  const requestHeaders: Record<string, string> = {
    accept: 'application/json',
    [CORRELATION_ID_HEADER]: correlationId,
  };

  if (options.body !== undefined) requestHeaders['content-type'] = 'application/json';
  Object.assign(requestHeaders, options.headers ?? {});

  const token = options.token ?? (options.authenticated ? await readSessionToken() : null);
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${config.api.publicUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: requestHeaders,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Product data is never cached at this layer; freshness is decided per
      // feature, and analytics results are never stored at all.
      cache: options.cache ?? 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiUnreachableError(correlationId, error);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body = (payload as ProductErrorResponse | null)?.error;
    throw new ApiError(
      response.status,
      body ?? {
        category: 'internal_error',
        code: 'unparsable_error',
        messageKey: 'errors.internal_error.unexpected',
        correlationId,
      },
    );
  }

  return payload as T;
}

/**
 * Reuses the correlation id the API echoed on the inbound request when one is
 * present, so a page render and the calls it makes share a single trace.
 */
async function currentCorrelationId(): Promise<string> {
  try {
    const inbound = (await headers()).get(CORRELATION_ID_HEADER);
    return inbound ? sanitizeCorrelationId(inbound) : newCorrelationId();
  } catch {
    // Outside a request scope (build-time evaluation) there is no header store.
    return newCorrelationId();
  }
}

/**
 * Fetches a file from the API and hands back its bytes and headers.
 *
 * For export downloads, which are not JSON. Errors still arrive as the
 * product's JSON error body and are raised as `ApiError` like everywhere else.
 */
export async function apiDownload(
  path: string,
  options: Pick<ApiRequestOptions, 'authenticated' | 'headers' | 'timeoutMs'> = {},
): Promise<{ body: ArrayBuffer; contentType: string; disposition: string }> {
  const config = getConfig();
  const correlationId = await currentCorrelationId();
  const requestHeaders: Record<string, string> = {
    [CORRELATION_ID_HEADER]: correlationId,
    ...(options.headers ?? {}),
  };
  const token = options.authenticated ? await readSessionToken() : null;
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${config.api.publicUrl}${path}`, {
      headers: requestHeaders,
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiUnreachableError(correlationId, error);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ProductErrorResponse | null;
    throw new ApiError(
      response.status,
      payload?.error ?? {
        category: 'internal_error',
        code: 'unparsable_error',
        messageKey: 'errors.internal_error.unexpected',
        correlationId,
      },
    );
  }

  return {
    body: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    disposition: response.headers.get('content-disposition') ?? 'attachment',
  };
}
