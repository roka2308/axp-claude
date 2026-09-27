'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Callout, TextField } from '@axp/ui';
import { createGroupAction } from '@/app/admin/actions';

/** Creating a group changes nobody's access yet, so it needs no preview. */
export function CreateGroupForm({ tenantId }: { readonly tenantId: string }) {
  const t = useTranslations('administration.groups');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'critical'; text: string } | null>(
    null,
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const outcome = await createGroupAction(tenantId, {
        name,
        ...(description ? { description } : {}),
      });
      if (outcome.status === 'ok') {
        setName('');
        setDescription('');
        setMessage({ tone: 'success', text: t('created') });
        router.refresh();
      } else if (outcome.status === 'error') {
        setMessage({ tone: 'critical', text: outcome.message });
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
      <TextField
        label={t('name')}
        value={name}
        required
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t('description')}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <div>
        <Button type="submit" variant="primary" disabled={!name} busy={pending}>
          {t('create')}
        </Button>
      </div>
    </form>
  );
}
