import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { type AdminContext, type AdminTenant, getAdminContext, pickTenant } from '@/lib/admin';
import { logoutAction } from '@/app/login/actions';
import styles from './AdminFrame.module.css';

export type AdminSection = 'users' | 'groups' | 'access' | 'audit' | 'tenants';

/**
 * The frame every administration page shares (D1 "Administration", D5).
 *
 * Administration contains, depending on permission: Benutzer, Gruppen, Rollen &
 * Rechte, Audit - and for a Platform Admin, Tenants/Kunden with its primary
 * action "Tenant anlegen". Sections the caller cannot use are not offered.
 */
export async function AdminFrame({
  section,
  requestedTenant,
  children,
}: {
  readonly section: AdminSection;
  readonly requestedTenant?: string;
  readonly children: (frame: {
    context: AdminContext;
    tenant: AdminTenant | null;
  }) => React.ReactNode | Promise<React.ReactNode>;
}) {
  const t = await getTranslations();
  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const context = await getAdminContext();
  const tenant = pickTenant(context, requestedTenant);

  const sections: { key: AdminSection; href: string; shown: boolean }[] = [
    { key: 'users', href: '/admin/users', shown: tenant !== null },
    { key: 'groups', href: '/admin/groups', shown: tenant !== null },
    { key: 'access', href: '/admin/access', shown: tenant !== null },
    { key: 'audit', href: '/admin/audit', shown: tenant !== null },
    { key: 'tenants', href: '/admin/tenants', shown: context.platformAdmin },
  ];

  const withTenant = (href: string) =>
    (tenant && href !== '/admin/tenants' ? `${href}?tenant=${tenant.id}` : href) as Route;

  const body =
    context.tenants.length === 0 && !context.platformAdmin ? (
      <Callout tone="warning" title={t('administration.noAccessTitle')}>
        {t('administration.noAccessBody')}
      </Callout>
    ) : (
      await children({ context, tenant })
    );

  return (
    <AppShell
      activeKey="administration"
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
        <header className={styles.header}>
          <h1>{t('administration.title')}</h1>

          {/*
            The tenant these pages are about. A plain GET form, so switching
            works without JavaScript and the choice lives in the URL.
          */}
          {context.tenants.length > 1 && section !== 'tenants' ? (
            <form method="get" className={styles.switcher}>
              <label htmlFor="admin-tenant" className={styles.switcherLabel}>
                {t('administration.tenant')}
              </label>
              <select
                id="admin-tenant"
                name="tenant"
                defaultValue={tenant?.id}
                className={styles.select}
              >
                {context.tenants.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="secondary">
                {t('administration.switchTenant')}
              </Button>
            </form>
          ) : tenant && section !== 'tenants' ? (
            <p className="text-secondary">
              {t('administration.tenant')}: <strong>{tenant.name}</strong>
            </p>
          ) : null}
        </header>

        <nav aria-label={t('administration.sections')}>
          <ul className={styles.tabs}>
            {sections
              .filter((entry) => entry.shown)
              .map((entry) => (
                <li key={entry.key}>
                  <Link
                    href={withTenant(entry.href)}
                    className={styles.tab}
                    aria-current={entry.key === section ? 'page' : undefined}
                  >
                    {t(`administration.section.${entry.key}`)}
                  </Link>
                </li>
              ))}
          </ul>
        </nav>

        {body}
      </div>
    </AppShell>
  );
}
