'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { SetupStepKey } from '@axp/contracts';
import { Button } from '@axp/ui';
import { setStepRelevanceAction } from '@/app/projects/actions';

/**
 * "Nicht relevant" for an optional step, and the way back. A decision a
 * person makes, so it is a button and never inferred (Master Spec §13).
 */
export function StepRelevanceToggle({
  projectId,
  step,
  notRelevant,
}: {
  readonly projectId: string;
  readonly step: SetupStepKey;
  readonly notRelevant: boolean;
}) {
  const t = useTranslations('projectSetup');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      busy={pending}
      onClick={() =>
        startTransition(async () => {
          await setStepRelevanceAction(projectId, step, !notRelevant);
          router.refresh();
        })
      }
    >
      {notRelevant ? t('markRelevant') : t('markNotRelevant')}
    </Button>
  );
}
