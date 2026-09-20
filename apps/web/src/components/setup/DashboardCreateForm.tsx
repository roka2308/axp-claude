'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Callout, SelectField, type SelectOption, TextField } from '@axp/ui';
import { INITIAL_SETUP_STATE, type SetupFormState } from '@/app/projects/[projectId]/setup/state';
import { ErrorCallout } from '../ErrorCallout';

export interface DashboardCreateFormProps {
  readonly action: (state: SetupFormState, formData: FormData) => Promise<SetupFormState>;
  /** Sites already assigned to this project. */
  readonly sites: readonly SelectOption[];
}

/**
 * Creates a dashboard as a draft (Master Spec §21).
 *
 * Creating and publishing are separate on purpose: a new dashboard is a draft
 * that nobody else sees, and publishing is a deliberate act that produces an
 * immutable version. Widgets are added in the editor.
 */
export function DashboardCreateForm({ action, sites }: DashboardCreateFormProps) {
  const t = useTranslations('projectSetup');
  const [state, formAction, pending] = useActionState(action, INITIAL_SETUP_STATE);

  if (sites.length === 0) {
    return (
      <Callout tone="warning" title={t('siteRequiredTitle')}>
        {t('siteRequiredBody')}
      </Callout>
    );
  }

  const created = state.status === 'saved';

  return (
    <form action={formAction} className="stack" noValidate>
      {state.status === 'error' && state.message ? (
        <ErrorCallout
          message={state.message}
          action={state.action}
          correlationId={state.correlationId}
        />
      ) : null}

      {created ? (
        <Callout tone="success" live>
          {t('dashboardCreated', { name: state.values?.name ?? '' })}
        </Callout>
      ) : null}

      <TextField
        label={t('dashboardName')}
        name="name"
        defaultValue={created ? '' : state.values?.name}
        required
        error={state.fieldErrors?.name}
      />

      <TextField
        label={t('dashboardDescription')}
        name="description"
        hint={t('dashboardDescriptionHint')}
        defaultValue={created ? '' : state.values?.description}
        error={state.fieldErrors?.description}
      />

      <SelectField
        label={t('dashboardSite')}
        name="siteId"
        options={sites}
        defaultValue={sites[0]?.value}
        required
        error={state.fieldErrors?.siteId}
      />

      <div className="row">
        <Button type="submit" variant="primary" busy={pending} busyLabel={t('creating')}>
          {t('createDashboard')}
        </Button>
      </div>
    </form>
  );
}
