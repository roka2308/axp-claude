'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import type { TenantLifecycle } from '@axp/contracts';
import { Button, Callout, SelectField, TextField } from '@axp/ui';
import {
  changeLifecycleAction,
  createTenantAction,
  reauthenticateAction,
} from '@/app/admin/actions';
import { InvitationLink } from './UserForms';
import styles from './TenantForms.module.css';

/** The API names a nested field by its path, joined with dots. */
const ADMIN_EMAIL_FIELD = ['admin', 'email'].join('.');

const STEPS = ['customer', 'admin', 'project', 'review'] as const;
type Step = (typeof STEPS)[number];

const GERMAN: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Lower-case letters, digits and single hyphens - what a typed slug may contain. */
const slugChars = (value: string) =>
  value
    .toLowerCase()
    .replace(/[äöüß]/g, (letter) => GERMAN[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 100);

/** A slug derived from a name: as above, without leading or trailing hyphens. */
const slugify = (value: string) => slugChars(value).replace(/^-+|-+$/g, '');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * "Tenant anlegen" as a guided wizard (D5): customer, first administrator,
 * optional first project, then a review of everything before anything is
 * created. Nothing is written until the last step, so leaving half-way leaves
 * nothing behind.
 */
export function CreateTenantWizard() {
  const t = useTranslations('administration.tenants.wizard');
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>('customer');
  const [slugTouched, setSlugTouched] = useState(false);
  const [projectSlugTouched, setProjectSlugTouched] = useState(false);
  const [values, setValues] = useState({
    name: '',
    slug: '',
    defaultLocale: 'de' as 'de' | 'en',
    adminEmail: '',
    adminFirstName: '',
    adminLastName: '',
    withProject: true,
    projectName: '',
    projectSlug: '',
  });
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [result, setResult] = useState<{ tenantId: string; link: string | null } | null>(null);

  const index = STEPS.indexOf(step);

  // Moving between steps replaces the form under the pointer; focus follows
  // to the new step's heading, so keyboard and screen-reader users land there.
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);
  const set = (patch: Partial<typeof values>) => setValues({ ...values, ...patch });

  const complete: Record<Step, boolean> = {
    customer: values.name.trim().length >= 2 && values.slug.length >= 2 && SLUG.test(values.slug),
    admin: Boolean(values.adminEmail && values.adminFirstName && values.adminLastName),
    project:
      !values.withProject ||
      (values.projectName.trim().length >= 2 &&
        values.projectSlug.length >= 2 &&
        SLUG.test(values.projectSlug)),
    review: true,
  };

  function next(event: React.FormEvent) {
    event.preventDefault();
    if (!complete[step]) return;
    if (step !== 'review') {
      setStep(STEPS[index + 1]!);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const outcome = await createTenantAction({
        name: values.name.trim(),
        slug: values.slug,
        defaultLocale: values.defaultLocale,
        admin: {
          email: values.adminEmail.trim(),
          firstName: values.adminFirstName.trim(),
          lastName: values.adminLastName.trim(),
        },
        ...(values.withProject
          ? { firstProject: { name: values.projectName.trim(), slug: values.projectSlug } }
          : {}),
      });
      if (outcome.status === 'ok' && outcome.data) {
        const origin = window.location.origin;
        setResult({
          tenantId: outcome.data.tenantId,
          link: outcome.data.invitation
            ? `${origin}/invite?token=${encodeURIComponent(outcome.data.invitation.token)}`
            : null,
        });
      } else if (outcome.status === 'error') {
        setMessage(outcome.message);
        setErrors(outcome.fieldErrors ?? {});
        if (outcome.fieldErrors?.slug) setStep('customer');
        else if (outcome.fieldErrors?.[ADMIN_EMAIL_FIELD]) setStep('admin');
      }
    });
  }

  if (result) {
    return (
      <div className="stack">
        <Callout tone="success" title={t('doneTitle')} live>
          {result.link ? t('doneWithInvitation') : t('doneExistingAdmin')}
        </Callout>
        <p>{t('doneProvisioning')}</p>
        {result.link ? <InvitationLink link={result.link} /> : null}
        <a href={`/admin/tenants/${result.tenantId}`}>{t('openTenant')}</a>
      </div>
    );
  }

  return (
    <form onSubmit={next} className="stack" noValidate>
      <ol className={styles.steps} aria-label={t('progress')}>
        {STEPS.map((entry, position) => (
          <li
            key={entry}
            className={styles.step}
            aria-current={entry === step ? 'step' : undefined}
            data-done={position < index ? 'true' : undefined}
          >
            <span className={styles.stepNumber}>{position + 1}</span>
            {t(`step.${entry}`)}
          </li>
        ))}
      </ol>

      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}

      <h3 ref={heading} tabIndex={-1} className={styles.stepTitle}>
        {t(`step.${step}`)}
      </h3>

      {step === 'customer' ? (
        <div className="stack">
          <TextField
            label={t('name')}
            required
            value={values.name}
            onChange={(event) =>
              set({
                name: event.target.value,
                ...(slugTouched ? {} : { slug: slugify(event.target.value) }),
              })
            }
          />
          <TextField
            label={t('slug')}
            required
            hint={t('slugHint')}
            value={values.slug}
            error={errors.slug}
            onChange={(event) => {
              setSlugTouched(true);
              set({ slug: slugChars(event.target.value) });
            }}
          />
          <SelectField
            label={t('locale')}
            value={values.defaultLocale}
            options={[
              { value: 'de', label: 'Deutsch' },
              { value: 'en', label: 'English' },
            ]}
            onChange={(event) => set({ defaultLocale: event.target.value as 'de' | 'en' })}
          />
        </div>
      ) : null}

      {step === 'admin' ? (
        <div className="stack">
          <p className="text-secondary">{t('adminExplain')}</p>
          <TextField
            label={t('adminEmail')}
            type="email"
            required
            autoComplete="off"
            value={values.adminEmail}
            error={errors[ADMIN_EMAIL_FIELD]}
            onChange={(event) => set({ adminEmail: event.target.value })}
          />
          <div className="row">
            <TextField
              label={t('adminFirstName')}
              required
              value={values.adminFirstName}
              onChange={(event) => set({ adminFirstName: event.target.value })}
            />
            <TextField
              label={t('adminLastName')}
              required
              value={values.adminLastName}
              onChange={(event) => set({ adminLastName: event.target.value })}
            />
          </div>
        </div>
      ) : null}

      {step === 'project' ? (
        <div className="stack">
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={values.withProject}
              onChange={(event) => set({ withProject: event.target.checked })}
            />
            {t('withProject')}
          </label>
          {values.withProject ? (
            <>
              <TextField
                label={t('projectName')}
                required
                value={values.projectName}
                onChange={(event) =>
                  set({
                    projectName: event.target.value,
                    ...(projectSlugTouched ? {} : { projectSlug: slugify(event.target.value) }),
                  })
                }
              />
              <TextField
                label={t('projectSlug')}
                required
                value={values.projectSlug}
                onChange={(event) => {
                  setProjectSlugTouched(true);
                  set({ projectSlug: slugChars(event.target.value) });
                }}
              />
            </>
          ) : (
            <p className="text-muted">{t('withoutProject')}</p>
          )}
        </div>
      ) : null}

      {step === 'review' ? (
        <dl className={styles.review}>
          <dt>{t('name')}</dt>
          <dd>
            {values.name} <span className="text-muted">({values.slug})</span>
          </dd>
          <dt>{t('locale')}</dt>
          <dd>{values.defaultLocale === 'de' ? 'Deutsch' : 'English'}</dd>
          <dt>{t('reviewAdmin')}</dt>
          <dd>
            {values.adminFirstName} {values.adminLastName} &lt;{values.adminEmail}&gt;
          </dd>
          <dt>{t('reviewProject')}</dt>
          <dd>{values.withProject ? values.projectName : t('none')}</dd>
          <dt>{t('reviewAccess')}</dt>
          <dd>{t('reviewAccessBody')}</dd>
        </dl>
      ) : null}

      <div className="row">
        {index > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setStep(STEPS[index - 1]!)}>
            {t('back')}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={!complete[step]}
          busy={pending}
          busyLabel={t('creating')}
        >
          {step === 'review' ? t('create') : t('next')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The last step of a lifecycle change (D5): the impact is already on the page,
 * rendered by the server; here the administrator types the tenant's name and,
 * if asked, confirms their password.
 */
export function LifecycleConfirm({
  tenantId,
  to,
  phrase,
  danger,
}: {
  readonly tenantId: string;
  readonly to: TenantLifecycle;
  readonly phrase: string;
  readonly danger: boolean;
}) {
  const t = useTranslations('administration.tenants.lifecycle');
  const tState = useTranslations('administration.tenants.state');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  function perform() {
    startTransition(async () => {
      if (needsPassword) {
        const reauth = await reauthenticateAction(password);
        if (reauth.status !== 'ok') {
          setMessage(reauth.status === 'error' ? reauth.message : t('reauthFailed'));
          return;
        }
        setPassword('');
      }
      const outcome = await changeLifecycleAction(tenantId, to, confirmation);
      if (outcome.status === 'reauth') {
        setNeedsPassword(true);
        setMessage(null);
      } else if (outcome.status === 'error') {
        setMessage(outcome.message);
        setError(outcome.fieldErrors?.confirmation ? outcome.message : undefined);
      } else {
        router.push(`/admin/tenants/${tenantId}?tab=lifecycle&changed=${to}` as Route);
        router.refresh();
      }
    });
  }

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        perform();
      }}
    >
      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}
      <TextField
        label={t('typeName', { phrase })}
        value={confirmation}
        autoComplete="off"
        error={error}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      {needsPassword ? (
        <div className="stack stack--tight">
          <p>{t('reauthExplain')}</p>
          <TextField
            label={t('password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      ) : null}
      <div>
        <Button
          type="submit"
          variant={danger ? 'danger' : 'primary'}
          disabled={confirmation.trim() !== phrase || (needsPassword && !password)}
          busy={pending}
          busyLabel={t('applying')}
        >
          {t('apply', { state: tState(to) })}
        </Button>
      </div>
    </form>
  );
}
