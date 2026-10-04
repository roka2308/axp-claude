import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Card } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { EffectiveAccessPanel } from '@/components/admin/EffectiveAccessPanel';
import { PasswordChangeForm } from '@/components/admin/SelfServiceForms';
import { EmailChangeForm } from '@/components/account/AccountForms';
import { ProfileEditForm } from '@/components/admin/UserForms';
import { updateMyProfileAction } from '@/app/admin/actions';
import { getMyAccess, getMyProfile } from '@/lib/admin';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { logoutAction } from '@/app/login/actions';

/**
 * Mein Profil (D5, Master Spec §12).
 *
 * The same profile form the administrator uses, with the same ownership rules:
 * a field the identity provider manages is shown with that reason, not as an
 * editable field that silently reverts. Below it, the person's own answer to
 * "what can I do, where, and why".
 */
export default async function ProfilePage() {
  const t = await getTranslations();
  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const [{ profile, pendingEmailChange }, access] = await Promise.all([
    getMyProfile(),
    getMyAccess(),
  ]);
  const name = `${profile.firstName} ${profile.lastName}`.trim();

  return (
    <AppShell
      activeKey="profile"
      version={version}
      headerEnd={
        <form action={logoutAction}>
          <Button type="submit" variant="ghost">
            {t('login.signOut')}
          </Button>
        </form>
      }
    >
      <div className="stack stack--loose">
        <h1>{t('administration.self.title')}</h1>

        <Card
          title={t('administration.self.profileTitle')}
          description={
            profile.provider === 'oidc'
              ? t('administration.self.managedBody')
              : t('administration.self.localBody')
          }
        >
          <ProfileEditForm
            initial={{
              firstName: profile.firstName,
              lastName: profile.lastName,
              email: profile.email,
              locale: profile.locale,
            }}
            managed={profile.managedAttributes}
            save={updateMyProfileAction}
          />
        </Card>

        {profile.provider === 'local' && !profile.managedAttributes.includes('email') ? (
          <Card title={t('profile.emailChange.title')}>
            <EmailChangeForm currentEmail={profile.email} pending={pendingEmailChange} />
          </Card>
        ) : null}

        {profile.provider === 'local' ? (
          <Card title={t('administration.self.password.title')}>
            <PasswordChangeForm />
          </Card>
        ) : null}

        <section className="stack" aria-labelledby="my-access">
          <h2 id="my-access">{t('administration.self.accessTitle')}</h2>
          {access.length === 0 ? (
            <p className="text-muted">{t('administration.self.noTenants')}</p>
          ) : (
            access.map((entry) => (
              <Card key={entry.tenantId} title={entry.tenantName}>
                <EffectiveAccessPanel access={entry.effective} subjectName={name} />
              </Card>
            ))
          )}
        </section>
      </div>
    </AppShell>
  );
}
