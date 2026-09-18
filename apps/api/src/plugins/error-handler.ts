import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, errors } from '@axp/contracts';
import { getCorrelationId } from '@axp/observability';

/**
 * The single place where an internal failure becomes a client response.
 *
 * Three rules from the state/error contract (Shared Contract §15) hold here:
 *   - clients receive a stable category plus an i18n key, never a raw message
 *     from a driver, a library or Matomo;
 *   - unexpected errors are logged in full but answered generically, with only
 *     a correlation id to connect the two;
 *   - the response carries the D10 cause state, so the UI can render the right
 *     surface instead of one generic error page.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const correlationId = getCorrelationId();

    if (AppError.isAppError(error)) {
      // Expected, modelled outcomes: warn for denials, info for the rest.
      const level = error.httpStatus >= 500 ? 'error' : 'info';
      request.log[level](
        { err: error, category: error.category, code: error.code },
        'Request rejected',
      );
      return reply.status(error.httpStatus).send(error.toResponseBody(correlationId));
    }

    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of error.issues) {
        const path = issue.path.join('.') || '(root)';
        fieldErrors[path] ??= issue.message;
      }
      const appError = errors.validationFailed('schema', {
        messageKey: 'errors.validation_failed.schema',
        fieldErrors,
        internalMessage: 'Request body failed schema validation.',
      });
      request.log.info({ fieldErrors }, 'Request failed validation');
      return reply.status(appError.httpStatus).send(appError.toResponseBody(correlationId));
    }

    // Fastify's own validation/parse errors arrive with a statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      const appError = errors.validationFailed('bad_request', {
        messageKey: 'errors.validation_failed.bad_request',
        internalMessage: error instanceof Error ? error.message : String(error),
      });
      request.log.info({ err: error }, 'Malformed request');
      return reply.status(statusCode).send(appError.toResponseBody(correlationId));
    }

    request.log.error({ err: error }, 'Unhandled error');
    const internal = errors.internal('unexpected', {
      messageKey: 'errors.internal_error.unexpected',
    });
    return reply.status(500).send(internal.toResponseBody(correlationId));
  });

  app.setNotFoundHandler((request, reply) => {
    const appError = errors.notFound('route', {
      messageKey: 'errors.not_found.route',
      internalMessage: `No route for ${request.method} ${request.url}`,
    });
    return reply.status(404).send(appError.toResponseBody(getCorrelationId()));
  });
}
