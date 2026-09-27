import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { CreateTenantWizard } from '@/components/admin/TenantForms';

/** "Tenant anlegen" (D5): a guided wizard, available to the Platform Admin only. */
export default async function NewTenantPage() {
  const t = await getTranslations();

  return (
    <AdminFrame section="tenants">
      {({ context }) =>
        !context.platformAdmin ? (
          <Callout tone="warning">{t('administration.tenants.notAllowed')}</Callout>
        ) : (
          <Card
            title={t('administration.tenants.wizard.title')}
            description={t('administration.tenants.wizard.body')}
          >
            <CreateTenantWizard />
          </Card>
        )
      }
    </AdminFrame>
  );
}
