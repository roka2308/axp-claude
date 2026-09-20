import { describe, expect, it } from 'vitest';
import { AppError } from '@axp/contracts';
import { assertPasswordAllowed, checkPassword, DEFAULT_PASSWORD_POLICY } from './password-policy';

describe('password policy', () => {
  it('accepts a long passphrase without composition rules', () => {
    expect(checkPassword('korrekt-pferd-batterie-heftklammer')).toEqual([]);
  });

  it('rejects passwords below the minimum length', () => {
    expect(checkPassword('kurz123')).toContain('password.too_short');
  });

  it('bounds the maximum length so hashing cannot be abused', () => {
    // Argon2 cost scales with input; an unbounded password is a DoS vector.
    expect(checkPassword('a'.repeat(DEFAULT_PASSWORD_POLICY.maxLength + 1))).toContain(
      'password.too_long',
    );
  });

  it('rejects a password containing the email local part', () => {
    expect(checkPassword('roberts-passwort-2026', { email: 'roberts@example.invalid' })).toContain(
      'password.contains_email',
    );
  });

  it('rejects a password containing the user name', () => {
    expect(checkPassword('MeierMeierMeier', { lastName: 'Meier' })).toContain(
      'password.contains_name',
    );
  });

  it('rejects a single repeated character', () => {
    expect(checkPassword('aaaaaaaaaaaaaaaa')).toContain('password.repeated_characters');
  });

  it('throws a validation error carrying the field and the i18n key', () => {
    try {
      assertPasswordAllowed('short');
      expect.unreachable('expected the policy to reject this password');
    } catch (error) {
      expect(AppError.isAppError(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.category).toBe('validation_failed');
      expect(appError.httpStatus).toBe(422);
      expect(appError.fieldErrors).toEqual({ password: 'password.too_short' });
    }
  });
});
