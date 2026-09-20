'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { INITIAL_SETUP_STATE, type SetupFormState } from '@/app/projects/[projectId]/setup/state';
import { ErrorCallout } from '../ErrorCallout';
import { CompatibilityReport } from './CompatibilityReport';

export interface MatomoConnectionFormProps {
  readonly action: (state: SetupFormState, formData: FormData) => Promise<SetupFormState>;
}

/**
 * Connects a Matomo installation (Master Spec §13).
 *
 * Test and save are two buttons on one form, not two forms: testing exists so
 * a wrong address or an under-privileged token is visible *before* anything is
 * stored, and the user should not have to retype three fields in between.
 *
 * The token field is write-only. It is never returned by the server, never
 * re-populated from form state, and there is no path in the product that reads
 * it back - a lost token is replaced, not revealed (Master Spec §19).
 */
export function MatomoConnectionForm({ action }: MatomoConnectionFormProps) {
  const t = useTranslations('projectSetup');
  const [state, formAction, pending] = useActionState(action, INITIAL_SETUP_STATE);

  const saved = state.status === 'saved';

  return (
    <form action={formAction} className="stack" noValidate>
      {state.status === 'error' && state.message ? (
        <ErrorCallout
          title={t('testFailed')}
          message={state.message}
          action={state.action}
          correlationId={state.correlationId}
        />
      ) : null}

      {saved ? (
        <Callout tone="success" title={t('connectionCreated')} live>
          {t('credentialStored')}
        </Callout>
      ) : null}

      <TextField
        label={t('connectionName')}
        name="name"
        hint={t('connectionNameHint')}
        defaultValue={saved ? '' : state.values?.name}
        required
        error={state.fieldErrors?.name}
      />

      <TextField
        label={t('connectionUrl')}
        name="baseUrl"
        type="url"
        inputMode="url"
        placeholder="https://matomo.example.com"
        hint={t('connectionUrlHint')}
        defaultValue={saved ? '' : state.values?.baseUrl}
        required
        error={state.fieldErrors?.baseUrl}
      />

      <TextField
        label={t('connectionToken')}
        name="token"
        type="password"
        autoComplete="off"
        hint={t('connectionTokenHint')}
        required
        error={state.fieldErrors?.token}
      />

      <div className="row">
        <Button type="submit" name="intent" value="test" busy={pending} busyLabel={t('testing')}>
          {t('testConnection')}
        </Button>
        <Button
          type="submit"
          name="intent"
          value="save"
          variant="primary"
          busy={pending}
          busyLabel={t('saving')}
        >
          {t('saveConnection')}
        </Button>
      </div>

      {state.test ? (
        <CompatibilityReport
          compatibility={state.test.compatibility}
          matomoVersion={state.test.matomoVersion}
          probes={state.test.probes}
          limitationKeys={state.test.limitationKeys}
          compact
        />
      ) : null}
    </form>
  );
}
