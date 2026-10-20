'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import {
  cancelEmailChangeAction,
  completePasswordResetAction,
  confirmEmailChangeAction,
  requestEmailChangeAction,
  requestPasswordResetAction,
} from '@/app/account-actions';

/**
 * "Passwort vergessen" (Master Spec §6). The confirmation reads the same for
 * every address, so the page never tells whether an account exists.
 */
export function ForgotPasswordForm() {
  const t = useTranslations('recovery');
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    // Read from the field itself: what was typed or autofilled before the
    // page became interactive counts too.
    const value = String(new FormData(event.currentTarget).get('email') ?? email).trim();
    if (!value) {
      setMessage(t('emailRequired'));
      return;
    }
    startTransition(async () => {
      const outcome = await requestPasswordResetAction(value);
      if (outcome.status === 'ok') setSent(true);
      else if (outcome.status === 'error') setMessage(outcome.message);
    });
  }

  if (sent) {
    return (
      <div className="stack">
        <Callout tone="success" title={t('sentTitle')} live>
          {t('sentBody')}
        </Callout>
        <a href="/login">{t('backToLogin')}</a>
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
      <p className="text-secondary">{t('explain')}</p>
      <TextField
        label={t('email')}
        name="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <div className="stack stack--tight">
        <div>
          <Button type="submit" variant="primary" busy={pending} busyLabel={t('sending')}>
            {t('submit')}
          </Button>
        </div>
        <a href="/login">{t('backToLogin')}</a>
      </div>
    </form>
  );
}

/** Choosing a new password from a reset link. */
export function ResetPasswordForm({ token }: { readonly token: string }) {
  const t = useTranslations('recovery');
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
      const outcome = await completePasswordResetAction({ token, newPassword: password });
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
      <TextField
        label={t('newPassword')}
        type="password"
        autoComplete="new-password"
        required
        hint={t('hint')}
        value={password}
        error={errors.newPassword}
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
      <p className="text-muted">{t('signsOut')}</p>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!password || password !== repeat}
          busy={pending}
          busyLabel={t('saving')}
        >
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Changing one's own e-mail address (Master Spec §12): the current password
 * now, then a confirmation from the new mailbox. Until then the old address
 * stays in use, and the change can be cancelled.
 */
export function EmailChangeForm({
  currentEmail,
  pending: initialPending,
}: {
  readonly currentEmail: string;
  readonly pending: { readonly newEmail: string; readonly expiresAt: string } | null;
}) {
  const t = useTranslations('profile.emailChange');
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  const [waiting, setWaiting] = useState(initialPending);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'critical'; text: string } | null>(
    null,
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const outcome = await requestEmailChangeAction({ newEmail, currentPassword: password });
      if (outcome.status === 'ok' && outcome.data) {
        setWaiting(outcome.data);
        setNewEmail('');
        setPassword('');
        setMessage({ tone: 'success', text: t('sent', { email: outcome.data.newEmail }) });
      } else if (outcome.status === 'error') {
        setMessage({ tone: 'critical', text: outcome.message });
        setErrors(outcome.fieldErrors ?? {});
      }
    });
  }

  function cancel() {
    setMessage(null);
    startTransition(async () => {
      const outcome = await cancelEmailChangeAction();
      if (outcome.status === 'ok') {
        setWaiting(null);
        setMessage({ tone: 'success', text: t('cancelled') });
      } else if (outcome.status === 'error')
        setMessage({ tone: 'critical', text: outcome.message });
    });
  }

  return (
    <div className="stack">
      {message ? (
        <Callout tone={message.tone} live>
          {message.text}
        </Callout>
      ) : null}
      <p className="text-secondary">{t('explain', { email: currentEmail })}</p>
      {waiting ? (
        <div className="stack stack--tight">
          <Callout tone="info" title={t('pendingTitle')}>
            {t('pendingBody', {
              email: waiting.newEmail,
              until: format.dateTime(new Date(waiting.expiresAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </Callout>
          <div>
            <Button type="button" disabled={pending} onClick={cancel}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      <form onSubmit={submit} className="stack" noValidate>
        <TextField
          label={t('newEmail')}
          type="email"
          autoComplete="email"
          required
          value={newEmail}
          error={errors.newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
        />
        <TextField
          label={t('currentPassword')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          error={errors.currentPassword}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={!newEmail.trim() || !password}
            busy={pending}
            busyLabel={t('sending')}
          >
            {t('submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Confirming a new address. A deliberate click rather than on opening the
 * link, so a mail scanner that follows links cannot complete the change.
 */
export function ConfirmEmailChange({ token }: { readonly token: string }) {
  const t = useTranslations('profile.emailChange');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function confirm() {
    setMessage(null);
    startTransition(async () => {
      const outcome = await confirmEmailChangeAction(token);
      if (outcome.status === 'ok' && outcome.data) {
        setDone(outcome.data.email);
        router.refresh();
      } else if (outcome.status === 'error') setMessage(outcome.message);
    });
  }

  if (done) {
    return (
      <div className="stack">
        <Callout tone="success" title={t('confirmedTitle')} live>
          {t('confirmedBody', { email: done })}
        </Callout>
        <a href="/profile">{t('toProfile')}</a>
      </div>
    );
  }

  return (
    <div className="stack">
      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}
      <p>{t('confirmExplain')}</p>
      <div>
        <Button type="button" variant="primary" busy={pending} onClick={confirm}>
          {t('confirm')}
        </Button>
      </div>
    </div>
  );
}
