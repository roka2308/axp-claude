import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { apiRequest } from '@/lib/api-client';
import { getPlatformStatus } from '@/lib/platform';
import { SetupForm } from '@/components/SetupForm';

interface SetupPageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * Secure initial bootstrap screen (Master Spec §6, Gap Review G4).
 *
 * The page is reachable without authentication - there is no account yet - so
 * it shows the form only against a token the API confirms as usable, and it
 * closes permanently once the platform is initialized. It never reveals WHY a
 * token is unusable.
 */
export default async function SetupPage({ searchParams }: SetupPageProps) {
  const t = await getTranslations();
  const { token } = await searchParams;

  const status = await getPlatformStatus();

  if (status?.initState === 'initialized') {
    return (
      <SetupShell title={t('setup.title')}>
        <Callout tone="info" title={t('setup.alreadyInitialized')}>
          <div className="stack stack--tight">
            <span>{t('setup.alreadyInitializedBody')}</span>
            <Link href="/login">{t('setup.toLogin')}</Link>
          </div>
        </Callout>
      </SetupShell>
    );
  }

  if (!token) {
    return (
      <SetupShell title={t('setup.title')}>
        <Callout tone="warning" title={t('setup.tokenMissing')}>
          {t('setup.tokenMissingBody')}
        </Callout>
      </SetupShell>
    );
  }

  const usable = await verifyToken(token);
  if (!usable) {
    return (
      <SetupShell title={t('setup.title')}>
        <Callout tone="critical" title={t('setup.tokenInvalid')}>
          {t('setup.tokenInvalidBody')}
        </Callout>
      </SetupShell>
    );
  }

  return (
    <SetupShell title={t('setup.title')} description={t('setup.subtitle')}>
      <SetupForm token={token} mode="bootstrap" />
    </SetupShell>
  );
}

async function verifyToken(token: string): Promise<boolean> {
  try {
    const result = await apiRequest<{ valid: boolean }>('/platform/bootstrap/verify', {
      method: 'POST',
      body: { token },
    });
    return result.valid;
  } catch {
    // Treat an unreachable or erroring API as "not usable": showing the form
    // would only produce a failure at submit time.
    return false;
  }
}

async function SetupShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  const t = await getTranslations('product');
  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <div className="brand">
          <span className="brand__name">{t('name')}</span>
          <span className="brand__tagline">{t('tagline')}</span>
        </div>
        <Card title={title} description={description}>
          {children}
        </Card>
      </div>
    </main>
  );
}
