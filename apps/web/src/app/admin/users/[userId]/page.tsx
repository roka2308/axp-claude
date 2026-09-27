import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ScopeType } from '@axp/contracts';
import { Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import { EffectiveAccessPanel } from '@/components/admin/EffectiveAccessPanel';
import {
  GrantForm,
  JoinGroupForm,
  RemoveChange,
  RoleAssignForm,
  type ScopeOption,
} from '@/components/admin/AccessForms';
import { AccountActions, ProfileEditForm } from '@/components/admin/UserForms';
import { getAssignableRoles, getObjects, getUser, listGroups } from '@/lib/admin';
import styles from '../../admin.module.css';

interface PageProps {
  readonly params: Promise<{ readonly userId: string }>;
  readonly searchParams: Promise<{ readonly tenant?: string }>;
}

/**
 * One person (D5, Gate F5).
 *
 * The page opens with the answer the gate asks for - what this person can do,
 * where, and why - and then shows each thing that produces it, editable in
 * place: profile, account, groups, roles, grants. Every permission change is
 * previewed before it is made.
 */
export default async function UserPage({ params, searchParams }: PageProps) {
  const { userId } = await params;
  const { tenant: requested } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="users" requestedTenant={requested}>
      {async ({ tenant }) => {
        if (!tenant) return null;
        const [view, objects, groups] = await Promise.all([
          getUser(tenant.id, userId),
          getObjects(tenant.id),
          listGroups(tenant.id),
        ]);
        const { user, roles, grants, effective } = view;
        const name = `${user.firstName} ${user.lastName}`.trim();
        const manageAccess = tenant.capabilities.includes('tenant.role_assignment.manage');
        const manageGroups = tenant.capabilities.includes('tenant.group.manage');
        const manageUsers = tenant.capabilities.includes('tenant.user.deactivate');
        const editProfile = tenant.capabilities.includes('tenant.user.invite');

        const scopeTargets: { type: ScopeType; id: string; label: string }[] = [
          { type: 'tenant', id: tenant.id, label: tenant.name },
          ...objects.projects.map((project) => ({
            type: 'project' as const,
            id: project.id,
            label: project.name,
          })),
        ];
        const scopes: ScopeOption[] = manageAccess
          ? await Promise.all(
              scopeTargets.map(async (scope) => ({
                ...scope,
                roles: await getAssignableRoles(tenant.id, scope.type, scope.id),
              })),
            )
          : [];

        const memberOf = new Set(user.groups.map((group) => group.id));

        return (
          <div className="stack stack--loose">
            <header className="stack stack--tight">
              <Link href={`/admin/users?tenant=${tenant.id}`}>
                {t('administration.users.back')}
              </Link>
              <h2>{name}</h2>
              <p className="text-secondary">
                {user.email} · {t(`administration.status.${user.status}`)} ·{' '}
                {t(`administration.provider.${user.provider}`)}
              </p>
            </header>

            <Card
              title={t('administration.effective.title')}
              description={t('administration.effective.body')}
            >
              <EffectiveAccessPanel access={effective} subjectName={name} />
            </Card>

            <div className={styles.grid}>
              <Card title={t('administration.users.profile')}>
                {editProfile ? (
                  <ProfileEditForm
                    tenantId={tenant.id}
                    userId={user.id}
                    initial={{
                      firstName: user.firstName,
                      lastName: user.lastName,
                      email: user.email,
                      locale: user.locale,
                    }}
                    managed={user.managedAttributes}
                  />
                ) : (
                  <p>{name}</p>
                )}
              </Card>

              <Card title={t('administration.users.account')}>
                {manageUsers ? (
                  <AccountActions
                    tenantId={tenant.id}
                    userId={user.id}
                    status={user.status}
                    activeSessions={user.activeSessions}
                    hasPendingInvitation={user.pendingInvitation !== null}
                  />
                ) : (
                  <p>{t(`administration.status.${user.status}`)}</p>
                )}
              </Card>
            </div>

            <Card
              title={t('administration.users.groups')}
              description={t('administration.users.groupsBody')}
            >
              <div className="stack">
                {user.groups.length === 0 ? (
                  <p className="text-muted">{t('administration.users.noGroups')}</p>
                ) : (
                  <ul className={styles.list}>
                    {user.groups.map((group) => (
                      <li key={group.id} className={styles.listItem}>
                        <Link href={`/admin/groups/${group.id}?tenant=${tenant.id}`}>
                          {group.name}
                        </Link>
                        {manageGroups ? (
                          <RemoveChange
                            tenantId={tenant.id}
                            change={{ kind: 'remove_member', groupId: group.id, userId: user.id }}
                            label={t('administration.users.leaveGroup')}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {manageGroups ? (
                  <JoinGroupForm
                    tenantId={tenant.id}
                    userId={user.id}
                    groups={groups
                      .filter((group) => !memberOf.has(group.id))
                      .map((group) => ({ id: group.id, label: group.name }))}
                  />
                ) : null}
              </div>
            </Card>

            <Card
              title={t('administration.users.roles')}
              description={t('administration.users.rolesBody')}
            >
              <div className="stack">
                {roles.length === 0 ? (
                  <p className="text-muted">{t('administration.users.noRoles')}</p>
                ) : (
                  <ul className={styles.list}>
                    {roles.map((assignment) => (
                      <li key={assignment.id} className={styles.listItem}>
                        <span>
                          <strong>{t(`roles.${assignment.role}.label`)}</strong> ·{' '}
                          {t(`administration.scopeLabel.${assignment.scopeType}`, {
                            name: assignment.scopeLabel,
                          })}
                          <span className={styles.muted}>
                            {assignment.viaGroup
                              ? t('administration.users.viaGroup', {
                                  name: assignment.viaGroup.name,
                                })
                              : t('administration.users.direct')}
                          </span>
                        </span>
                        {manageAccess && !assignment.viaGroup ? (
                          <RemoveChange
                            tenantId={tenant.id}
                            change={{ kind: 'remove_role', assignmentId: assignment.id }}
                            label={t('administration.users.removeRole')}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {manageAccess ? (
                  <RoleAssignForm
                    tenantId={tenant.id}
                    subject={{ type: 'user', id: user.id }}
                    scopes={scopes}
                  />
                ) : null}
              </div>
            </Card>

            <Card
              title={t('administration.users.grants')}
              description={t('administration.users.grantsBody')}
            >
              <div className="stack">
                {grants.length === 0 ? (
                  <p className="text-muted">{t('administration.users.noGrants')}</p>
                ) : (
                  <ul className={styles.list}>
                    {grants.map((grant) => (
                      <li key={grant.id} className={styles.listItem}>
                        <span>
                          {t(`administration.forms.objectOption.${grant.objectType}`, {
                            name: grant.objectLabel,
                          })}{' '}
                          · {t(`administration.chain.access.${grant.access}`)}
                          <span className={styles.muted}>
                            {grant.subjectType === 'group'
                              ? t('administration.users.viaGroup', { name: grant.subjectLabel })
                              : t('administration.users.direct')}
                          </span>
                        </span>
                        {manageAccess && grant.subjectType === 'user' ? (
                          <RemoveChange
                            tenantId={tenant.id}
                            change={{ kind: 'revoke', grantId: grant.id }}
                            label={t('administration.users.revokeGrant')}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {manageAccess ? (
                  <GrantForm
                    tenantId={tenant.id}
                    subject={{ type: 'user', id: user.id }}
                    objects={[
                      ...objects.projects.map((project) => ({
                        type: 'project' as const,
                        id: project.id,
                        label: project.name,
                      })),
                      ...objects.dashboards.map((dashboard) => ({
                        type: 'dashboard' as const,
                        id: dashboard.id,
                        label: `${dashboard.name} (${dashboard.projectName})`,
                      })),
                    ]}
                  />
                ) : null}
              </div>
            </Card>
          </div>
        );
      }}
    </AdminFrame>
  );
}
