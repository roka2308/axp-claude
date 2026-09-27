import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ScopeType } from '@axp/contracts';
import { Card } from '@axp/ui';
import { AdminFrame } from '@/components/admin/AdminFrame';
import {
  GrantForm,
  MemberForm,
  RemoveChange,
  RoleAssignForm,
  type ScopeOption,
} from '@/components/admin/AccessForms';
import { ChangeWithPreview } from '@/components/admin/ChangeWithPreview';
import { getAssignableRoles, getGroup, getObjects, listUsers } from '@/lib/admin';
import styles from '../../admin.module.css';

interface PageProps {
  readonly params: Promise<{ readonly groupId: string }>;
  readonly searchParams: Promise<{ readonly tenant?: string }>;
}

/**
 * One group: who is in it, and what membership gives them.
 *
 * Whatever the group holds, every member holds through it - which is why each
 * change here is previewed for every member it reaches.
 */
export default async function GroupPage({ params, searchParams }: PageProps) {
  const { groupId } = await params;
  const { tenant: requested } = await searchParams;
  const t = await getTranslations();

  return (
    <AdminFrame section="groups" requestedTenant={requested}>
      {async ({ tenant }) => {
        if (!tenant) return null;
        const [{ group, roles, grants }, objects, users] = await Promise.all([
          getGroup(tenant.id, groupId),
          getObjects(tenant.id),
          listUsers(tenant.id),
        ]);
        const manageGroups = tenant.capabilities.includes('tenant.group.manage');
        const manageAccess = tenant.capabilities.includes('tenant.role_assignment.manage');
        const members = new Set(group.members.map((member) => member.userId));

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

        return (
          <div className="stack stack--loose">
            <header className="stack stack--tight">
              <Link href={`/admin/groups?tenant=${tenant.id}`}>
                {t('administration.groups.back')}
              </Link>
              <h2>{group.name}</h2>
              {group.description ? <p className="text-secondary">{group.description}</p> : null}
            </header>

            <Card title={t('administration.groups.membersTitle')}>
              <div className="stack">
                {group.members.length === 0 ? (
                  <p className="text-muted">{t('administration.groups.noMembers')}</p>
                ) : (
                  <ul className={styles.list}>
                    {group.members.map((member) => (
                      <li key={member.userId} className={styles.listItem}>
                        <span>
                          <Link href={`/admin/users/${member.userId}?tenant=${tenant.id}`}>
                            {member.name}
                          </Link>
                          <span className={styles.muted}>
                            {member.email} · {t(`administration.status.${member.status}`)}
                          </span>
                        </span>
                        {manageGroups ? (
                          <RemoveChange
                            tenantId={tenant.id}
                            change={{
                              kind: 'remove_member',
                              groupId: group.id,
                              userId: member.userId,
                            }}
                            label={t('administration.groups.removeMember')}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {manageGroups ? (
                  <MemberForm
                    tenantId={tenant.id}
                    groupId={group.id}
                    candidates={users
                      .filter((user) => !members.has(user.id))
                      .map((user) => ({ id: user.id, label: `${user.name} (${user.email})` }))}
                  />
                ) : null}
              </div>
            </Card>

            <Card
              title={t('administration.users.roles')}
              description={t('administration.groups.rolesBody')}
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
                        </span>
                        {manageAccess ? (
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
                    subject={{ type: 'group', id: group.id }}
                    scopes={scopes}
                  />
                ) : null}
              </div>
            </Card>

            <Card
              title={t('administration.users.grants')}
              description={t('administration.groups.grantsBody')}
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
                        </span>
                        {manageAccess ? (
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
                    subject={{ type: 'group', id: group.id }}
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

            {manageGroups ? (
              <Card
                title={t('administration.groups.deleteTitle')}
                description={t('administration.groups.deleteBody')}
              >
                <ChangeWithPreview
                  tenantId={tenant.id}
                  change={{ kind: 'delete_group', groupId: group.id }}
                  label={t('administration.groups.delete')}
                  danger
                />
              </Card>
            ) : null}
          </div>
        );
      }}
    </AdminFrame>
  );
}
