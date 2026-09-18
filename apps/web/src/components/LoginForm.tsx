'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { loginAction, type LoginFormState } from '@/app/login/actions';

const INITIAL_STATE: LoginFormState = { status: 'idle' };

export function LoginForm() {
  const t = useTranslations('login');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_STATE);

  return (
    <form action={formAction} className="stack" noValidate>
      {state.status === 'error' && state.message ? (
        <Callout tone="critical" title={t('failed')}>
          <div className="stack stack--tight">
            <span>{state.message}</span>
            {state.action ? <span className="text-muted">{state.action}</span> : null}
            {state.correlationId ? (
              <span className="text-muted">
                {tErrors('correlationId', { id: state.correlationId })}
              </span>
            ) : null}
          </div>
        </Callout>
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

      <Button
        type="submit"
        variant="primary"
        fullWidth
        busy={pending}
        busyLabel={t('submitting')}
      >
        {t('submit')}
      </Button>
    </form>
  );
}
