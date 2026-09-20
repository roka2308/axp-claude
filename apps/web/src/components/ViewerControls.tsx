'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { TIME_RANGE_PRESETS, COMPARISON_MODES } from '@axp/contracts';
import styles from './ViewerControls.module.css';

export interface ViewerControlsProps {
  readonly timeRange: string;
  readonly comparison: string;
}

/**
 * The only two analytics interactions a viewer has in MVP: time range and
 * comparison (D4).
 *
 * A plain GET form, so it works without JavaScript and every control is
 * reachable by keyboard. JavaScript only removes the extra click by submitting
 * on change; the submit button stays for anyone who does not get that.
 *
 * There is deliberately no filter control here. Fixed filters are Data Scope:
 * visible, but read-only for viewers.
 */
export function ViewerControls({ timeRange, comparison }: ViewerControlsProps) {
  const t = useTranslations('viewer');
  const formRef = useRef<HTMLFormElement>(null);

  const submit = () => formRef.current?.requestSubmit();

  return (
    <form ref={formRef} method="get" className={styles.controls} aria-label={t('controlsLabel')}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="viewer-time-range">
          {t('timeRange')}
        </label>
        <select
          id="viewer-time-range"
          name="timeRange"
          className={styles.select}
          defaultValue={timeRange}
          onChange={submit}
        >
          {TIME_RANGE_PRESETS.filter((preset) => preset !== 'custom').map((preset) => (
            <option key={preset} value={preset}>
              {t(`presets.${preset}`)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="viewer-comparison">
          {t('comparison')}
        </label>
        <select
          id="viewer-comparison"
          name="comparison"
          className={styles.select}
          defaultValue={comparison}
          onChange={submit}
        >
          {COMPARISON_MODES.filter((mode) => mode !== 'custom').map((mode) => (
            <option key={mode} value={mode}>
              {t(`comparisons.${mode}`)}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={styles.apply}>
        {t('apply')}
      </button>
    </form>
  );
}
