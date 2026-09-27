'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  AccessChange,
  ObjectAccess,
  ObjectType,
  ScopeType,
  SubjectType,
  SystemRole,
} from '@axp/contracts';
import { SelectField } from '@axp/ui';
import { ChangeWithPreview } from './ChangeWithPreview';

/**
 * The forms that build a permission change (D5).
 *
 * Each only assembles an `AccessChange`; checking it, confirming it and - when
 * needed - re-authenticating is `ChangeWithPreview`'s job, so every change in
 * the product goes through the same three steps.
 */

export interface ScopeOption {
  readonly type: ScopeType;
  readonly id: string;
  readonly label: string;
  /** What the current administrator may hand out here - and nothing else. */
  readonly roles: readonly SystemRole[];
}

export function RoleAssignForm({
  tenantId,
  subject,
  scopes,
}: {
  readonly tenantId: string;
  readonly subject: { readonly type: SubjectType; readonly id: string };
  readonly scopes: readonly ScopeOption[];
}) {
  const t = useTranslations('administration.forms');
  const tRoles = useTranslations('roles');
  const usable = scopes.filter((scope) => scope.roles.length > 0);

  const [scopeKey, setScopeKey] = useState(usable[0] ? keyOf(usable[0]) : '');
  const scope = usable.find((candidate) => keyOf(candidate) === scopeKey);
  const [role, setRole] = useState<SystemRole | ''>(scope?.roles[0] ?? '');

  if (usable.length === 0) return <p className="text-muted">{t('nothingAssignable')}</p>;

  const change: AccessChange | null =
    scope && role && scope.roles.includes(role)
      ? {
          kind: 'assign_role',
          subjectType: subject.type,
          subjectId: subject.id,
          role,
          scopeType: scope.type,
          scopeId: scope.id,
        }
      : null;

  return (
    <div className="stack">
      <div className="row">
        <SelectField
          label={t('scope')}
          value={scopeKey}
          options={usable.map((candidate) => ({
            value: keyOf(candidate),
            label: t(`scopeOption.${candidate.type}`, { name: candidate.label }),
          }))}
          onChange={(event) => {
            setScopeKey(event.target.value);
            const next = usable.find((candidate) => keyOf(candidate) === event.target.value);
            setRole(next?.roles[0] ?? '');
          }}
        />
        <SelectField
          label={t('role')}
          value={role}
          options={(scope?.roles ?? []).map((candidate) => ({
            value: candidate,
            label: tRoles(`${candidate}.label`),
          }))}
          onChange={(event) => setRole(event.target.value as SystemRole)}
        />
      </div>
      {role ? <p className="text-muted">{tRoles(`${role}.purpose`)}</p> : null}
      <ChangeWithPreview tenantId={tenantId} change={change} label={t('assignRole')} />
    </div>
  );
}

export interface ObjectOption {
  readonly type: ObjectType;
  readonly id: string;
  readonly label: string;
}

/** Grants one subject access to an object it picks. */
export function GrantForm({
  tenantId,
  subject,
  objects,
}: {
  readonly tenantId: string;
  readonly subject: { readonly type: SubjectType; readonly id: string };
  readonly objects: readonly ObjectOption[];
}) {
  const t = useTranslations('administration.forms');
  const [objectKey, setObjectKey] = useState(
    objects[0] ? `${objects[0].type}:${objects[0].id}` : '',
  );
  const [access, setAccess] = useState<ObjectAccess>('view');
  const object = objects.find((candidate) => `${candidate.type}:${candidate.id}` === objectKey);

  if (objects.length === 0) return <p className="text-muted">{t('noObjects')}</p>;

  const change: AccessChange | null = object
    ? {
        kind: 'grant',
        subjectType: subject.type,
        subjectId: subject.id,
        objectType: object.type,
        objectId: object.id,
        access,
      }
    : null;

  return (
    <div className="stack">
      <div className="row">
        <SelectField
          label={t('object')}
          value={objectKey}
          options={objects.map((candidate) => ({
            value: `${candidate.type}:${candidate.id}`,
            label: t(`objectOption.${candidate.type}`, { name: candidate.label }),
          }))}
          onChange={(event) => setObjectKey(event.target.value)}
        />
        <AccessSelect value={access} onChange={setAccess} />
      </div>
      <ChangeWithPreview tenantId={tenantId} change={change} label={t('grant')} />
    </div>
  );
}

export interface SubjectOption {
  readonly type: SubjectType;
  readonly id: string;
  readonly label: string;
}

/** Grants access to one object, choosing who gets it. */
export function GrantToObjectForm({
  tenantId,
  object,
  subjects,
}: {
  readonly tenantId: string;
  readonly object: { readonly type: ObjectType; readonly id: string };
  readonly subjects: readonly SubjectOption[];
}) {
  const t = useTranslations('administration.forms');
  const [subjectKey, setSubjectKey] = useState(
    subjects[0] ? `${subjects[0].type}:${subjects[0].id}` : '',
  );
  const [access, setAccess] = useState<ObjectAccess>('view');
  const subject = subjects.find((candidate) => `${candidate.type}:${candidate.id}` === subjectKey);

  const change: AccessChange | null = subject
    ? {
        kind: 'grant',
        subjectType: subject.type,
        subjectId: subject.id,
        objectType: object.type,
        objectId: object.id,
        access,
      }
    : null;

  return (
    <div className="stack">
      <div className="row">
        <SelectField
          label={t('subject')}
          value={subjectKey}
          options={subjects.map((candidate) => ({
            value: `${candidate.type}:${candidate.id}`,
            label: t(`subjectOption.${candidate.type}`, { name: candidate.label }),
          }))}
          onChange={(event) => setSubjectKey(event.target.value)}
        />
        <AccessSelect value={access} onChange={setAccess} />
      </div>
      <ChangeWithPreview tenantId={tenantId} change={change} label={t('grant')} />
    </div>
  );
}

export function MemberForm({
  tenantId,
  groupId,
  candidates,
}: {
  readonly tenantId: string;
  readonly groupId: string;
  readonly candidates: readonly { readonly id: string; readonly label: string }[];
}) {
  const t = useTranslations('administration.forms');
  const [userId, setUserId] = useState(candidates[0]?.id ?? '');

  if (candidates.length === 0) return <p className="text-muted">{t('everyoneIsMember')}</p>;

  return (
    <div className="stack">
      <SelectField
        label={t('person')}
        value={userId}
        options={candidates.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
        onChange={(event) => setUserId(event.target.value)}
      />
      <ChangeWithPreview
        tenantId={tenantId}
        change={userId ? { kind: 'add_member', groupId, userId } : null}
        label={t('addMember')}
      />
    </div>
  );
}

/** Puts one person into a group they pick. */
export function JoinGroupForm({
  tenantId,
  userId,
  groups,
}: {
  readonly tenantId: string;
  readonly userId: string;
  readonly groups: readonly { readonly id: string; readonly label: string }[];
}) {
  const t = useTranslations('administration.forms');
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');

  if (groups.length === 0) return <p className="text-muted">{t('noMoreGroups')}</p>;

  return (
    <div className="stack">
      <SelectField
        label={t('group')}
        value={groupId}
        options={groups.map((group) => ({ value: group.id, label: group.label }))}
        onChange={(event) => setGroupId(event.target.value)}
      />
      <ChangeWithPreview
        tenantId={tenantId}
        change={groupId ? { kind: 'add_member', groupId, userId } : null}
        label={t('addToGroup')}
      />
    </div>
  );
}

/** A single removal, previewed and confirmed like any other change. */
export function RemoveChange({
  tenantId,
  change,
  label,
}: {
  readonly tenantId: string;
  readonly change: AccessChange;
  readonly label: string;
}) {
  return <ChangeWithPreview tenantId={tenantId} change={change} label={label} danger />;
}

function AccessSelect({
  value,
  onChange,
}: {
  readonly value: ObjectAccess;
  readonly onChange: (value: ObjectAccess) => void;
}) {
  const t = useTranslations('administration.forms');
  return (
    <SelectField
      label={t('access')}
      value={value}
      options={[
        { value: 'view', label: t('accessView') },
        { value: 'edit', label: t('accessEdit') },
      ]}
      onChange={(event) => onChange(event.target.value as ObjectAccess)}
    />
  );
}

function keyOf(scope: { type: string; id: string }): string {
  return `${scope.type}:${scope.id}`;
}
