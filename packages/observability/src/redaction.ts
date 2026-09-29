/**
 * Telemetry content guard.
 *
 * Hard rule (Master Spec §4 and §24): no analytics payloads, credentials,
 * tokens, password hashes or session identifiers in logs or telemetry. This is
 * an acceptance criterion ("no analytics payload in logs"), so the guard is
 * applied centrally rather than trusted to each call site.
 */

/** Keys whose value is replaced with a marker wherever they appear. */
export const REDACTED_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'passwordConfirmation',
  'secret',
  'sessionSecret',
  'token',
  'accessToken',
  'refreshToken',
  'activationToken',
  'bootstrapToken',
  'inviteToken',
  'recoveryToken',
  'apiKey',
  'tokenAuth',
  'token_auth',
  'authorization',
  'cookie',
  'setCookie',
  'set-cookie',
  'credential',
  'credentials',
  'encryptionKey',
  'privateKey',
  'sessionId',
  // Share links and their password sessions (Phase 7): a token in a log is
  // the share itself, handed to whoever reads the log.
  'x-share-token',
  'x-share-session',
  'shareToken',
  'sessionToken',
];

/**
 * Keys that carry Matomo analytics results. Their presence in a log payload is
 * a bug; the guard drops them and marks the record so it is noticed in review.
 */
export const ANALYTICS_PAYLOAD_KEYS: readonly string[] = [
  'analyticsResult',
  'analyticsResults',
  'resultSet',
  'rows',
  'series',
  'dataPoints',
  'matomoResponse',
  'reportData',
];

export const REDACTED_MARKER = '[redacted]';
export const DROPPED_MARKER = '[dropped:analytics-payload]';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 2000;

const lowerSet = (keys: readonly string[]) => new Set(keys.map((k) => k.toLowerCase()));
const redactedKeySet = lowerSet(REDACTED_KEYS);
const analyticsKeySet = lowerSet(ANALYTICS_PAYLOAD_KEYS);

/**
 * Sanitises a value for logging. Unknown structures are traversed defensively:
 * depth, array length and string length are bounded so a large Matomo payload
 * cannot end up in a log line by accident.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated:depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForLog(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `[truncated:${value.length - MAX_ARRAY_ITEMS} more]`]
      : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (redactedKeySet.has(lower)) {
        out[key] = REDACTED_MARKER;
      } else if (analyticsKeySet.has(lower)) {
        out[key] = DROPPED_MARKER;
      } else {
        out[key] = sanitizeForLog(entry, depth + 1);
      }
    }
    return out;
  }
  return `[unsupported:${typeof value}]`;
}
