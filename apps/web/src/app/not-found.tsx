import { getTranslations } from 'next-intl/server';
import { Callout } from '@axp/ui';

/** An address that leads nowhere, in the person's language. */
export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner stack">
        <h1>{t('notFoundTitle')}</h1>
        <Callout tone="info">{t('notFoundBody')}</Callout>
        <a href="/">{t('toHome')}</a>
      </div>
    </main>
  );
}
