import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly fullWidth?: boolean;
  /**
   * Shows the busy label and disables the control. `aria-busy` is set so the
   * state is announced rather than communicated by the label change alone.
   */
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly children: ReactNode;
}

export function Button({
  variant = 'secondary',
  fullWidth = false,
  busy = false,
  busyLabel,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[variant], fullWidth ? styles.fullWidth : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {busy && busyLabel ? <span className={styles.busyLabel}>{busyLabel}</span> : children}
    </button>
  );
}
