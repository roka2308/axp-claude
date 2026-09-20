'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { ErrorCallout } from './ErrorCallout';
import {
  completeBootstrapAction,
  completeRecoveryAction,
  type SetupFormState,
} from '@/app/setup/actions';

const INITIAL_STATE: SetupFormState = { status: 'idle' };

export interface SetupFormProps {
  readonly token: string;
  readonly mode: 'bootstrap' | 'recovery';
}

export function SetupForm({ token, mode }: SetupFormProps) {
  const t = useTranslations('setup');
  const tRecover = useTranslations('recover');

  const [state, formAction, pending] = useActionState(
    mode === 'bootstrap' ? completeBootstrapAction : completeRecoveryAction,
    INITIAL_STATE,
  );

  if (state.status === 'success') {
    return (
      <div className="stack">
        <Callout
          tone="success"
          title={mode === 'bootstrap' ? t('successTitle') : tRecover('successTitle')}
        >
          {mode === 'bootstrap' ? t('successBody') : tRecover('successBody')}
        </Callout>
        <Link href="/login">{t('toLogin')}</Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="stack" noValidate>
      {/* The token travels with the form so the page stays stateless. */}
      <input type="hidden" name="token" value={token} />

      {state.status === 'error' && state.message ? (
        <ErrorCallout
          title={t('failed')}
          message={state.message}
          action={state.action}
          correlationId={state.correlationId}
        />
      ) : null}

      <TextField
        label={t('firstName')}
        name="firstName"
        autoComplete="given-name"
        defaultValue={state.values?.firstName}
        required
        error={state.fieldErrors?.firstName}
      />

      <TextField
        label={t('lastName')}
        name="lastName"
        autoComplete="family-name"
        defaultValue={state.values?.lastName}
        required
        error={state.fieldErrors?.lastName}
      />

      <TextField
        label={t('email')}
        name="email"
        type="email"
        autoComplete="username"
        defaultValue={state.values?.email}
        required
        error={state.fieldErrors?.email}
      />

      <TextField
        label={t('password')}
        name="password"
        type="password"
        autoComplete="new-password"
        hint={t('passwordHint')}
        required
        error={state.fieldErrors?.password}
      />

      <TextField
        label={t('passwordConfirm')}
        name="passwordConfirm"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.passwordConfirm}
      />

      <Button type="submit" variant="primary" fullWidth busy={pending} busyLabel={t('submitting')}>
        {mode === 'bootstrap' ? t('submit') : tRecover('submit')}
      </Button>
    </form>
  );
}
