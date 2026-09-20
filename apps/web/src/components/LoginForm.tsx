'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, TextField } from '@axp/ui';
import { loginAction, type LoginFormState } from '@/app/login/actions';
import { ErrorCallout } from './ErrorCallout';

const INITIAL_STATE: LoginFormState = { status: 'idle' };

export function LoginForm() {
  const t = useTranslations('login');
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_STATE);

  return (
    <form action={formAction} className="stack" noValidate>
      {state.status === 'error' && state.message ? (
        <ErrorCallout
          title={t('failed')}
          message={state.message}
          action={state.action}
          correlationId={state.correlationId}
        />
      ) : null}

      <TextField
        label={t('email')}
        name="email"
        type="email"
        autoComplete="username"
        defaultValue={state.email}
        required
        error={state.fieldErrors?.email}
      />

      <TextField
        label={t('password')}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={state.fieldErrors?.password}
      />

      <Button type="submit" variant="primary" fullWidth busy={pending} busyLabel={t('submitting')}>
        {t('submit')}
      </Button>
    </form>
  );
}
