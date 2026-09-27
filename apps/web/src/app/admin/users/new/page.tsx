import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { InviteForm } from '@/components/admin/UserForms';

interface PageProps {
  readonly searchParams: Promise<{ readonly tenant?: string }>;
}

export default async function InvitePage({ searchParams }: PageProps) {
  const { tenant: requested } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="users" requestedTenant={requested}>
      {({ tenant }) =>
        !tenant ? null : !tenant.capabilities.includes('tenant.user.invite') ? (
          <Callout tone="warning">{t('administration.invite.notAllowed')}</Callout>
        ) : (
          <Card
            title={t('administration.invite.title')}
            description={t('administration.invite.body')}
          >
            <InviteForm tenantId={tenant.id} />
          </Card>
        )
      }
    </AdminFrame>
  );
}
