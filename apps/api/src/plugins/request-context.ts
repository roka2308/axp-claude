import type { FastifyInstance } from 'fastify';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  type CorrelationId,
} from '@axp/contracts';
import { newCorrelationId, runWithContext, sanitizeCorrelationId } from '@axp/observability';

/**
 * Establishes the async request context.
 *
 * An inbound correlation id is accepted (and sanitised) so a trace started in
 * the web app continues here; otherwise a fresh one is minted. The id is echoed
 * on the response, which is what makes it visible end to end - Gate F0.
 *
 * `done()` is called inside `runWithContext` on purpose: that is what keeps the
 * remaining hooks and the route handler inside the same async scope.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const inbound = request.headers[CORRELATION_ID_HEADER];
    const correlationId: CorrelationId = Array.isArray(inbound)
      ? sanitizeCorrelationId(inbound[0])
      : inbound
        ? sanitizeCorrelationId(inbound)
        : newCorrelationId();

    void reply.header(CORRELATION_ID_HEADER, correlationId);
    void reply.header(REQUEST_ID_HEADER, request.id);

    runWithContext({ correlationId, requestId: String(request.id) }, done);
  });
}
