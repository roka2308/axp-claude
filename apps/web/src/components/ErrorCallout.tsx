'use client';

import { useTranslations } from 'next-intl';
import { Callout } from '@axp/ui';
import styles from './ErrorCallout.module.css';

export interface ErrorCalloutProps {
  readonly title: string;
  /** What happened, already resolved into the user's language. */
  readonly message: string;
  /** What the user can do about it, when there is something concrete. */
  readonly action?: string;
  /** Links this failure to the server logs. */
  readonly correlationId?: string;
}

/**
 * Product error message.
 *
 * Follows the error rule from Master Spec §17: say what happened, what it
 * means, and what the user can do. The correlation id is real but technical, so
 * it sits behind a disclosure — "Technische Details/Correlation IDs werden nur
 * bei Bedarf gezeigt" — rather than putting an opaque id in front of someone
 * who just mistyped a password.
 */
export function ErrorCallout({ title, message, action, correlationId }: ErrorCalloutProps) {
  const t = useTranslations('errors');

  return (
    <Callout tone="critical" title={title}>
      <div className="stack stack--tight">
        <span>{message}</span>
        {action ? <span className="text-muted">{action}</span> : null}
        {correlationId ? (
          <details className={styles.details}>
            <summary className={styles.summary}>{t('technicalDetails')}</summary>
            <span className={styles.correlationId}>
              {t('correlationId', { id: correlationId })}
            </span>
          </details>
        ) : null}
      </div>
    </Callout>
  );
}
