import Link from 'next/link';
import type { Route } from 'next';
import type { AccessReason } from '@axp/contracts';
import { getTranslations } from 'next-intl/server';
import { Callout, Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { AccessChain } from '@/components/admin/AccessChain';
import { GrantToObjectForm, RemoveChange } from '@/components/admin/AccessForms';
import { getDashboardAccess, getObjects, getRoles, listGroups, listUsers } from '@/lib/admin';
import styles from '../admin.module.css';

interface PageProps {
  readonly searchParams: Promise<{
    readonly tenant?: string;
    readonly view?: string;
    readonly dashboard?: string;
  }>;
}

const VIEWS = ['roles', 'users', 'objects'] as const;
type View = (typeof VIEWS)[number];

/**
 * Rollen & Rechte (D5) - three views of the same model.
 *
 *   Rollen   what each role is for, what it carries, and who holds it here;
 *   Benutzer every person, leading to their effective access;
 *   Objekte  every dashboard, and who can open it, and why.
 */
export default async function AccessPage({ searchParams }: PageProps) {
  const { tenant: requested, view: rawView, dashboard: dashboardId } = await searchParams;
  const view: View = VIEWS.includes(rawView as View) ? (rawView as View) : 'roles';
  const t = await getTranslations();

  return (
    <AdminFrame section="access" requestedTenant={requested}>
      {async ({ tenant }) => {
        if (!tenant) return null;
        const href = (next: View) => `/admin/access?tenant=${tenant.id}&view=${next}` as Route;

        return (
          <div className="stack stack--loose">
            <nav aria-label={t('administration.access.views')}>
              <ul className={styles.list} style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {VIEWS.map((entry) => (
                  <li key={entry}>
                    <Link href={href(entry)} aria-current={entry === view ? 'page' : undefined}>
                      {t(`administration.access.view.${entry}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {view === 'roles' ? <RolesView tenantId={tenant.id} /> : null}
            {view === 'users' ? <UsersView tenantId={tenant.id} /> : null}
            {view === 'objects' ? (
              <ObjectsView
                tenantId={tenant.id}
                dashboardId={dashboardId}
                manage={tenant.capabilities.includes('tenant.role_assignment.manage')}
              />
            ) : null}
          </div>
        );
      }}
    </AdminFrame>
  );
}

async function RolesView({ tenantId }: { readonly tenantId: string }) {
  const t = await getTranslations();
  const { catalogue, assignments } = await getRoles(tenantId);

  return (
    <div className="stack">
      <Callout tone="info">{t('administration.access.rolesPrinciple')}</Callout>
      {catalogue.map((entry) => {
        const holders = assignments.filter((assignment) => assignment.role === entry.role);
        return (
          <Card
            key={entry.role}
            title={t(`roles.${entry.role}.label`)}
            description={t(`roles.${entry.role}.purpose`)}
          >
            <dl className="stack stack--tight">
              <dt>
                <strong>{t('administration.access.capabilities')}</strong>
              </dt>
              <dd>
                {entry.capabilities.map((capability) => t(`capability.${capability}`)).join(' · ')}
              </dd>
              <dt>
                <strong>{t('administration.access.scopes')}</strong>
              </dt>
              <dd>{entry.allowedScopes.map((scope) => t(`scopes.${scope}`)).join(', ')}</dd>
              <dt>
                <strong>{t('administration.access.automaticData')}</strong>
              </dt>
              <dd>{t('administration.access.automaticDataNo')}</dd>
              <dt>
                <strong>{t('administration.access.holders')}</strong>
              </dt>
              <dd>
                {holders.length === 0
                  ? t('administration.access.noHolders')
                  : holders
                      .map((holder) =>
                        t('administration.access.holder', {
                          name: holder.subjectLabel,
                          kind: t(`administration.subject.${holder.subjectType}`),
                          scope: holder.scopeLabel,
                        }),
                      )
                      .join('; ')}
              </dd>
            </dl>
          </Card>
        );
      })}
    </div>
  );
}

async function UsersView({ tenantId }: { readonly tenantId: string }) {
  const t = await getTranslations();
  const users = await listUsers(tenantId);

  return (
    <div className="stack">
      <p className="text-secondary">{t('administration.access.usersLead')}</p>
      <ul className={styles.list}>
        {users.map((user) => (
          <li key={user.id} className={styles.listItem}>
            <Link href={`/admin/users/${user.id}?tenant=${tenantId}`} className={styles.name}>
              {t('administration.access.whatCan', { name: user.name })}
            </Link>
            <span className={styles.muted}>
              {user.roles.length > 0
                ? user.roles.map((role) => t(`roles.${role}.label`)).join(', ')
                : '—'}
              {user.groups.length > 0 ? ` · ${user.groups.join(', ')}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function ObjectsView({
  tenantId,
  dashboardId,
  manage,
}: {
  readonly tenantId: string;
  readonly dashboardId?: string;
  readonly manage: boolean;
}) {
  const t = await getTranslations();
  const objects = await getObjects(tenantId);
  const selected = objects.dashboards.find((dashboard) => dashboard.id === dashboardId);

  return (
    <div className="stack stack--loose">
      <p className="text-secondary">{t('administration.access.objectsLead')}</p>
      <ul className={styles.list}>
        {objects.dashboards.map((dashboard) => (
          <li key={dashboard.id} className={styles.listItem}>
            <Link
              href={`/admin/access?tenant=${tenantId}&view=objects&dashboard=${dashboard.id}`}
              aria-current={dashboard.id === dashboardId ? 'true' : undefined}
              className={styles.name}
            >
              {dashboard.name}
            </Link>
            <span className={styles.muted}>
              {dashboard.projectName} ·{' '}
              {dashboard.published
                ? t('administration.access.published')
                : t('administration.access.unpublished')}
            </span>
          </li>
        ))}
      </ul>
      {selected ? (
        <DashboardAccess tenantId={tenantId} dashboard={selected} manage={manage} />
      ) : null}
    </div>
  );
}

async function DashboardAccess({
  tenantId,
  dashboard,
  manage,
}: {
  readonly tenantId: string;
  readonly dashboard: { id: string; name: string; projectId: string };
  readonly manage: boolean;
}) {
  const t = await getTranslations();
  const [{ entries, grants }, users, groups] = await Promise.all([
    getDashboardAccess(tenantId, dashboard.id),
    listUsers(tenantId),
    listGroups(tenantId),
  ]);

  return (
    <Card title={t('administration.access.whoCan', { name: dashboard.name })}>
      <div className="stack">
        {entries.length === 0 ? (
          <p className="text-muted">{t('administration.access.nobody')}</p>
        ) : (
          <div className={styles.scroller}>
            <table
              className={styles.table}
              aria-label={t('administration.access.whoCan', { name: dashboard.name })}
            >
              <thead>
                <tr>
                  <th scope="col">{t('administration.users.columnName')}</th>
                  <th scope="col">{t('administration.effective.columnView')}</th>
                  <th scope="col">{t('administration.effective.columnEdit')}</th>
                  <th scope="col">{t('administration.effective.columnWhy')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.userId}>
                    <th scope="row">
                      <Link href={`/admin/users/${entry.userId}?tenant=${tenantId}`}>
                        {entry.name}
                      </Link>
                    </th>
                    <td>
                      {entry.view.granted
                        ? t('administration.effective.yes')
                        : t(
                            `administration.effective.missing.${entry.view.missing ?? 'role_and_grant'}`,
                          )}
                    </td>
                    <td>
                      {entry.edit.granted
                        ? t('administration.effective.yes')
                        : t(
                            `administration.effective.missing.${entry.edit.missing ?? 'role_and_grant'}`,
                          )}
                    </td>
                    <td>
                      {distinctReasons([
                        ...entry.view.roleReasons,
                        ...entry.edit.roleReasons,
                        ...entry.view.grantReasons,
                        ...entry.edit.grantReasons,
                      ]).map((reason, index) => (
                        <AccessChain key={index} reason={reason} />
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4>{t('administration.access.grantsOnObject')}</h4>
        {grants.length === 0 ? (
          <p className="text-muted">{t('administration.users.noGrants')}</p>
        ) : (
          <ul className={styles.list}>
            {grants.map((grant) => (
              <li key={grant.id} className={styles.listItem}>
                <span>
                  {t(`administration.subject.${grant.subjectType}`)}: {grant.subjectLabel} ·{' '}
                  {t(`administration.chain.access.${grant.access}`)}
                </span>
                {manage ? (
                  <RemoveChange
                    tenantId={tenantId}
                    change={{ kind: 'revoke', grantId: grant.id }}
                    label={t('administration.users.revokeGrant')}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {manage ? (
          <GrantToObjectForm
            tenantId={tenantId}
            object={{ type: 'dashboard', id: dashboard.id }}
            subjects={[
              ...groups.map((group) => ({
                type: 'group' as const,
                id: group.id,
                label: group.name,
              })),
              ...users.map((user) => ({ type: 'user' as const, id: user.id, label: user.name })),
            ]}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** An edit grant also explains viewing: show each chain once. */
function distinctReasons(reasons: readonly AccessReason[]): AccessReason[] {
  return [...new Map(reasons.map((reason) => [JSON.stringify(reason.chain), reason])).values()];
}
