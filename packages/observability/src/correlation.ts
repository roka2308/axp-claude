import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { CorrelationId } from '@axp/contracts';

/**
 * Request/job context carried implicitly through async work.
 *
 * Gate F0 requires a correlation id to be visible across a basic API request;
 * later milestones extend the same id through schedule -> job -> Matomo ->
 * renderer -> delivery (Master Spec §24).
 */
export interface RequestContext {
  readonly correlationId: CorrelationId;
  readonly requestId?: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly jobId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newCorrelationId(): CorrelationId {
  return randomUUID() as CorrelationId;
}

/**
 * Accepts a correlation id supplied by an upstream caller.
 *
 * Inbound values are untrusted input: anything that is not a plain, bounded
 * token is replaced rather than logged as-is.
 */
export function sanitizeCorrelationId(value: string | undefined | null): CorrelationId {
  if (!value) return newCorrelationId();
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return newCorrelationId();
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return newCorrelationId();
  return trimmed as CorrelationId;
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): CorrelationId | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Adds fields to the current context for the remainder of the async scope.
 *
 * Used once the request has been authenticated, so later log records carry the
 * user, tenant and project without every call site repeating them.
 */
export function enrichContext(patch: Partial<Omit<RequestContext, 'correlationId'>>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current as unknown as Record<string, unknown>, patch);
}
