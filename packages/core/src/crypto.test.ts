import { describe, expect, it } from 'vitest';
import {
  generateSecretToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  safeEqualHex,
  verifyPassword,
} from './crypto';

describe('password hashing', () => {
  it('produces an argon2id hash that verifies', async () => {
    const hash = await hashPassword('korrekt-pferd-batterie-heftklammer');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, 'korrekt-pferd-batterie-heftklammer')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'falsch')).resolves.toBe(false);
  });

  it('salts each hash, so identical passwords do not collide', async () => {
    const [a, b] = await Promise.all([
      hashPassword('gleiches-passwort'),
      hashPassword('gleiches-passwort'),
    ]);
    expect(a).not.toBe(b);
  });

  it('treats a corrupt stored hash as a failed verification, not a crash', async () => {
    // A damaged row must degrade to "wrong password", never to a 500.
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });
});

describe('secret tokens', () => {
  it('generates url-safe high-entropy tokens', () => {
    const token = generateSecretToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url encoded.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(generateSecretToken()).not.toBe(generateSecretToken());
  });

  it('hashes tokens deterministically for lookup', () => {
    const token = generateSecretToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    // The hash must not contain the token itself: a database read never yields
    // a usable credential.
    expect(hashToken(token)).not.toContain(token);
  });

  it('compares digests in constant time and rejects length mismatches', () => {
    const a = hashToken('a');
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, hashToken('b'))).toBe(false);
    expect(safeEqualHex(a, a.slice(0, 10))).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims so lookup is case-insensitive', () => {
    expect(normalizeEmail('  Viewer.Demo@Example.Invalid ')).toBe('viewer.demo@example.invalid');
  });
});
