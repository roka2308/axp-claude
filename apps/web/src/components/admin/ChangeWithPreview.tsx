'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { AccessChange, ImpactPreview } from '@axp/contracts';
import { Button, Callout, TextField } from '@axp/ui';
import {
  addMemberAction,
  assignRoleAction,
  deactivateUserAction,
  deleteGroupAction,
  grantAction,
  previewChangeAction,
  reauthenticateAction,
  removeMemberAction,
  removeRoleAction,
  revokeGrantAction,
} from '@/app/admin/actions';
import type { AdminOutcome } from '@/app/admin/outcome';
import { ImpactPreviewPanel } from './ImpactPreviewPanel';
import styles from './ChangeWithPreview.module.css';

export interface ChangeWithPreviewProps {
  readonly tenantId: string;
  /** The change, or null while the form that builds it is incomplete. */
  readonly change: AccessChange | null;
  readonly label: string;
  readonly danger?: boolean;
  /** Called after the change has been applied. */
  readonly onDone?: () => void;
}

/**
 * The one way a permission changes (D5).
 *
 * Every change goes through the same three steps: see what it would do, confirm
 * it, and - when it is sensitive - confirm the password again. The preview is
 * computed by the same engine that answers Effective Access afterwards, so
 * what is shown here is what will be true.
 */
export function ChangeWithPreview({
  tenantId,
  change,
  label,
  danger = false,
  onDone,
}: ChangeWithPreviewProps) {
  const t = useTranslations('administration.change');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [preview, setPreview] = useState<ImpactPreview | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ tone: 'critical' | 'success'; text: string } | null>(
    null,
  );

  function reset() {
    setPreview(null);
    setNeedsPassword(false);
    setPassword('');
  }

  function check() {
    if (!change) return;
    setMessage(null);
    startTransition(async () => {
      const outcome = await previewChangeAction(tenantId, change);
      if (outcome.status === 'ok' && outcome.data) setPreview(outcome.data);
      else if (outcome.status === 'error') setMessage({ tone: 'critical', text: outcome.message });
    });
  }

  function apply() {
    if (!change) return;
    startTransition(async () => {
      const outcome = await applyChange(tenantId, change);
      handle(outcome);
    });
  }

  function confirmPassword() {
    if (!change) return;
    startTransition(async () => {
      const reauth = await reauthenticateAction(password);
      if (reauth.status !== 'ok') {
        setMessage({
          tone: 'critical',
          text: reauth.status === 'error' ? reauth.message : t('reauthFailed'),
        });
        return;
      }
      setPassword('');
      handle(await applyChange(tenantId, change));
    });
  }

  function handle(outcome: AdminOutcome<unknown>) {
    if (outcome.status === 'reauth') {
      setNeedsPassword(true);
      setMessage(null);
      return;
    }
    if (outcome.status === 'error') {
      setMessage({ tone: 'critical', text: outcome.message });
      return;
    }
    reset();
    setMessage({ tone: 'success', text: t('applied') });
    onDone?.();
    router.refresh();
  }

  return (
    <div className={styles.flow}>
      {message ? (
        <Callout tone={message.tone} live>
          {message.text}
        </Callout>
      ) : null}

      {!preview ? (
        <div>
          <Button
            type="button"
            variant={danger ? 'danger' : 'secondary'}
            onClick={check}
            disabled={!change || pending}
            busy={pending}
            busyLabel={t('checking')}
          >
            {t('checkImpact', { action: label })}
          </Button>
        </div>
      ) : (
        <div className="stack">
          <ImpactPreviewPanel preview={preview} />

          {needsPassword ? (
            <div className={styles.reauth}>
              <p>{t('reauthExplain')}</p>
              <TextField
                label={t('password')}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <div className="row">
                <Button
                  type="button"
                  variant="primary"
                  onClick={confirmPassword}
                  disabled={!password || pending}
                  busy={pending}
                  busyLabel={t('applying')}
                >
                  {t('confirmWithPassword')}
                </Button>
                <Button type="button" variant="ghost" onClick={reset}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="row">
              <Button
                type="button"
                variant={danger ? 'danger' : 'primary'}
                onClick={apply}
                disabled={pending}
                busy={pending}
                busyLabel={t('applying')}
              >
                {t('confirm', { action: label })}
              </Button>
              <Button type="button" variant="ghost" onClick={reset}>
                {t('cancel')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Maps a described change onto the action that performs it. */
function applyChange(tenantId: string, change: AccessChange): Promise<AdminOutcome<unknown>> {
  switch (change.kind) {
    case 'assign_role':
      return assignRoleAction(tenantId, {
        subjectType: change.subjectType,
        subjectId: change.subjectId,
        role: change.role,
        scopeType: change.scopeType,
        scopeId: change.scopeId,
      });
    case 'remove_role':
      return removeRoleAction(tenantId, change.assignmentId);
    case 'add_member':
      return addMemberAction(tenantId, change.groupId, change.userId);
    case 'remove_member':
      return removeMemberAction(tenantId, change.groupId, change.userId);
    case 'grant':
      return grantAction(tenantId, {
        subjectType: change.subjectType,
        subjectId: change.subjectId,
        objectType: change.objectType,
        objectId: change.objectId,
        access: change.access,
      });
    case 'revoke':
      return revokeGrantAction(tenantId, change.grantId);
    case 'delete_group':
      return deleteGroupAction(tenantId, change.groupId);
    case 'deactivate_user':
      return deactivateUserAction(tenantId, change.userId);
  }
}
