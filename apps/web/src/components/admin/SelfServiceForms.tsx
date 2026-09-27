'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { acceptInvitationAction, changeMyPasswordAction } from '@/app/admin/actions';

/**
 * Changing one's own password (Master Spec §12). It ends every session - this
 * one too - so the page says so before, and sends the person to sign in after.
 */
export function PasswordChangeForm() {
  const t = useTranslations('administration.self.password');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const mismatch = repeat.length > 0 && next !== repeat;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setMessage(null);
    startTransition(async () => {
      const outcome = await changeMyPasswordAction({ currentPassword: current, newPassword: next });
      if (outcome.status === 'ok') {
        router.push('/login');
        router.refresh();
      } else if (outcome.status === 'error') {
        setMessage(outcome.message);
        setErrors(outcome.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}
      <p className="text-secondary">{t('explain')}</p>
      <TextField
        label={t('current')}
        type="password"
        autoComplete="current-password"
        required
        value={current}
        error={errors.currentPassword}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <TextField
        label={t('new')}
        type="password"
        autoComplete="new-password"
        required
        hint={t('hint')}
        value={next}
        error={errors.newPassword}
        onChange={(event) => setNext(event.target.value)}
      />
      <TextField
        label={t('repeat')}
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        error={mismatch ? t('mismatch') : undefined}
        onChange={(event) => setRepeat(event.target.value)}
      />
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!current || !next || next !== repeat}
          busy={pending}
          busyLabel={t('saving')}
        >
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Accepting an invitation (D5): the invited person chooses their own password.
 * Nobody else ever knows it - the administrator only ever saw a link.
 */
export function AcceptInvitationForm({
  token,
  email,
}: {
  readonly token: string;
  readonly email: string;
}) {
  const t = useTranslations('administration.self.invitation');
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [done, setDone] = useState(false);
  const mismatch = repeat.length > 0 && password !== repeat;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setMessage(null);
    startTransition(async () => {
      const outcome = await acceptInvitationAction({ token, password });
      if (outcome.status === 'ok') setDone(true);
      else if (outcome.status === 'error') {
        setMessage(outcome.message);
        setErrors(outcome.fieldErrors ?? {});
      }
    });
  }

  if (done) {
    return (
      <div className="stack">
        <Callout tone="success" title={t('doneTitle')} live>
          {t('doneBody')}
        </Callout>
        <a href="/login">{t('signIn')}</a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}
      <TextField label={t('email')} value={email} readOnly autoComplete="username" />
      <TextField
        label={t('password')}
        type="password"
        autoComplete="new-password"
        required
        hint={t('hint')}
        value={password}
        error={errors.password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <TextField
        label={t('repeat')}
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        error={mismatch ? t('mismatch') : undefined}
        onChange={(event) => setRepeat(event.target.value)}
      />
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!password || password !== repeat}
          busy={pending}
          busyLabel={t('saving')}
        >
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}
