'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ProfileField } from '@axp/contracts';
import { Button, Callout, SelectField, TextField } from '@axp/ui';
import {
  inviteUserAction,
  reactivateUserAction,
  reissueInvitationAction,
  revokeSessionsAction,
  updateUserAction,
} from '@/app/admin/actions';
import { ChangeWithPreview } from './ChangeWithPreview';

type Feedback = { tone: 'success' | 'critical'; text: string } | null;

/**
 * Profile fields, as the administrator sees them (D5: "User Detail ist eine
 * echte editierbare Seite").
 *
 * A field the identity provider owns is shown read-only with the reason next
 * to it, rather than as a greyed-out control nobody can explain.
 */
export function ProfileEditForm({
  tenantId,
  userId,
  initial,
  managed,
  save,
}: {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly initial: { firstName: string; lastName: string; email: string; locale: 'de' | 'en' };
  readonly managed: readonly ProfileField[];
  /** For the self-service page, which saves through its own action. */
  readonly save?: (changes: {
    firstName?: string;
    lastName?: string;
    locale?: 'de' | 'en';
  }) => Promise<{ status: string; message?: string }>;
}) {
  const t = useTranslations('administration.profile');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(initial);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const managedBy = t('managedByProvider');
  const isManaged = (field: ProfileField) => managed.includes(field);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const changes = {
      ...(isManaged('firstName') ? {} : { firstName: values.firstName }),
      ...(isManaged('lastName') ? {} : { lastName: values.lastName }),
      ...(isManaged('locale') ? {} : { locale: values.locale }),
    };
    startTransition(async () => {
      const outcome = save
        ? await save(changes)
        : await updateUserAction(tenantId!, userId!, changes);
      setFeedback(
        outcome.status === 'ok'
          ? { tone: 'success', text: t('saved') }
          : { tone: 'critical', text: 'message' in outcome ? (outcome.message ?? '') : '' },
      );
      if (outcome.status === 'ok') router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {feedback ? (
        <Callout tone={feedback.tone} live>
          {feedback.text}
        </Callout>
      ) : null}
      <div className="row">
        <TextField
          label={t('firstName')}
          value={values.firstName}
          onChange={(event) => setValues({ ...values, firstName: event.target.value })}
          readOnly={isManaged('firstName')}
          {...(isManaged('firstName') ? { managedByProvider: managedBy } : {})}
        />
        <TextField
          label={t('lastName')}
          value={values.lastName}
          onChange={(event) => setValues({ ...values, lastName: event.target.value })}
          readOnly={isManaged('lastName')}
          {...(isManaged('lastName') ? { managedByProvider: managedBy } : {})}
        />
      </div>
      <TextField
        label={t('email')}
        value={values.email}
        readOnly
        hint={isManaged('email') ? undefined : t('emailNotEditable')}
        {...(isManaged('email') ? { managedByProvider: managedBy } : {})}
      />
      <SelectField
        label={t('locale')}
        value={values.locale}
        options={[
          { value: 'de', label: 'Deutsch' },
          { value: 'en', label: 'English' },
        ]}
        onChange={(event) => setValues({ ...values, locale: event.target.value as 'de' | 'en' })}
      />
      <div>
        <Button type="submit" variant="primary" busy={pending} busyLabel={t('saving')}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Account status and sessions.
 *
 * Deactivation is a permission change like any other - previewed, confirmed,
 * and behind a fresh password - because it takes everything away at once.
 */
export function AccountActions({
  tenantId,
  userId,
  status,
  activeSessions,
  hasPendingInvitation,
}: {
  readonly tenantId: string;
  readonly userId: string;
  readonly status: 'invited' | 'active' | 'deactivated';
  readonly activeSessions: number;
  readonly hasPendingInvitation: boolean;
}) {
  const t = useTranslations('administration.account');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [link, setLink] = useState<string | null>(null);

  function act(
    run: () => Promise<{ status: string; message?: string; data?: unknown }>,
    done: string,
  ) {
    startTransition(async () => {
      const outcome = await run();
      if (outcome.status === 'ok') {
        setFeedback({ tone: 'success', text: done });
        router.refresh();
      } else {
        setFeedback({ tone: 'critical', text: outcome.message ?? t('failed') });
      }
    });
  }

  function reissue() {
    startTransition(async () => {
      const outcome = await reissueInvitationAction(tenantId, userId);
      if (outcome.status === 'ok' && outcome.data) {
        setLink(invitationLink(outcome.data.token));
        router.refresh();
      } else if (outcome.status === 'error') {
        setFeedback({ tone: 'critical', text: outcome.message });
      }
    });
  }

  return (
    <div className="stack">
      {feedback ? (
        <Callout tone={feedback.tone} live>
          {feedback.text}
        </Callout>
      ) : null}

      <p>{t(`status.${status}`)}</p>

      {status === 'active' ? (
        <ChangeWithPreview
          tenantId={tenantId}
          change={{ kind: 'deactivate_user', userId }}
          label={t('deactivate')}
          danger
        />
      ) : null}

      {status === 'deactivated' ? (
        <div>
          <Button
            type="button"
            onClick={() => act(() => reactivateUserAction(tenantId, userId), t('reactivated'))}
            busy={pending}
          >
            {t('reactivate')}
          </Button>
        </div>
      ) : null}

      <p className="text-secondary">{t('sessions', { count: activeSessions })}</p>
      {activeSessions > 0 ? (
        <div>
          <Button
            type="button"
            onClick={() => act(() => revokeSessionsAction(tenantId, userId), t('sessionsRevoked'))}
            busy={pending}
          >
            {t('revokeSessions')}
          </Button>
        </div>
      ) : null}

      {status === 'invited' ? (
        <div className="stack stack--tight">
          <p className="text-secondary">
            {hasPendingInvitation ? t('invitationPending') : t('invitationExpired')}
          </p>
          <div>
            <Button type="button" onClick={reissue} busy={pending}>
              {t('reissueInvitation')}
            </Button>
          </div>
          {link ? <InvitationLink link={link} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The invite form. The link is shown once, here, and never again. */
export function InviteForm({ tenantId }: { readonly tenantId: string }) {
  const t = useTranslations('administration.invite');
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState({
    email: '',
    firstName: '',
    lastName: '',
    locale: 'de' as 'de' | 'en',
  });
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ userId: string; link: string | null } | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const outcome = await inviteUserAction(tenantId, values);
      if (outcome.status === 'ok' && outcome.data) {
        setResult({
          userId: outcome.data.userId,
          link: outcome.data.invitation ? invitationLink(outcome.data.invitation.token) : null,
        });
      } else if (outcome.status === 'error') {
        setMessage(outcome.message);
        setErrors(outcome.fieldErrors ?? {});
      }
    });
  }

  if (result) {
    return (
      <div className="stack">
        <Callout tone="success" title={t('doneTitle')} live>
          {result.link ? t('doneNew') : t('doneExisting')}
        </Callout>
        {result.link ? <InvitationLink link={result.link} /> : null}
        <a href={`/admin/users/${result.userId}?tenant=${tenantId}`}>{t('openPerson')}</a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}
      <TextField
        label={t('email')}
        type="email"
        required
        autoComplete="off"
        value={values.email}
        error={errors.email}
        onChange={(event) => setValues({ ...values, email: event.target.value })}
      />
      <div className="row">
        <TextField
          label={t('firstName')}
          required
          value={values.firstName}
          onChange={(event) => setValues({ ...values, firstName: event.target.value })}
        />
        <TextField
          label={t('lastName')}
          required
          value={values.lastName}
          onChange={(event) => setValues({ ...values, lastName: event.target.value })}
        />
      </div>
      <SelectField
        label={t('locale')}
        value={values.locale}
        options={[
          { value: 'de', label: 'Deutsch' },
          { value: 'en', label: 'English' },
        ]}
        onChange={(event) => setValues({ ...values, locale: event.target.value as 'de' | 'en' })}
      />
      <p className="text-muted">{t('explain')}</p>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!values.email || !values.firstName || !values.lastName}
          busy={pending}
          busyLabel={t('sending')}
        >
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

/**
 * An invitation link, shown once. The invited person gets it by mail; this is
 * the fallback for when a mail does not arrive.
 */
export function InvitationLink({ link }: { readonly link: string }) {
  const t = useTranslations('administration.invite');
  return (
    <div className="stack stack--tight">
      <TextField label={t('linkLabel')} value={link} readOnly hint={t('linkHint')} />
    </div>
  );
}

function invitationLink(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/invite?token=${encodeURIComponent(token)}`;
}
