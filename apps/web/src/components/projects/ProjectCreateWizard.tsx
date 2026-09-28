'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import { CONTEXT_PROFILE_CORE_FIELDS, type ContextProfile } from '@axp/contracts';
import { Button, Callout, SelectField, TextField } from '@axp/ui';
import {
  connectionSitesAction,
  createProjectAction,
  type DataSourceInput,
} from '@/app/projects/actions';
import type { CreationOptions } from '@/lib/solutions';
import styles from './ProjectCreateWizard.module.css';

const STEPS = ['basics', 'context', 'source', 'done'] as const;
type Step = (typeof STEPS)[number];

const TIMEZONES = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'UTC'];

const GERMAN: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
const slugChars = (value: string) =>
  value
    .toLowerCase()
    .replace(/[äöüß]/g, (letter) => GERMAN[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 100);
const slugify = (value: string) => slugChars(value).replace(/^-+|-+$/g, '');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type SourceChoice = 'existing_site' | 'connection_site' | 'later';

/**
 * Projektanlage in four small steps (Master Spec §13). Nothing is written
 * until "Projekt anlegen"; afterwards the person lands on the setup
 * checklist, which says what is still open.
 */
export function ProjectCreateWizard({ tenants }: { readonly tenants: CreationOptions['tenants'] }) {
  const t = useTranslations('projectCreate');
  const tProfile = useTranslations('contextProfile');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>('basics');
  const [tenantId, setTenantId] = useState(tenants[0]!.id);
  const [basics, setBasics] = useState({
    name: '',
    slug: '',
    description: '',
    timezone: 'Europe/Berlin',
    defaultLocale: 'de' as 'de' | 'en',
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [profile, setProfile] = useState<ContextProfile>({});
  const [choice, setChoice] = useState<SourceChoice>('later');
  const [siteId, setSiteId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [remoteSites, setRemoteSites] = useState<{ matomoSiteId: number; name: string }[]>([]);
  const [matomoSiteId, setMatomoSiteId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const tenant = tenants.find((entry) => entry.id === tenantId)!;
  const index = STEPS.indexOf(step);

  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);

  // Existing sites are the natural first offer: a connection is tenant-wide.
  useEffect(() => {
    setChoice(tenant.sites.length > 0 ? 'existing_site' : 'later');
    setSiteId(tenant.sites[0]?.id ?? '');
    setConnectionId(tenant.connections[0]?.id ?? '');
  }, [tenant]);

  function loadSites(id: string) {
    setConnectionId(id);
    setRemoteSites([]);
    setMatomoSiteId('');
    if (!id) return;
    startTransition(async () => {
      const outcome = await connectionSitesAction(tenantId, id);
      if (outcome.status === 'ok' && outcome.data) setRemoteSites(outcome.data);
      else if (outcome.status === 'error') setMessage(outcome.message);
    });
  }

  const source: DataSourceInput | null =
    choice === 'existing_site'
      ? siteId
        ? { kind: 'existing_site', siteId }
        : null
      : choice === 'connection_site'
        ? connectionId && matomoSiteId
          ? { kind: 'connection_site', connectionId, matomoSiteId: Number(matomoSiteId) }
          : null
        : { kind: 'later' };

  const complete: Record<Step, boolean> = {
    basics: basics.name.trim().length >= 2 && SLUG.test(basics.slug),
    context: CONTEXT_PROFILE_CORE_FIELDS.every((field) => Boolean(profile[field]?.trim())),
    source: source !== null,
    done: true,
  };

  function next(event: React.FormEvent) {
    event.preventDefault();
    if (!complete[step]) return;
    if (step !== 'done') {
      setStep(STEPS[index + 1]!);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const outcome = await createProjectAction({
        tenantId,
        name: basics.name.trim(),
        slug: basics.slug,
        ...(basics.description.trim() ? { description: basics.description.trim() } : {}),
        timezone: basics.timezone,
        defaultLocale: basics.defaultLocale,
        contextProfile: profile,
        source: source!,
      });
      if (outcome.status === 'ok' && outcome.data) {
        router.push(`/projects/${outcome.data.projectId}/setup` as Route);
      } else if (outcome.status === 'error') {
        setMessage(outcome.message);
        setErrors(outcome.fieldErrors ?? {});
        if (outcome.fieldErrors?.slug) setStep('basics');
      }
    });
  }

  const profileField = (field: keyof ContextProfile, required = false) => (
    <TextField
      key={field}
      label={tProfile(`${field}.label`)}
      hint={tProfile(`${field}.hint`)}
      required={required}
      value={profile[field] ?? ''}
      onChange={(event) => setProfile({ ...profile, [field]: event.target.value })}
    />
  );

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

      <h2 ref={heading} tabIndex={-1} className={styles.stepTitle}>
        {t(`step.${step}`)}
      </h2>

      {step === 'basics' ? (
        <div className="stack">
          {tenants.length > 1 ? (
            <SelectField
              label={t('tenant')}
              value={tenantId}
              options={tenants.map((entry) => ({ value: entry.id, label: entry.name }))}
              onChange={(event) => setTenantId(event.target.value)}
            />
          ) : null}
          <TextField
            label={t('name')}
            required
            value={basics.name}
            onChange={(event) =>
              setBasics({
                ...basics,
                name: event.target.value,
                ...(slugTouched ? {} : { slug: slugify(event.target.value) }),
              })
            }
          />
          <TextField
            label={t('slug')}
            required
            hint={t('slugHint')}
            value={basics.slug}
            error={errors.slug}
            onChange={(event) => {
              setSlugTouched(true);
              setBasics({ ...basics, slug: slugChars(event.target.value) });
            }}
          />
          <TextField
            label={t('description')}
            value={basics.description}
            onChange={(event) => setBasics({ ...basics, description: event.target.value })}
          />
          <div className="row">
            <SelectField
              label={t('timezone')}
              hint={t('timezoneHint')}
              value={basics.timezone}
              options={TIMEZONES.map((zone) => ({ value: zone, label: zone }))}
              onChange={(event) => setBasics({ ...basics, timezone: event.target.value })}
            />
            <SelectField
              label={t('locale')}
              value={basics.defaultLocale}
              options={[
                { value: 'de', label: 'Deutsch' },
                { value: 'en', label: 'English' },
              ]}
              onChange={(event) =>
                setBasics({ ...basics, defaultLocale: event.target.value as 'de' | 'en' })
              }
            />
          </div>
        </div>
      ) : null}

      {step === 'context' ? (
        <div className="stack">
          <p className="text-secondary">{t('contextExplain')}</p>
          {profileField('useCase', true)}
          {profileField('audience', true)}
          {profileField('goals')}
          {profileField('success')}
          <p className="text-muted">{t('contextLater')}</p>
        </div>
      ) : null}

      {step === 'source' ? (
        <fieldset className={styles.choices}>
          <legend className="text-secondary">{t('sourceExplain')}</legend>
          {tenant.sites.length > 0 ? (
            <div className="stack stack--tight">
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="source"
                  checked={choice === 'existing_site'}
                  onChange={() => setChoice('existing_site')}
                />
                {t('sourceExisting')}
              </label>
              {choice === 'existing_site' ? (
                <SelectField
                  label={t('site')}
                  value={siteId}
                  options={tenant.sites.map((site) => ({
                    value: site.id,
                    label: site.name,
                    detail: t('siteDetail', {
                      connection: site.connectionName,
                      count: site.usedByProjects,
                    }),
                  }))}
                  onChange={(event) => setSiteId(event.target.value)}
                />
              ) : null}
            </div>
          ) : null}

          {tenant.connections.length > 0 ? (
            <div className="stack stack--tight">
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="source"
                  checked={choice === 'connection_site'}
                  onChange={() => {
                    setChoice('connection_site');
                    if (remoteSites.length === 0) loadSites(connectionId);
                  }}
                />
                {t('sourceConnection')}
              </label>
              {choice === 'connection_site' ? (
                <div className="row">
                  <SelectField
                    label={t('connection')}
                    value={connectionId}
                    options={tenant.connections.map((connection) => ({
                      value: connection.id,
                      label: connection.name,
                    }))}
                    onChange={(event) => loadSites(event.target.value)}
                  />
                  <SelectField
                    label={t('matomoSite')}
                    value={matomoSiteId}
                    disabled={remoteSites.length === 0}
                    options={[
                      { value: '', label: pending ? t('loadingSites') : t('chooseSite') },
                      ...remoteSites.map((site) => ({
                        value: String(site.matomoSiteId),
                        label: site.name,
                      })),
                    ]}
                    onChange={(event) => setMatomoSiteId(event.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <label className={styles.choice}>
            <input
              type="radio"
              name="source"
              checked={choice === 'later'}
              onChange={() => setChoice('later')}
            />
            {t('sourceLater')}
          </label>
          {tenant.connections.length === 0 ? (
            <p className="text-muted">{t('noConnection')}</p>
          ) : null}
        </fieldset>
      ) : null}

      {step === 'done' ? (
        <dl className={styles.review}>
          <dt>{t('name')}</dt>
          <dd>
            {basics.name} <span className="text-muted">({basics.slug})</span>
          </dd>
          <dt>{tProfile('useCase.label')}</dt>
          <dd>{profile.useCase}</dd>
          <dt>{tProfile('audience.label')}</dt>
          <dd>{profile.audience}</dd>
          <dt>{t('reviewSource')}</dt>
          <dd>
            {choice === 'existing_site'
              ? tenant.sites.find((site) => site.id === siteId)?.name
              : choice === 'connection_site'
                ? remoteSites.find((site) => String(site.matomoSiteId) === matomoSiteId)?.name
                : t('sourceLaterShort')}
          </dd>
          <dt>{t('reviewNext')}</dt>
          <dd>{t('reviewNextBody')}</dd>
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
          busy={pending && step === 'done'}
          busyLabel={t('creating')}
        >
          {step === 'done' ? t('create') : t('next')}
        </Button>
      </div>
    </form>
  );
}
