import { z } from 'zod';
import type { ProductCauseState } from './states';

/**
 * Stable product error categories (Shared Contract §15).
 *
 * Raw vendor errors are logged safely and translated; they never reach the UI.
 */
export const PRODUCT_ERROR_CATEGORIES = [
  'permission_denied',
  'entitlement_required',
  'setup_required',
  'capability_unsupported',
  'source_unavailable',
  'invalid_configuration',
  'validation_failed',
  'conflict',
  'rate_limited',
  'internal_error',
  'authentication_required',
  'not_found',
] as const;

export const productErrorCategorySchema = z.enum(PRODUCT_ERROR_CATEGORIES);
export type ProductErrorCategory = z.infer<typeof productErrorCategorySchema>;

const HTTP_STATUS_BY_CATEGORY: Readonly<Record<ProductErrorCategory, number>> = {
  authentication_required: 401,
  permission_denied: 403,
  entitlement_required: 403,
  setup_required: 409,
  capability_unsupported: 409,
  conflict: 409,
  not_found: 404,
  invalid_configuration: 422,
  validation_failed: 422,
  rate_limited: 429,
  source_unavailable: 503,
  internal_error: 500,
};

const CAUSE_STATE_BY_CATEGORY: Readonly<Partial<Record<ProductErrorCategory, ProductCauseState>>> =
  {
    permission_denied: 'permission_denied',
    entitlement_required: 'entitlement_required',
    setup_required: 'setup_required',
    capability_unsupported: 'capability_unsupported',
    source_unavailable: 'temporarily_unavailable',
  };

export interface ProductErrorBody {
  readonly category: ProductErrorCategory;
  /** Stable machine readable code, e.g. `auth.invalid_credentials`. */
  readonly code: string;
  /** i18n key the UI resolves. Never a raw vendor string. */
  readonly messageKey: string;
  /** Safe interpolation values for the message. */
  readonly messageParams?: Readonly<Record<string, string | number>>;
  /** Field-level problems for form errors, keyed by field path. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** D10 cause state so the UI can pick the right surface instead of a generic error page. */
  readonly causeState?: ProductCauseState;
  /** Shown only on request; links a user report to server logs. */
  readonly correlationId?: string;
}

export interface ProductErrorResponse {
  readonly error: ProductErrorBody;
}

export interface AppErrorOptions {
  readonly code: string;
  readonly messageKey?: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Internal detail for logs only - never serialized to a client. */
  readonly internalMessage?: string;
  readonly cause?: unknown;
}

/**
 * The only error type crossing a transport boundary.
 *
 * `internalMessage` and `cause` stay server-side: `toResponseBody()` is the
 * single place that decides what a client may learn.
 */
export class AppError extends Error {
  readonly category: ProductErrorCategory;
  readonly code: string;
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly httpStatus: number;
  readonly causeState?: ProductCauseState;

  constructor(category: ProductErrorCategory, options: AppErrorOptions) {
    super(options.internalMessage ?? `${category}:${options.code}`, { cause: options.cause });
    this.name = 'AppError';
    this.category = category;
    this.code = options.code;
    this.messageKey = options.messageKey ?? `errors.${category}.${options.code}`;
    this.messageParams = options.messageParams;
    this.fieldErrors = options.fieldErrors;
    this.httpStatus = HTTP_STATUS_BY_CATEGORY[category];
    this.causeState = CAUSE_STATE_BY_CATEGORY[category];
  }

  toResponseBody(correlationId?: string): ProductErrorResponse {
    return {
      error: {
        category: this.category,
        code: this.code,
        messageKey: this.messageKey,
        ...(this.messageParams ? { messageParams: this.messageParams } : {}),
        ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
        ...(this.causeState ? { causeState: this.causeState } : {}),
        ...(correlationId ? { correlationId } : {}),
      },
    };
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Shorthand constructors for the categories used most often. */
export const errors = {
  authenticationRequired: (code = 'required', options?: Partial<AppErrorOptions>) =>
    new AppError('authentication_required', { code, ...options }),
  permissionDenied: (code = 'denied', options?: Partial<AppErrorOptions>) =>
    new AppError('permission_denied', { code, ...options }),
  notFound: (code = 'not_found', options?: Partial<AppErrorOptions>) =>
    new AppError('not_found', { code, ...options }),
  validationFailed: (code = 'invalid_input', options?: Partial<AppErrorOptions>) =>
    new AppError('validation_failed', { code, ...options }),
  conflict: (code = 'conflict', options?: Partial<AppErrorOptions>) =>
    new AppError('conflict', { code, ...options }),
  rateLimited: (code = 'too_many_requests', options?: Partial<AppErrorOptions>) =>
    new AppError('rate_limited', { code, ...options }),
  setupRequired: (code = 'setup_required', options?: Partial<AppErrorOptions>) =>
    new AppError('setup_required', { code, ...options }),
  sourceUnavailable: (code = 'unavailable', options?: Partial<AppErrorOptions>) =>
    new AppError('source_unavailable', { code, ...options }),
  invalidConfiguration: (code = 'invalid', options?: Partial<AppErrorOptions>) =>
    new AppError('invalid_configuration', { code, ...options }),
  internal: (code = 'unexpected', options?: Partial<AppErrorOptions>) =>
    new AppError('internal_error', { code, ...options }),
} as const;
