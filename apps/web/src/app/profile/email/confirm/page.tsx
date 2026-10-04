import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { ConfirmEmailChange } from '@/components/account/AccountForms';

interface PageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * The page a verification link opens (Master Spec §12). It works signed out -
 * the mailbox is the proof - and asks for a click before anything changes.
 */
export default async function ConfirmEmailPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const t = await getTranslations();

  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <div className="brand">
          <span className="brand__name">{t('product.name')}</span>
          <span className="brand__tagline">{t('product.tagline')}</span>
        </div>
        {token ? (
          <Card title={t('profile.emailChange.confirmTitle')}>
            <ConfirmEmailChange token={token} />
          </Card>
        ) : (
          <Callout tone="warning" title={t('profile.emailChange.invalidTitle')}>
            {t('profile.email_link_invalid')}
          </Callout>
        )}
      </div>
    </main>
  );
}
