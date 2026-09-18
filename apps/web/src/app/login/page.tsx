import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@axp/ui';
import { LoginForm } from '@/components/LoginForm';
import { getPlatformStatus } from '@/lib/platform';
import { readSessionToken } from '@/lib/session';

export default async function LoginPage() {
  const t = await getTranslations();

  // An uninitialized instance has no accounts at all; offering a sign-in form
  // there would be a dead end.
  const status = await getPlatformStatus();
  if (status?.initState === 'uninitialized') redirect('/setup');
  if (await readSessionToken()) redirect('/');

  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <div className="brand">
          <span className="brand__name">{t('product.name')}</span>
          <span className="brand__tagline">{t('product.tagline')}</span>
        </div>

        <Card title={t('login.title')} description={t('login.subtitle')}>
          <LoginForm />
        </Card>
      </div>
    </main>
  );
}
