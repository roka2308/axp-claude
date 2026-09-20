import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@axp/contracts';

/**
 * Authenticated encryption for credentials at rest (Master Spec §19).
 *
 * AES-256-GCM: the ciphertext carries an authentication tag, so a tampered
 * record fails to decrypt rather than decrypting into something attacker-chosen.
 *
 * Used for Matomo tokens. The product stores an encrypted credential or a
 * secret-store reference and never exposes plaintext again: a forgotten token
 * is replaced, not read back.
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  /** Base64 ciphertext with the GCM tag appended. */
  readonly ciphertext: string;
  readonly nonce: string;
  readonly keyVersion: number;
}

export interface SecretBoxOptions {
  /** Base64-encoded 32-byte key, from `CREDENTIAL_ENCRYPTION_KEY`. */
  readonly key: string;
  readonly keyVersion?: number;
}

export class SecretBox {
  private readonly key: Buffer;
  private readonly keyVersion: number;

  constructor(options: SecretBoxOptions) {
    const key = Buffer.from(options.key, 'base64');
    if (key.length !== 32) {
      throw new AppError('invalid_configuration', {
        code: 'credential_key_length',
        internalMessage: `CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}.`,
      });
    }
    this.key = key;
    this.keyVersion = options.keyVersion ?? 1;
  }

  seal(plaintext: string): SealedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
      nonce: nonce.toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  /**
   * Opens a sealed secret.
   *
   * A failure here is an internal error, not a user-facing one: it means the
   * key changed, the row was tampered with, or the record is corrupt. None of
   * those should produce a message that tells a caller which it was.
   */
  open(sealed: SealedSecret): string {
    if (sealed.keyVersion !== this.keyVersion) {
      throw new AppError('internal_error', {
        code: 'credential_key_version_mismatch',
        internalMessage: `Sealed with key version ${sealed.keyVersion}, current is ${this.keyVersion}.`,
      });
    }

    try {
      const raw = Buffer.from(sealed.ciphertext, 'base64');
      if (raw.length <= TAG_BYTES) throw new Error('ciphertext too short');

      const encrypted = raw.subarray(0, raw.length - TAG_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(sealed.nonce, 'base64'));
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new AppError('internal_error', {
        code: 'credential_decrypt_failed',
        internalMessage: 'Stored credential could not be decrypted.',
        cause: error,
      });
    }
  }

  /** Confirms a candidate matches the sealed value, without revealing it. */
  matches(sealed: SealedSecret, candidate: string): boolean {
    try {
      const actual = Buffer.from(this.open(sealed), 'utf8');
      const expected = Buffer.from(candidate, 'utf8');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
