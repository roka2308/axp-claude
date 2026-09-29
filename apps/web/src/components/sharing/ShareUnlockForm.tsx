'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { unlockShareAction } from '@/app/sharing/actions';
import styles from './sharing.module.css';

/**
 * The password step of a protected share. The password goes to the API
 * once; what comes back is a short session kept in an httpOnly cookie that
 * only this share's pages receive.
 */
export function ShareUnlockForm({ token }: { readonly token: string }) {
  const t = useTranslations('shared');
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      setError(null);
      const outcome = await unlockShareAction(token, password);
      if (outcome.status === 'ok') {
        router.refresh();
      } else if (outcome.status === 'error') {
        setError(outcome.message);
        setPassword('');
      }
    });
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <TextField
        label={t('password')}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        {...(error ? { error } : {})}
      />
      {error ? (
        <Callout tone="critical" title={t('unlockFailed')}>
          {error}
        </Callout>
      ) : null}
      <div>
        <Button type="submit" variant="primary" disabled={pending || password.length === 0}>
          {pending ? t('unlocking') : t('unlock')}
        </Button>
      </div>
    </form>
  );
}
