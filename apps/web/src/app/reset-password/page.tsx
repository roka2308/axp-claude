import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { ResetPasswordForm } from '@/components/account/AccountForms';
import { inspectPasswordReset } from '@/lib/admin';

interface PageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * The page a reset link opens. A used or expired link says so and how to get
 * a new one, without saying which of the two it was.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const t = await getTranslations();
  const valid = token ? await inspectPasswordReset(token) : false;

  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <div className="brand">
          <span className="brand__name">{t('product.name')}</span>
          <span className="brand__tagline">{t('product.tagline')}</span>
        </div>
        {token && valid ? (
          <Card title={t('recovery.resetTitle')}>
            <ResetPasswordForm token={token} />
          </Card>
        ) : (
          <Callout tone="warning" title={t('recovery.invalidTitle')}>
            <p>{t('recovery.invalidBody')}</p>
            <a href="/forgot-password">{t('recovery.requestNew')}</a>
          </Callout>
        )}
      </div>
    </main>
  );
}
