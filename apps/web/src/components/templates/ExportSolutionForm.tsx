'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { exportSolutionAction } from '@/app/templates/actions';

/**
 * Export for authorised authors (Master Spec §14).
 *
 * Packages published dashboards with every definition beneath them and hands
 * the result to the browser as a file. The API builds it from the published
 * versions and validates it like an upload, so what is saved here can be
 * installed elsewhere - and carries no data, credentials or customer ids.
 */
export function ExportSolutionForm({
  projectId,
  dashboards,
}: {
  readonly projectId: string;
  readonly dashboards: readonly { id: string; name: string }[];
}) {
  const t = useTranslations('templates');
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>([]);
  const [values, setValues] = useState({
    packageId: 'com.example.portal-solution',
    packageVersion: '1.0.0',
    name: '',
    publisher: '',
  });
  const [message, setMessage] = useState<{ tone: 'success' | 'critical'; text: string } | null>(
    null,
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  if (dashboards.length === 0) return <p className="text-muted">{t('exportNothing')}</p>;

  function toggle(id: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...current, id] : current.filter((entry) => entry !== id),
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const outcome = await exportSolutionAction(projectId, { ...values, dashboardIds: selected });
      if (outcome.status === 'ok' && outcome.data) {
        const blob = new Blob([JSON.stringify(outcome.data.package, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${values.packageId}-${values.packageVersion}.json`;
        link.click();
        URL.revokeObjectURL(url);
        setMessage({ tone: 'success', text: t('exportDone') });
      } else if (outcome.status === 'error') {
        setMessage({ tone: 'critical', text: outcome.message });
        setErrors(outcome.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {message ? (
        <Callout tone={message.tone} live>
          {message.text}
        </Callout>
      ) : null}
      <fieldset className="stack stack--tight">
        <legend>{t('exportDashboards')}</legend>
        {dashboards.map((dashboard) => (
          <label key={dashboard.id} className="row">
            <input
              type="checkbox"
              checked={selected.includes(dashboard.id)}
              onChange={(event) => toggle(dashboard.id, event.target.checked)}
            />
            {dashboard.name}
          </label>
        ))}
      </fieldset>
      <TextField
        label={t('exportName')}
        value={values.name}
        required
        onChange={(event) => setValues({ ...values, name: event.target.value })}
      />
      <TextField
        label={t('exportPublisher')}
        value={values.publisher}
        required
        onChange={(event) => setValues({ ...values, publisher: event.target.value })}
      />
      <div className="row">
        <TextField
          label={t('exportPackageId')}
          value={values.packageId}
          hint={t('exportPackageIdHint')}
          error={errors.packageId}
          onChange={(event) => setValues({ ...values, packageId: event.target.value })}
        />
        <TextField
          label={t('exportVersion')}
          value={values.packageVersion}
          error={errors.packageVersion}
          onChange={(event) => setValues({ ...values, packageVersion: event.target.value })}
        />
      </div>
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={selected.length === 0 || !values.name.trim() || !values.publisher.trim()}
          busy={pending}
          busyLabel={t('exporting')}
        >
          {t('exportSubmit')}
        </Button>
      </div>
    </form>
  );
}
