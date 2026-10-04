'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_DARK_COLORS,
  DEFAULT_LIGHT_COLORS,
  THEME_PRESETS,
  type ThemeMode,
  type ThemeOverview,
  type ThemePresetKey,
  type ThemeValidation,
} from '@axp/contracts';
import { Button, Callout, TextField } from '@axp/ui';
import {
  discardThemeDraftAction,
  publishThemeAction,
  rollbackThemeAction,
  saveThemeDraftAction,
  validateThemeAction,
} from '@/app/admin/productization-actions';
import type { ThemeScopePath } from '@/lib/theming';
import styles from './ThemeEditor.module.css';

/** The colour tokens a person edits, in groups that mean something to them. */
const GROUPS = {
  accent: [
    '--accent-default',
    '--accent-hover',
    '--accent-active',
    '--accent-subtle',
    '--accent-muted',
    '--accent-contrast',
  ],
  text: ['--text-primary', '--text-secondary', '--text-muted', '--text-link'],
  surfaces: ['--surface-page', '--surface-card', '--surface-sunken', '--surface-selected'],
  borders: ['--border-subtle', '--border-default', '--border-strong', '--focus-ring-color'],
  charts: [
    '--chart-series-1',
    '--chart-series-2',
    '--chart-series-3',
    '--chart-series-4',
    '--chart-comparison',
  ],
  evaluation: [
    '--evaluation-band-1',
    '--evaluation-band-2',
    '--evaluation-band-3',
    '--evaluation-band-4',
    '--evaluation-band-5',
  ],
} as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface ThemeEditorProps {
  readonly path: ThemeScopePath;
  readonly overview: ThemeOverview;
  /** Whether presets are offered (they are for every scope). */
  readonly title: string;
}

/**
 * Theme editor (Master Spec §16): Draft -> Preview -> Validate -> Publish ->
 * Version/Rollback.
 *
 * Only colour values for allowlisted tokens can be entered - there is no
 * field for CSS. The preview applies the draft to sample components right
 * here; the product itself changes only when a version is published, and a
 * version is only published when every contrast check passes, for this theme
 * and for every theme built on it.
 */
export function ThemeEditor({ path, overview, title }: ThemeEditorProps) {
  const t = useTranslations('themes');
  const router = useRouter();
  const start =
    overview.draft ??
    (overview.published
      ? {
          name: overview.name,
          tokens: overview.published.tokens,
          darkTokens: overview.published.darkTokens,
        }
      : null);
  const [name, setName] = useState(start?.name || title);
  const [light, setLight] = useState<Record<string, string>>({ ...(start?.tokens ?? {}) });
  const [dark, setDark] = useState<Record<string, string>>({ ...(start?.darkTokens ?? {}) });
  const [mode, setMode] = useState<ThemeMode>('light');
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<ThemeValidation | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'critical'; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const values = mode === 'light' ? light : dark;
  const setValues = mode === 'light' ? setLight : setDark;
  const inherited = mode === 'light' ? overview.inherited : overview.inheritedDark;
  const defaults =
    mode === 'light' ? DEFAULT_LIGHT_COLORS : { ...DEFAULT_LIGHT_COLORS, ...DEFAULT_DARK_COLORS };

  /** What the preview shows: defaults, then inheritance, then this draft. */
  const effective = useMemo(() => {
    const merged: Record<string, string> = { ...defaults, ...inherited };
    for (const [token, value] of Object.entries(values)) if (HEX.test(value)) merged[token] = value;
    return merged;
  }, [defaults, inherited, values]);

  const change = (token: string, value: string) => {
    setValues((current) => {
      const next = { ...current };
      if (value === '') delete next[token];
      else next[token] = value;
      return next;
    });
    setDirty(true);
    setValidation(null);
  };

  const applyPreset = (key: ThemePresetKey) => {
    setLight({ ...THEME_PRESETS[key].tokens });
    setName(THEME_PRESETS[key].name);
    setDirty(true);
    setValidation(null);
  };

  const run = (work: () => Promise<{ status: string; message?: string }>, done?: string) =>
    startTransition(async () => {
      const outcome = await work();
      if (outcome.status === 'ok') {
        if (done) setMessage({ tone: 'success', text: done });
        router.refresh();
      } else {
        setMessage({ tone: 'critical', text: outcome.message ?? t('failed') });
      }
    });

  const save = () =>
    run(async () => {
      const outcome = await saveThemeDraftAction(path, { name, tokens: light, darkTokens: dark });
      if (outcome.status === 'ok') setDirty(false);
      return outcome;
    }, t('saved'));

  const validate = () =>
    startTransition(async () => {
      const outcome = await validateThemeAction(path);
      if (outcome.status === 'ok' && outcome.data) {
        setValidation(outcome.data);
        setMessage(null);
      } else if (outcome.status === 'error')
        setMessage({ tone: 'critical', text: outcome.message });
    });

  const hasDraft = Boolean(overview.draft) && !dirty;

  return (
    <div className={styles.editor}>
      {!overview.applied ? (
        <Callout tone="warning" title={t('notEntitledTitle')}>
          {t('notEntitledBody')}
        </Callout>
      ) : null}

      <div className={styles.status}>
        <span>
          {overview.published
            ? t('publishedVersion', { version: overview.published.version })
            : t('nothingPublished')}
        </span>
        <span>{overview.draft ? t('draftExists') : t('noDraft')}</span>
        {dirty ? <span className={styles.unsaved}>{t('unsaved')}</span> : null}
      </div>

      {message ? (
        <Callout tone={message.tone} live>
          {message.text}
        </Callout>
      ) : null}

      <div className={styles.layout}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <TextField
            label={t('name')}
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
            required
          />

          <div className={styles.presets} role="group" aria-label={t('presets')}>
            <span className={styles.hint}>{t('presets')}:</span>
            {(Object.keys(THEME_PRESETS) as ThemePresetKey[]).map((key) => (
              <Button key={key} type="button" variant="ghost" onClick={() => applyPreset(key)}>
                {THEME_PRESETS[key].name}
              </Button>
            ))}
          </div>

          <div className={styles.modes} role="radiogroup" aria-label={t('mode')}>
            {(['light', 'dark'] as const).map((entry) => (
              <label key={entry} className={styles.mode}>
                <input
                  type="radio"
                  name="theme-mode"
                  checked={mode === entry}
                  onChange={() => setMode(entry)}
                />
                {t(`modes.${entry}`)}
              </label>
            ))}
          </div>
          {mode === 'dark' ? <p className={styles.hint}>{t('darkHint')}</p> : null}

          {(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((group) => (
            <fieldset key={group} className={styles.group}>
              <legend className={styles.legend}>{t(`groups.${group}`)}</legend>
              {GROUPS[group].map((token) => {
                const own = values[token] ?? '';
                const fallback =
                  inherited[token as keyof typeof inherited] ??
                  defaults[token as keyof typeof defaults] ??
                  '';
                const invalid = own !== '' && !HEX.test(own);
                const id = `${mode}-${token}`;
                return (
                  <div key={token} className={styles.row}>
                    <label htmlFor={id} className={styles.label}>
                      {t(`token.${token.slice(2).replace(/-/g, '_')}`)}
                      <span className={styles.tokenName}>{token}</span>
                    </label>
                    <input
                      type="color"
                      aria-label={t('pick', {
                        token: t(`token.${token.slice(2).replace(/-/g, '_')}`),
                      })}
                      className={styles.swatch}
                      value={HEX.test(own) ? own : HEX.test(fallback) ? fallback : '#000000'}
                      onChange={(event) => change(token, event.target.value)}
                    />
                    <input
                      id={id}
                      className={styles.hex}
                      value={own}
                      placeholder={fallback}
                      aria-describedby={`${id}-hint`}
                      aria-invalid={invalid || undefined}
                      onChange={(event) => change(token, event.target.value.trim())}
                    />
                    <span id={`${id}-hint`} className={invalid ? styles.invalid : styles.hint}>
                      {invalid
                        ? t('invalidHex')
                        : own
                          ? t('overridden')
                          : t('inherits', { value: fallback })}
                    </span>
                  </div>
                );
              })}
            </fieldset>
          ))}

          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={pending || !overview.applied}>
              {t('saveDraft')}
            </Button>
            <Button type="button" disabled={pending || !hasDraft} onClick={validate}>
              {t('validate')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending || !hasDraft || !validation?.publishable}
              onClick={() => run(() => publishThemeAction(path), t('published'))}
            >
              {t('publish')}
            </Button>
            {overview.draft ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => run(() => discardThemeDraftAction(path), t('discarded'))}
              >
                {t('discard')}
              </Button>
            ) : null}
          </div>
          {dirty ? <p className={styles.hint}>{t('saveBeforeValidate')}</p> : null}
        </form>

        <section
          className={styles.preview}
          aria-label={t('preview')}
          style={previewStyle(effective)}
        >
          <h3 className={styles.previewTitle}>{t('preview')}</h3>
          <div className={styles.previewCard}>
            <strong className={styles.previewHeading}>{t('sample.heading')}</strong>
            <p className={styles.previewBody}>{t('sample.body')}</p>
            <p className={styles.previewMuted}>{t('sample.muted')}</p>
            <a
              className={styles.previewLink}
              href="#theme-preview"
              onClick={(event) => event.preventDefault()}
            >
              {t('sample.link')}
            </a>
            <div className={styles.previewControls}>
              <span className={styles.previewButton}>{t('sample.button')}</span>
              <span className={styles.previewInput}>{t('sample.input')}</span>
              <span className={styles.previewFocus}>{t('sample.focus')}</span>
            </div>
            <div className={styles.previewChart} aria-hidden="true">
              {[1, 2, 3, 4].map((slot) => (
                <span
                  key={slot}
                  style={{
                    background: `var(--chart-series-${slot})`,
                    height: `${30 + slot * 12}px`,
                  }}
                />
              ))}
            </div>
            <div className={styles.previewBands}>
              {[1, 2, 3, 4, 5].map((band) => (
                <span key={band} className={styles.previewBand}>
                  <span
                    className={styles.previewBandMark}
                    style={{ background: `var(--evaluation-band-${band})` }}
                    aria-hidden="true"
                  />
                  {t('sample.band', { band })}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>

      {validation ? (
        <section className="stack stack--tight" aria-labelledby="theme-validation">
          <h3 id="theme-validation" className={styles.sectionTitle}>
            {validation.publishable ? t('validation.ok') : t('validation.notOk')}
          </h3>
          <table className={styles.table}>
            <caption className="sr-only">{t('validation.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('validation.pair')}</th>
                <th scope="col">{t('validation.mode')}</th>
                <th scope="col">{t('validation.ratio')}</th>
                <th scope="col">{t('validation.required')}</th>
                <th scope="col">{t('validation.result')}</th>
              </tr>
            </thead>
            <tbody>
              {validation.contrast.map((check) => (
                <tr
                  key={`${check.mode}-${check.foreground}-${check.background}`}
                  data-pass={check.pass}
                >
                  <td>
                    {t(`reason.${check.reason}`)} ({check.foreground} / {check.background})
                  </td>
                  <td>{t(`modes.${check.mode}`)}</td>
                  <td>{check.ratio === null ? '—' : `${check.ratio.toFixed(2)}:1`}</td>
                  <td>{check.minimumRatio}:1</td>
                  <td className={check.pass ? styles.pass : styles.fail}>
                    {check.pass ? t('validation.pass') : t('validation.fail')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {validation.dependents.length > 0 ? (
            <Callout tone="critical" title={t('validation.dependentsTitle')}>
              <ul>
                {validation.dependents.map((entry) => (
                  <li key={`${entry.scope}-${entry.name}`}>
                    {t('validation.dependent', {
                      scope: t(`scope.${entry.scope}`),
                      name: entry.name,
                      failing: entry.failing,
                    })}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </section>
      ) : null}

      {overview.versions.length > 0 ? (
        <section className="stack stack--tight" aria-labelledby="theme-versions">
          <h3 id="theme-versions" className={styles.sectionTitle}>
            {t('versions')}
          </h3>
          <ul className={styles.versions}>
            {overview.versions.map((version) => (
              <li key={version.version}>
                <span>
                  {t('versionLine', { version: version.version, by: version.publishedBy ?? '—' })}
                  {version.rolledBackFromVersion
                    ? ` · ${t('rolledBackFrom', { version: version.rolledBackFromVersion })}`
                    : ''}
                  {version.isCurrent ? ` · ${t('current')}` : ''}
                </span>
                {!version.isCurrent ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(() => rollbackThemeAction(path, version.version), t('rolledBack'))
                    }
                  >
                    {t('rollback')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The draft's values as custom properties on the preview only. */
function previewStyle(tokens: Readonly<Record<string, string>>): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [token, value] of Object.entries(tokens)) if (HEX.test(value)) style[token] = value;
  return style as React.CSSProperties;
}
