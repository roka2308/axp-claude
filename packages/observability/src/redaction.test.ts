import { describe, expect, it } from 'vitest';
import { DROPPED_MARKER, REDACTED_MARKER, sanitizeForLog } from './redaction';
import { newCorrelationId, sanitizeCorrelationId } from './correlation';

/**
 * Two acceptance items depend on this guard:
 * "No analytics payload in logs" and "Never log secrets, passwords, tokens".
 */
describe('sanitizeForLog', () => {
  it('redacts credentials wherever they appear in the structure', () => {
    const result = sanitizeForLog({
      user: { email: 'a@example.invalid', password: 'hunter2' },
      connection: { url: 'https://matomo.example', tokenAuth: 'abc123' },
      headers: { authorization: 'Bearer xyz', 'x-request-id': 'r-1' },
    }) as Record<string, Record<string, unknown>>;

    expect(result.user!.password).toBe(REDACTED_MARKER);
    expect(result.connection!.tokenAuth).toBe(REDACTED_MARKER);
    expect(result.headers!.authorization).toBe(REDACTED_MARKER);
    // Non-sensitive context survives, otherwise logs stop being useful.
    expect(result.user!.email).toBe('a@example.invalid');
    expect(result.headers!['x-request-id']).toBe('r-1');
  });

  it('matches credential keys regardless of casing', () => {
    const result = sanitizeForLog({ Token_Auth: 'x', PASSWORD: 'y' }) as Record<string, unknown>;
    // The denylist is spelled in lower case; casing must not be a bypass.
    expect(result.Token_Auth).toBe(REDACTED_MARKER);
    expect(result.PASSWORD).toBe(REDACTED_MARKER);
  });

  it('drops analytics result payloads instead of logging them', () => {
    const result = sanitizeForLog({
      widgetId: 'w-1',
      rows: [{ label: '/home', nb_visits: 1234 }],
      matomoResponse: { value: 42 },
    }) as Record<string, unknown>;

    expect(result.rows).toBe(DROPPED_MARKER);
    expect(result.matomoResponse).toBe(DROPPED_MARKER);
    expect(result.widgetId).toBe('w-1');
  });

  it('bounds depth, array length and string length', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    expect(JSON.stringify(sanitizeForLog(deep))).toContain('truncated:depth');

    const long = { items: Array.from({ length: 50 }, (_, index) => index) };
    const sanitized = sanitizeForLog(long) as { items: unknown[] };
    expect(sanitized.items).toHaveLength(21);
    expect(String(sanitized.items[20])).toContain('truncated:30 more');

    const big = { note: 'x'.repeat(5000) };
    expect(String((sanitizeForLog(big) as { note: string }).note)).toContain('[truncated]');
  });

  it('serialises errors without losing the stack', () => {
    const result = sanitizeForLog(new Error('boom')) as Record<string, unknown>;
    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom');
    expect(typeof result.stack).toBe('string');
  });
});

describe('sanitizeCorrelationId', () => {
  it('accepts a plain inbound id so a trace continues across processes', () => {
    expect(sanitizeCorrelationId('abc-123_x:y.z')).toBe('abc-123_x:y.z');
  });

  it('replaces anything that could inject into a log line', () => {
    // Inbound headers are untrusted input.
    for (const hostile of ['a b', 'a\nb', '"; DROP', '<script>', 'x'.repeat(200), '', null]) {
      const result = sanitizeCorrelationId(hostile as string | null);
      expect(result).not.toBe(hostile);
      expect(result).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('mints distinct ids', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});
