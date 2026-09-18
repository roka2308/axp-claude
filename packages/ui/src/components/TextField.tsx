import { type InputHTMLAttributes, useId } from 'react';
import styles from './TextField.module.css';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  /** Resolved, human-readable message. Associated with the input for screen readers. */
  readonly error?: string;
  /**
   * Marks the field as owned by an identity provider: read-only, with a visible
   * explanation rather than a silently disabled control (Master Spec §12).
   */
  readonly managedByProvider?: string;
}

/**
 * Text input with its label, hint and error wired together.
 *
 * Errors are associated through `aria-describedby` and `aria-invalid`, and the
 * message is text - never a red border alone (D10: no color-only information,
 * understandable form errors).
 */
export function TextField({
  label,
  hint,
  error,
  managedByProvider,
  required,
  className,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const managedId = `${id}-managed`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null, managedByProvider ? managedId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? (
          <span className={styles.requiredMark} aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <input
        {...rest}
        id={id}
        required={required}
        readOnly={rest.readOnly ?? Boolean(managedByProvider)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[styles.input, error ? styles.invalid : ''].filter(Boolean).join(' ')}
      />

      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      ) : null}

      {managedByProvider ? (
        <span className={styles.managed} id={managedId}>
          {managedByProvider}
        </span>
      ) : null}

      {error ? (
        <span className={styles.error} id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
