import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Argon2id parameters.
 *
 * OWASP's recommended baseline (19 MiB memory, 2 iterations, parallelism 1).
 * Stored hashes embed their own parameters, so raising these later does not
 * invalidate existing passwords.
 */
/**
 * `Algorithm.Argon2id` from @node-rs/argon2. Spelled as its numeric value
 * because the package declares an ambient const enum, which cannot be read
 * under `verbatimModuleSyntax`.
 */
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2Hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a password. Returns false instead of throwing on a malformed hash,
 * so a corrupt record degrades to "wrong password" rather than a 500.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Generates a cryptographically secure, URL-safe secret.
 *
 * Used for session tokens, invite tokens and the one-time bootstrap activation
 * token. 32 bytes of entropy, base64url encoded.
 */
export function generateSecretToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Hash used for token lookup. Tokens are high-entropy random values, so a fast
 * hash is appropriate here - unlike passwords, they are not guessable.
 * A database read must never yield a usable token.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
