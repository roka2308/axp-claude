import { type SelectHTMLAttributes, useId } from 'react';
import styles from './SelectField.module.css';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Secondary line under the label, e.g. a time zone or an identifier. */
  readonly detail?: string;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  /** Resolved, human-readable message. Associated with the control. */
  readonly error?: string;
  readonly options: readonly SelectOption[];
  /** First entry, selected when nothing is chosen yet. */
  readonly placeholder?: string;
}

/**
 * Native select with its label, hint and error wired together.
 *
 * Native on purpose: it is keyboard operable, works with every assistive
 * technology, and on a phone it opens the platform picker - none of which a
 * custom listbox would give us for free (D10, G2).
 *
 * `detail` is folded into the option text rather than rendered beside it: an
 * `<option>` may not contain markup, and a detail only a sighted user can read
 * would be information carried outside the accessible name.
 */
export function SelectField({
  label,
  hint,
  error,
  options,
  placeholder,
  required,
  className,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

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

      <select
        {...rest}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[styles.select, error ? styles.invalid : ''].filter(Boolean).join(' ')}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.detail ? `${option.label} — ${option.detail}` : option.label}
          </option>
        ))}
      </select>

      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
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
