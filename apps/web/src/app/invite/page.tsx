import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { AcceptInvitationForm } from '@/components/admin/SelfServiceForms';
import { inspectInvitation } from '@/lib/admin';

interface PageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * Accepting an invitation (D5). Reachable signed out; the token in the link is
 * the only credential, single-use and short-lived. An expired or already used
 * link says so and who to ask, instead of a generic error.
 */
export default async function InvitePage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const t = await getTranslations();
  const invitation = token ? await inspectInvitation(token) : null;

  return (
    <main className="page-centered" id="main-content">
      <div className="page-centered__inner">
        <div className="brand">
          <span className="brand__name">{t('product.name')}</span>
          <span className="brand__tagline">{t('product.tagline')}</span>
        </div>

        {token && invitation ? (
          <Card
            title={t('administration.self.invitation.title', { name: invitation.firstName })}
            description={t('administration.self.invitation.body')}
          >
            <AcceptInvitationForm token={token} email={invitation.email} />
          </Card>
        ) : (
          <Callout tone="warning" title={t('administration.self.invitation.invalidTitle')}>
            {t('administration.self.invitation.invalidBody')}
          </Callout>
        )}
      </div>
    </main>
  );
}
