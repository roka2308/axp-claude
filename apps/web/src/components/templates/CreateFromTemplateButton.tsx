'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { createDashboardFromTemplateAction } from '@/app/templates/actions';

/**
 * "Dashboard aus Vorlage erstellen" (D7).
 *
 * Creates a new dashboard whose draft is a copy of the template, then opens
 * it in the editor. Nothing is published: the new dashboard starts as a draft
 * like any other, and later changes to the template never reach it.
 */
export function CreateFromTemplateButton({
  projectId,
  templateId,
  templateName,
}: {
  readonly projectId: string;
  readonly templateId: string;
  readonly templateName: string;
}) {
  const t = useTranslations('templates');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(templateName);
  const [error, setError] = useState<string | null>(null);

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const outcome = await createDashboardFromTemplateAction(projectId, templateId, name);
      if (outcome.status === 'ok' && outcome.data) {
        router.push(`/dashboards/${outcome.data.dashboardId}/edit` as Route);
      } else if (outcome.status === 'error') {
        setError(outcome.message);
      }
    });
  }

  if (!open) {
    return (
      <div>
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          {t('createDashboard')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={create} className="stack stack--tight" noValidate>
      {error ? (
        <Callout tone="critical" live>
          {error}
        </Callout>
      ) : null}
      <TextField
        label={t('dashboardName')}
        value={name}
        required
        onChange={(event) => setName(event.target.value)}
        hint={t('copyHint')}
      />
      <div className="row">
        <Button
          type="submit"
          variant="primary"
          disabled={!name.trim()}
          busy={pending}
          busyLabel={t('creating')}
        >
          {t('createAndEdit')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
