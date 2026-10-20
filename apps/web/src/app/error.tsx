'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Callout } from '@axp/ui';

/**
 * What a page shows when rendering it failed unexpectedly (Master Spec §17).
 *
 * Expected states - no permission, no entitlement, setup missing, source
 * unavailable - have their own surfaces inside the pages; this is the last
 * line for everything else. It says what happened and what to do, in the
 * person's language, with the reference support needs - never a stack trace.
 */
export default function PageError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const t = useTranslations('errors');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner stack">
        <h1 ref={heading} tabIndex={-1}>
          {t('pageFailedTitle')}
        </h1>
        <Callout tone="critical">
          <p>{t('generic')}</p>
          <p>{t('genericAction')}</p>
          {error.digest ? (
            <p className="text-muted">{t('reference', { id: error.digest })}</p>
          ) : null}
        </Callout>
        <div className="stack stack--tight">
          <Button type="button" variant="primary" onClick={() => reset()}>
            {t('tryAgain')}
          </Button>
          <a href="/">{t('toHome')}</a>
        </div>
      </div>
    </main>
  );
}
