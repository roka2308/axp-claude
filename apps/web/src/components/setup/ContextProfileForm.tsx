'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  CONTEXT_PROFILE_CORE_FIELDS,
  CONTEXT_PROFILE_OPTIONAL_FIELDS,
  type ContextProfile,
} from '@axp/contracts';
import { Button, Callout, TextField } from '@axp/ui';
import { saveContextProfileAction } from '@/app/projects/actions';

/**
 * The Context Profile (Master Spec §13, Requirements Baseline §15): a small
 * required core - use case and audience - and optional fields below it.
 * "Kontext vor Interpretation": this is what a reader of the numbers should
 * know first. Text only; the product stores it and never interprets it.
 */
export function ContextProfileForm({
  projectId,
  initial,
  readOnly,
}: {
  readonly projectId: string;
  readonly initial: ContextProfile;
  readonly readOnly: boolean;
}) {
  const t = useTranslations('contextProfile');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [profile, setProfile] = useState<ContextProfile>(initial);
  const [message, setMessage] = useState<{ tone: 'success' | 'critical'; text: string } | null>(
    null,
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const outcome = await saveContextProfileAction(projectId, profile);
      if (outcome.status === 'ok') {
        setMessage({ tone: 'success', text: t('saved') });
        router.refresh();
      } else if (outcome.status === 'error') {
        setMessage({ tone: 'critical', text: outcome.message });
      }
    });
  }

  const field = (name: keyof ContextProfile, required: boolean) => (
    <TextField
      key={name}
      label={t(`${name}.label`)}
      hint={t(`${name}.hint`)}
      required={required}
      readOnly={readOnly}
      value={profile[name] ?? ''}
      onChange={(event) => setProfile({ ...profile, [name]: event.target.value })}
    />
  );

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {message ? (
        <Callout tone={message.tone} live>
          {message.text}
        </Callout>
      ) : null}
      {CONTEXT_PROFILE_CORE_FIELDS.map((name) => field(name, true))}
      <details>
        <summary>{t('optionalFields')}</summary>
        <div className="stack">
          {CONTEXT_PROFILE_OPTIONAL_FIELDS.map((name) => field(name, false))}
        </div>
      </details>
      {readOnly ? (
        <p className="text-muted">{t('readOnly')}</p>
      ) : (
        <div>
          <Button type="submit" variant="primary" busy={pending} busyLabel={t('saving')}>
            {t('save')}
          </Button>
        </div>
      )}
    </form>
  );
}
