import type { ReactNode } from 'react';
import styles from './Callout.module.css';

export type CalloutTone = 'info' | 'success' | 'warning' | 'critical';

export interface CalloutProps {
  readonly tone?: CalloutTone;
  readonly title?: string;
  readonly children: ReactNode;
  /** Announce the content when it appears, e.g. a form-level submission error. */
  readonly live?: boolean;
}

/**
 * Short, action-oriented message block.
 *
 * Each tone ships a textual marker alongside the colour, because status may
 * never be communicated by colour alone (D10). Error copy follows the product
 * rule: what happened, what it means, what to do next.
 */
export function Callout({ tone = 'info', title, children, live = false }: CalloutProps) {
  return (
    <div
      className={[styles.callout, styles[tone]].join(' ')}
      role={tone === 'critical' ? 'alert' : live ? 'status' : undefined}
      aria-live={live && tone !== 'critical' ? 'polite' : undefined}
    >
      <span className={styles.icon} aria-hidden="true">
        {TONE_MARKER[tone]}
      </span>
      <div className={styles.body}>
        {title ? <span className={styles.title}>{title}</span> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

const TONE_MARKER: Record<CalloutTone, string> = {
  info: 'i',
  success: '\u2713',
  warning: '!',
  critical: '\u00d7',
};
