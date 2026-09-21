'use client';

import { useTranslations } from 'next-intl';
import { hasNumericValue, type ValueEnvelope } from '@axp/contracts';
import styles from './ValueReadout.module.css';

export interface ValueReadoutProps {
  readonly value: ValueEnvelope;
  readonly large?: boolean;
}

/**
 * One value, in whatever state it is in (D10).
 *
 * The reason this is a component rather than a format call: a value that is
 * missing has something to say, and `not_calculable` in particular has to name
 * the inputs that were missing. Rendering "–" would throw that away.
 */
export function ValueReadout({ value, large = false }: ValueReadoutProps) {
  const t = useTranslations();

  if (hasNumericValue(value)) {
    return (
      <span className={`${large ? styles.large : styles.value} axp-numeric`}>
        {value.value.toLocaleString('de-DE', { maximumFractionDigits: 2 })}
      </span>
    );
  }

  if (value.state === 'missing' && value.cause.kind === 'not_calculable') {
    return (
      <span className={styles.state}>
        {t('semantics.notCalculable')}
        {value.cause.missingInputs.length > 0 ? (
          <span className={styles.detail}>
            {t('semantics.missingInputs', { inputs: value.cause.missingInputs.join(', ') })}
          </span>
        ) : null}
      </span>
    );
  }

  if (value.state === 'missing' && 'messageKey' in value.cause) {
    return <span className={styles.state}>{translate(t, value.cause.messageKey)}</span>;
  }

  return <span className={styles.state}>{t(`states.${stateKey(value.state)}`)}</span>;
}

function stateKey(state: ValueEnvelope['state']): string {
  if (state === 'not_applicable') return 'notApplicable';
  if (state === 'not_tracked') return 'notTracked';
  return state;
}

function translate(t: ReturnType<typeof useTranslations>, key: string): string {
  return t.has(key) ? t(key) : t('states.missing');
}
