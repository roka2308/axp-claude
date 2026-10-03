'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@axp/ui';
import { acknowledgeAttentionAction } from '@/app/attention/actions';

export function AcknowledgeButton({ itemId }: { readonly itemId: string }) {
  const t = useTranslations('attention');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span>
      <Button
        type="button"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const outcome = await acknowledgeAttentionAction(itemId);
            setError(outcome.status === 'error' ? outcome.message : null);
          })
        }
      >
        {t('acknowledge')}
      </Button>
      {error ? <span role="alert"> {error}</span> : null}
    </span>
  );
}
