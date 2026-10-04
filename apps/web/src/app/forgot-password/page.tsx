import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@axp/ui';
import { ForgotPasswordForm } from '@/components/account/AccountForms';
import { readSessionToken } from '@/lib/session';

/** "Passwort vergessen" (Master Spec §6): reachable signed out, from the login page. */
export default async function ForgotPasswordPage() {
  const t = await getTranslations();
  if (await readSessionToken()) redirect('/profile');

  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <div className="brand">
          <span className="brand__name">{t('product.name')}</span>
          <span className="brand__tagline">{t('product.tagline')}</span>
        </div>
        <Card title={t('recovery.title')}>
          <ForgotPasswordForm />
        </Card>
      </div>
    </main>
  );
}
