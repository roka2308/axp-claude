import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { apiRequest } from '@/lib/api-client';
import { getPlatformStatus } from '@/lib/platform';
import { SetupForm } from '@/components/SetupForm';

interface RecoverPageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * Break-glass recovery screen (Gap Review G4).
 *
 * Deliberately a separate route from `/setup`: different token purpose,
 * different endpoint, different audit action. It exists so that losing every
 * platform admin does not reopen the initial setup path.
 */
export default async function RecoverPage({ searchParams }: RecoverPageProps) {
  const t = await getTranslations();
  const { token } = await searchParams;

  const status = await getPlatformStatus();

  if (status?.initState === 'uninitialized') {
    return (
      <RecoverShell title={t('recover.title')}>
        <Callout tone="warning" title={t('setup.tokenInvalid')}>
          {t('errors.bootstrap.not_initialized')}
        </Callout>
      </RecoverShell>
    );
  }

  if (!token || !(await verifyRecoveryToken(token))) {
    return (
      <RecoverShell title={t('recover.title')}>
        <Callout tone="critical" title={t('setup.tokenInvalid')}>
          {t('setup.tokenInvalidBody')}
        </Callout>
      </RecoverShell>
    );
  }

  return (
    <RecoverShell title={t('recover.title')} description={t('recover.subtitle')}>
      <div className="stack">
        <Callout tone="warning">{t('recover.notice')}</Callout>
        <SetupForm token={token} mode="recovery" />
      </div>
    </RecoverShell>
  );
}

async function verifyRecoveryToken(token: string): Promise<boolean> {
  try {
    const result = await apiRequest<{ valid: boolean }>('/platform/recovery/verify', {
      method: 'POST',
      body: { token },
    });
    return result.valid;
  } catch {
    return false;
  }
}

async function RecoverShell({
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
