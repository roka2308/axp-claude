'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  SHARE_PASSWORD_MIN_LENGTH,
  SHARE_RIGHTS,
  type ShareExpiryWindow,
  type ShareRight,
  type ShareRights,
} from '@axp/contracts';
import { Button, Callout, TextField } from '@axp/ui';
import { createShareAction } from '@/app/sharing/actions';
import styles from './sharing.module.css';

export interface ShareCreateFormProps {
  readonly dashboardId: string;
  readonly expiry: ShareExpiryWindow;
}

const NO_RIGHTS: ShareRights = {
  timeRange: false,
  comparison: false,
  detail: false,
  export: false,
};

/**
 * Creates an external link (Master Spec §15).
 *
 * The expiry is required and bounded; every right starts off, so a link
 * shows the dashboard's own view unless its author decides otherwise. The
 * link is shown once, right after creation - it is not stored anywhere it
 * could be shown again.
 */
export function ShareCreateForm({ dashboardId, expiry }: ShareCreateFormProps) {
  const t = useTranslations('share');
  const [label, setLabel] = useState('');
  const [expiresOn, setExpiresOn] = useState(expiry.suggested);
  const [rights, setRights] = useState<ShareRights>(NO_RIGHTS);
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [created, setCreated] = useState<{ url: string; label: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const linkField = useRef<HTMLInputElement>(null);

  // The one moment the link can be copied: focus goes straight to it, after
  // the callout is on screen.
  useEffect(() => {
    if (created) linkField.current?.focus();
  }, [created]);

  const passwordTooShort = protect && password.length < SHARE_PASSWORD_MIN_LENGTH;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (passwordTooShort) return;
    startTransition(async () => {
      setError(null);
      setFieldErrors({});
      const outcome = await createShareAction(dashboardId, {
        label: label.trim(),
        expiresOn,
        rights,
        ...(protect ? { password } : {}),
      });
      if (outcome.status === 'ok' && outcome.data) {
        setCreated({ url: outcome.data.url, label: outcome.data.share.label });
        setLabel('');
        setPassword('');
        setProtect(false);
        setRights(NO_RIGHTS);
        setCopied(false);
      } else if (outcome.status === 'error') {
        setError(outcome.message);
        setFieldErrors(outcome.fieldErrors ?? {});
      }
    });
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      linkField.current?.select();
    }
  };

  return (
    <div className="stack">
      {created ? (
        <Callout tone="success" title={t('create.createdTitle', { label: created.label })} live>
          <div className="stack stack--tight">
            <p>{t('create.createdBody')}</p>
            <div className={styles.linkRow}>
              <input
                ref={linkField}
                className={styles.linkField}
                value={created.url}
                readOnly
                aria-label={t('create.linkLabel')}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button type="button" onClick={copy}>
                {copied ? t('create.copied') : t('create.copy')}
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}

      <form className={styles.form} onSubmit={submit} aria-labelledby="share-create-title">
        <h3 id="share-create-title" className={styles.formTitle}>
          {t('create.title')}
        </h3>

        <TextField
          label={t('create.label')}
          hint={t('create.labelHint')}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
          required
          error={fieldErrors.label}
        />

        <TextField
          label={t('create.expiresOn')}
          hint={t('create.expiresOnHint', { max: expiry.max, timezone: expiry.timezone })}
          type="date"
          value={expiresOn}
          min={expiry.min}
          max={expiry.max}
          onChange={(event) => setExpiresOn(event.target.value)}
          required
          error={fieldErrors.expiresOn}
        />

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{t('create.rightsLegend')}</legend>
          <p className={styles.hint}>{t('create.rightsHint')}</p>
          {SHARE_RIGHTS.map((right: ShareRight) => (
            <label key={right} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={rights[right]}
                onChange={(event) => setRights({ ...rights, [right]: event.target.checked })}
              />
              {t(`rights.${right}`)}
            </label>
          ))}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{t('create.passwordLegend')}</legend>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={protect}
              onChange={(event) => setProtect(event.target.checked)}
            />
            {t('create.protect')}
          </label>
          {protect ? (
            <TextField
              label={t('create.password')}
              hint={t('create.passwordHint', { min: SHARE_PASSWORD_MIN_LENGTH })}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              error={
                password.length > 0 && passwordTooShort
                  ? t('create.passwordTooShort', { min: SHARE_PASSWORD_MIN_LENGTH })
                  : fieldErrors.password
              }
            />
          ) : null}
        </fieldset>

        {error ? (
          <Callout tone="critical" title={t('create.failedTitle')}>
            {error}
          </Callout>
        ) : null}

        <div>
          <Button type="submit" variant="primary" disabled={pending || passwordTooShort}>
            {pending ? t('create.creating') : t('create.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
