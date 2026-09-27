'use server';

import { revalidatePath } from 'next/cache';
import type {
  AccessChange,
  ImpactPreview,
  ObjectAccess,
  ObjectType,
  ScopeType,
  SubjectType,
  SystemRole,
  TenantLifecycle,
} from '@axp/contracts';
import { apiRequest, ApiError } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import { clearSessionCookie } from '@/lib/session';
import type { AdminOutcome } from './outcome';

/**
 * Administration writes (D5).
 *
 * Each one is a single API call; the API authorizes it. A refusal because the
 * password has to be confirmed first comes back as `reauth`, so the page can
 * ask for it and try again rather than showing an error.
 */

const tenantPath = (tenantId: string) => `/admin/tenants/${encodeURIComponent(tenantId)}`;

async function run<T>(call: () => Promise<T>): Promise<AdminOutcome<T>> {
  try {
    const data = await call();
    revalidatePath('/admin', 'layout');
    return { status: 'ok', data };
  } catch (error) {
    if (error instanceof ApiError && error.body.code === 'reauthentication_required') {
      return { status: 'reauth' };
    }
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      ...(resolved.fieldErrors ? { fieldErrors: resolved.fieldErrors } : {}),
    };
  }
}

const send = <T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  apiRequest<T>(path, { method, ...(body === undefined ? {} : { body }), authenticated: true });

// --- re-authentication ---------------------------------------------------------

export async function reauthenticateAction(password: string): Promise<AdminOutcome> {
  return run(() => send('/auth/reauthenticate', 'POST', { password }));
}

// --- preview -------------------------------------------------------------------

export async function previewChangeAction(
  tenantId: string,
  change: AccessChange,
): Promise<AdminOutcome<ImpactPreview>> {
  try {
    const data = await send<ImpactPreview>(`${tenantPath(tenantId)}/impact-preview`, 'POST', {
      change,
    });
    return { status: 'ok', data };
  } catch (error) {
    const resolved = await resolveError(error);
    return { status: 'error', message: resolved.message };
  }
}

// --- users -----------------------------------------------------------------------

export async function inviteUserAction(
  tenantId: string,
  input: { email: string; firstName: string; lastName: string; locale: 'de' | 'en' },
): Promise<
  AdminOutcome<{ userId: string; invitation: { token: string; expiresAt: string } | null }>
> {
  return run(() => send(`${tenantPath(tenantId)}/users`, 'POST', input));
}

export async function updateUserAction(
  tenantId: string,
  userId: string,
  changes: { firstName?: string; lastName?: string; locale?: 'de' | 'en' },
): Promise<AdminOutcome> {
  return run(() => send(`${tenantPath(tenantId)}/users/${userId}`, 'PATCH', changes));
}

export async function deactivateUserAction(tenantId: string, userId: string) {
  return run(() =>
    send<{ revokedSessions: number }>(
      `${tenantPath(tenantId)}/users/${userId}/deactivate`,
      'POST',
      {},
    ),
  );
}

export async function reactivateUserAction(tenantId: string, userId: string) {
  return run(() => send(`${tenantPath(tenantId)}/users/${userId}/reactivate`, 'POST', {}));
}

export async function revokeSessionsAction(tenantId: string, userId: string) {
  return run(() =>
    send<{ revokedSessions: number }>(
      `${tenantPath(tenantId)}/users/${userId}/revoke-sessions`,
      'POST',
      {},
    ),
  );
}

export async function reissueInvitationAction(tenantId: string, userId: string) {
  return run(() =>
    send<{ token: string; expiresAt: string }>(
      `${tenantPath(tenantId)}/users/${userId}/invitation`,
      'POST',
      {},
    ),
  );
}

// --- groups ----------------------------------------------------------------------

export async function createGroupAction(
  tenantId: string,
  input: { name: string; description?: string },
) {
  return run(() => send<{ groupId: string }>(`${tenantPath(tenantId)}/groups`, 'POST', input));
}

export async function deleteGroupAction(tenantId: string, groupId: string) {
  return run(() => send(`${tenantPath(tenantId)}/groups/${groupId}`, 'DELETE'));
}

export async function addMemberAction(tenantId: string, groupId: string, userId: string) {
  return run(() => send(`${tenantPath(tenantId)}/groups/${groupId}/members`, 'POST', { userId }));
}

export async function removeMemberAction(tenantId: string, groupId: string, userId: string) {
  return run(() => send(`${tenantPath(tenantId)}/groups/${groupId}/members/${userId}`, 'DELETE'));
}

// --- roles and grants -------------------------------------------------------------

export async function assignRoleAction(
  tenantId: string,
  input: {
    subjectType: SubjectType;
    subjectId: string;
    role: SystemRole;
    scopeType: ScopeType;
    scopeId: string;
  },
) {
  return run(() =>
    send<{ assignmentId: string }>(`${tenantPath(tenantId)}/role-assignments`, 'POST', input),
  );
}

export async function removeRoleAction(tenantId: string, assignmentId: string) {
  return run(() => send(`${tenantPath(tenantId)}/role-assignments/${assignmentId}`, 'DELETE'));
}

export async function grantAction(
  tenantId: string,
  input: {
    subjectType: SubjectType;
    subjectId: string;
    objectType: ObjectType;
    objectId: string;
    access: ObjectAccess;
  },
) {
  return run(() => send<{ grantId: string }>(`${tenantPath(tenantId)}/grants`, 'POST', input));
}

export async function revokeGrantAction(tenantId: string, grantId: string) {
  return run(() => send(`${tenantPath(tenantId)}/grants/${grantId}`, 'DELETE'));
}

// --- tenants ----------------------------------------------------------------------

export async function createTenantAction(input: {
  name: string;
  slug: string;
  defaultLocale: 'de' | 'en';
  admin: { email: string; firstName: string; lastName: string };
  firstProject?: { name: string; slug: string };
}) {
  return run(() =>
    send<{
      tenantId: string;
      adminUserId: string;
      invitation: { token: string; expiresAt: string } | null;
      projectId: string | null;
    }>('/admin/platform/tenants', 'POST', input),
  );
}

export async function changeLifecycleAction(
  tenantId: string,
  to: TenantLifecycle,
  confirmation: string,
) {
  return run(() =>
    send(`/admin/platform/tenants/${encodeURIComponent(tenantId)}/lifecycle`, 'POST', {
      to,
      confirmation,
    }),
  );
}

// --- self service -----------------------------------------------------------------

export async function updateMyProfileAction(changes: {
  firstName?: string;
  lastName?: string;
  locale?: 'de' | 'en';
}): Promise<AdminOutcome> {
  const outcome = await run(async () => {
    await send('/me/profile', 'PATCH', changes);
  });
  revalidatePath('/profile');
  return outcome;
}

/** Changes the password and ends every session, this one included. */
export async function changeMyPasswordAction(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<AdminOutcome> {
  const outcome = await run(async () => {
    await send('/me/password', 'POST', input);
  });
  if (outcome.status === 'ok') await clearSessionCookie();
  return outcome;
}

export async function acceptInvitationAction(input: {
  token: string;
  password: string;
}): Promise<AdminOutcome<{ email: string }>> {
  try {
    const data = await apiRequest<{ email: string }>('/invitations/accept', {
      method: 'POST',
      body: input,
    });
    return { status: 'ok', data };
  } catch (error) {
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      ...(resolved.fieldErrors ? { fieldErrors: resolved.fieldErrors } : {}),
    };
  }
}
