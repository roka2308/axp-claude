import { AppError } from '@axp/contracts';

/**
 * Configurable password policy (Master Spec §6).
 *
 * Deliberately length-first rather than composition-first: forcing character
 * classes pushes users toward predictable substitutions. Concrete production
 * values come from deployment configuration later; these are the defaults.
 */
export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  /** Number of previous passwords that may not be reused. 0 disables history. */
  readonly historySize: number;
  readonly forbidEmailLocalPart: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  // Bounded so an extreme input cannot turn Argon2 into a denial-of-service vector.
  maxLength: 200,
  historySize: 5,
  forbidEmailLocalPart: true,
};

export interface PasswordCheckContext {
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

/** i18n keys for every rule, so the UI can explain the failure in place. */
export type PasswordViolation =
  | 'password.too_short'
  | 'password.too_long'
  | 'password.contains_email'
  | 'password.contains_name'
  | 'password.repeated_characters';

export function checkPassword(
  password: string,
  context: PasswordCheckContext = {},
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  if (password.length < policy.minLength) violations.push('password.too_short');
  if (password.length > policy.maxLength) violations.push('password.too_long');

  const lower = password.toLowerCase();

  if (policy.forbidEmailLocalPart && context.email) {
    const localPart = context.email.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && lower.includes(localPart)) {
      violations.push('password.contains_email');
    }
  }

  for (const name of [context.firstName, context.lastName]) {
    if (name && name.length >= 3 && lower.includes(name.toLowerCase())) {
      violations.push('password.contains_name');
      break;
    }
  }

  if (/^(.)\1+$/.test(password)) violations.push('password.repeated_characters');

  return violations;
}

export function assertPasswordAllowed(
  password: string,
  context: PasswordCheckContext = {},
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): void {
  const violations = checkPassword(password, context, policy);
  if (violations.length === 0) return;
  throw new AppError('validation_failed', {
    code: 'password_policy',
    messageKey: violations[0]!,
    fieldErrors: { password: violations[0]! },
    internalMessage: `Password rejected by policy: ${violations.join(', ')}`,
  });
}
