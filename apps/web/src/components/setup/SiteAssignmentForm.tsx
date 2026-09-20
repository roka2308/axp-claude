'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Callout, SelectField, type SelectOption } from '@axp/ui';
import { INITIAL_SETUP_STATE, type SetupFormState } from '@/app/projects/[projectId]/setup/state';
import { ErrorCallout } from '../ErrorCallout';

export interface SiteAssignmentFormProps {
  readonly action: (state: SetupFormState, formData: FormData) => Promise<SetupFormState>;
  /** Sites the connections report, already flattened across connections. */
  readonly options: readonly SelectOption[];
}

/**
 * Assigns a Matomo site to the project (Master Spec §13).
 *
 * The site time zone is shown with every option because it decides what a day
 * is: every period boundary in the product follows the site, not the server and
 * not the browser (Master Spec §19).
 */
export function SiteAssignmentForm({ action, options }: SiteAssignmentFormProps) {
  const t = useTranslations('projectSetup');
  const [state, formAction, pending] = useActionState(action, INITIAL_SETUP_STATE);

  if (options.length === 0) {
    return (
      <Callout tone="info" title={t('noRemoteSites')}>
        {t('siteSectionBody')}
      </Callout>
    );
  }

  return (
    <form action={formAction} className="stack" noValidate>
      {state.status === 'error' && state.message ? (
        <ErrorCallout
          message={state.message}
          action={state.action}
          correlationId={state.correlationId}
        />
      ) : null}

      {state.status === 'saved' ? (
        <Callout tone="success" live>
          {t('siteAssigned')}
        </Callout>
      ) : null}

      <SelectField
        label={t('siteSelect')}
        name="site"
        options={options}
        placeholder={t('sitePlaceholder')}
        hint={t('siteSectionBody')}
        required
        error={state.fieldErrors?.site}
      />

      <div className="row">
        <Button type="submit" variant="primary" busy={pending} busyLabel={t('assigning')}>
          {t('assignSite')}
        </Button>
      </div>
    </form>
  );
}
