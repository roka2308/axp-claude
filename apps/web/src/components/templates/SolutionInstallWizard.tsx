'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import type {
  ConflictResolution,
  PackageAnalysis,
  PackageIssue,
  SolutionInstallResult,
  ValueEnvelope,
} from '@axp/contracts';
import { PACKAGE_CHECK_STAGES } from '@axp/contracts';
import { Button, Callout, SelectField } from '@axp/ui';
import {
  analyzeSolutionAction,
  installSolutionAction,
  mappingPreviewAction,
  type PackageSourceInput,
} from '@/app/templates/actions';
import styles from './SolutionInstallWizard.module.css';

const STEPS = ['check', 'mapping', 'conflicts', 'preview'] as const;
type Step = (typeof STEPS)[number];

/**
 * The install flow (Master Spec §14):
 * Upload/Auswahl → Prüfen → Zuordnen → Konflikte → Vorschau → Installieren.
 *
 * Every step shows what the server's analysis found; nothing here decides
 * whether a package is safe. The analysis runs again on install, so what the
 * person saw and what the server checks cannot drift apart.
 */
export function SolutionInstallWizard({
  projectId,
  catalog,
}: {
  readonly projectId: string;
  readonly catalog?: { readonly packageId: string };
}) {
  const t = useTranslations('install');
  const tSource = useTranslations('sourceMetric');
  const [pending, startTransition] = useTransition();
  const [source, setSource] = useState<PackageSourceInput | null>(catalog ? { catalog } : null);
  const [analysis, setAnalysis] = useState<PackageAnalysis | null>(null);
  const [step, setStep] = useState<Step>('check');
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SolutionInstallResult | null>(null);

  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step, result]);

  // The catalogue path analyses straight away; an upload waits for its file.
  useEffect(() => {
    if (source) analyze(source);
  }, [source]);

  function analyze(input: PackageSourceInput) {
    setMessage(null);
    startTransition(async () => {
      const outcome = await analyzeSolutionAction(projectId, input);
      if (outcome.status === 'ok' && outcome.data) {
        setAnalysis(outcome.data);
        setStep('check');
      } else if (outcome.status === 'error') {
        setMessage(outcome.message);
      }
    });
  }

  async function readFile(file: File) {
    setMessage(null);
    setAnalysis(null);
    const text = await file.text();
    try {
      // Parsed here only to send it as data; the server validates everything.
      setSource({ upload: JSON.parse(text) as unknown });
    } catch {
      setMessage(t('notJson'));
    }
  }

  function preview(requirementKey: string) {
    const sourceMetric = mappings[requirementKey];
    if (!sourceMetric || sourceMetric === 'not_available') return;
    startTransition(async () => {
      const outcome = await mappingPreviewAction(projectId, sourceMetric);
      setPreviews((current) => ({
        ...current,
        [requirementKey]:
          outcome.status === 'ok'
            ? describeValue(outcome.data?.value ?? null)
            : outcome.status === 'error'
              ? outcome.message
              : '',
      }));
    });
  }

  function describeValue(value: ValueEnvelope | null): string {
    if (!value) return t('previewNone');
    if ('value' in value) {
      return t('previewValue', { value: value.value.toLocaleString(t('numberLocale')) });
    }
    return t(`previewState.${value.state}`);
  }

  function install() {
    if (!source) return;
    setMessage(null);
    startTransition(async () => {
      const outcome = await installSolutionAction(projectId, source, {
        mappings,
        resolutions,
        acceptWarnings,
      });
      if (outcome.status === 'ok' && outcome.data) setResult(outcome.data);
      else if (outcome.status === 'error') setMessage(outcome.message);
    });
  }

  // --- before a package is there -------------------------------------------------
  if (!source) {
    return (
      <div className="stack">
        <h2 className={styles.stepTitle}>{t('uploadTitle')}</h2>
        <p className="text-secondary">{t('uploadBody')}</p>
        {message ? (
          <Callout tone="critical" live>
            {message}
          </Callout>
        ) : null}
        <label className={styles.file}>
          <span>{t('chooseFile')}</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </label>
      </div>
    );
  }

  if (!analysis) {
    return message ? (
      <Callout tone="critical" live>
        {message}
      </Callout>
    ) : (
      <p aria-live="polite">{t('analysing')}</p>
    );
  }

  // --- done ------------------------------------------------------------------------
  if (result) {
    return (
      <div className="stack">
        <h2 ref={heading} tabIndex={-1} className={styles.stepTitle}>
          {t('doneTitle')}
        </h2>
        <Callout tone="success" live>
          {t('doneBody', {
            created: result.definitionsCreated,
            reused: result.definitionsReused,
            versions: result.versionsAdded,
            templates: result.templates,
          })}
        </Callout>
        <Link href={`/templates?project=${projectId}&tab=dashboards` as Route}>
          {t('toTemplates')}
        </Link>
      </div>
    );
  }

  const errors = analysis.issues.filter((issue) => issue.severity === 'error');
  const warnings = analysis.issues.filter((issue) => issue.severity === 'warning');
  const openMappings = analysis.mappings.filter((mapping) => !mapping.existing);
  const changed = analysis.conflicts.filter((conflict) => conflict.kind === 'changed');
  const index = STEPS.indexOf(step);

  const complete: Record<Step, boolean> = {
    check: analysis.installable,
    mapping: openMappings.every((mapping) => Boolean(mappings[mapping.requirement.key])),
    conflicts: changed.every((conflict) => Boolean(resolutions[conflict.portableId])),
    preview: warnings.length === 0 || acceptWarnings,
  };

  return (
    <div className="stack">
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

      {analysis.manifest ? (
        <p className="text-secondary">
          {t('packageLine', {
            name: analysis.manifest.name,
            version: analysis.manifest.packageVersion,
            publisher: analysis.manifest.publisher,
          })}
          {analysis.installedVersion
            ? ` · ${t('updateFrom', { version: analysis.installedVersion })}`
            : ''}
        </p>
      ) : null}

      {message ? (
        <Callout tone="critical" live>
          {message}
        </Callout>
      ) : null}

      <h2 ref={heading} tabIndex={-1} className={styles.stepTitle}>
        {t(`step.${step}`)}
      </h2>

      {step === 'check' ? (
        <div className="stack">
          <p className={styles.verdict} data-tone={analysis.installable ? 'ok' : 'blocked'}>
            {analysis.installable ? t('checkPassed') : t('checkFailed')}
          </p>
          <p>{t(`compatibility.${analysis.compatibility}`)}</p>
          <IssueList issues={analysis.issues} />
          {!analysis.installable && 'upload' in source ? (
            <Button type="button" variant="ghost" onClick={() => setSource(null)}>
              {t('chooseOther')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {step === 'mapping' ? (
        <div className="stack">
          <p className="text-secondary">{t('mappingExplain')}</p>
          {analysis.mappings.length === 0 ? <p>{t('mappingNone')}</p> : null}
          <ul className={styles.mappings}>
            {analysis.mappings.map((mapping) => {
              const key = mapping.requirement.key;
              return (
                <li key={key} className={styles.mapping}>
                  <strong>{mapping.requirement.label}</strong>
                  {mapping.requirement.description ? (
                    <span className="text-muted">{mapping.requirement.description}</span>
                  ) : null}
                  {mapping.existing ? (
                    <span>
                      {t('alreadyMapped', {
                        source:
                          'sourceMetric' in mapping.existing
                            ? tSource.has(mapping.existing.sourceMetric)
                              ? tSource(mapping.existing.sourceMetric)
                              : mapping.existing.sourceMetric
                            : 'notAvailable' in mapping.existing
                              ? t('notAvailable')
                              : mapping.existing.other,
                      })}
                    </span>
                  ) : (
                    <div className="row">
                      <SelectField
                        label={t('sourceFor', { label: mapping.requirement.label })}
                        value={mappings[key] ?? ''}
                        options={[
                          { value: '', label: t('choose') },
                          ...mapping.candidates.map((candidate) => ({
                            value: candidate.sourceMetric,
                            label: tSource.has(candidate.sourceMetric)
                              ? tSource(candidate.sourceMetric)
                              : candidate.sourceMetric,
                          })),
                          { value: 'not_available', label: t('notAvailable') },
                        ]}
                        onChange={(event) => {
                          setMappings({ ...mappings, [key]: event.target.value });
                          setPreviews((current) => {
                            const next = { ...current };
                            delete next[key];
                            return next;
                          });
                        }}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => preview(key)}
                        disabled={!mappings[key] || mappings[key] === 'not_available' || pending}
                      >
                        {t('preview')}
                      </Button>
                    </div>
                  )}
                  {previews[key] ? (
                    <span className={styles.previewValue} aria-live="polite">
                      {previews[key]}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {step === 'conflicts' ? (
        <div className="stack">
          {analysis.conflicts.length === 0 ? (
            <p>{t('noConflicts')}</p>
          ) : (
            <>
              <p className="text-secondary">{t('conflictsExplain')}</p>
              <ul className={styles.mappings}>
                {analysis.conflicts.map((conflict) => (
                  <li
                    key={`${conflict.objectType}:${conflict.portableId}`}
                    className={styles.mapping}
                  >
                    <strong>{conflict.name}</strong>
                    <span className="text-muted">
                      {t(`conflictObject.${conflict.objectType}`)} ·{' '}
                      {t(`conflictKind.${conflict.kind}`)}
                    </span>
                    {conflict.kind === 'changed' ? (
                      <fieldset className={styles.choices}>
                        <legend className="sr-only">
                          {t('resolutionFor', { name: conflict.name })}
                        </legend>
                        {(['keep_existing', 'new_version'] as const).map((choice) => (
                          <label key={choice} className={styles.choice}>
                            <input
                              type="radio"
                              name={`resolution-${conflict.portableId}`}
                              checked={resolutions[conflict.portableId] === choice}
                              onChange={() =>
                                setResolutions({ ...resolutions, [conflict.portableId]: choice })
                              }
                            />
                            {t(`resolution.${choice}`)}
                          </label>
                        ))}
                      </fieldset>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {step === 'preview' ? (
        <div className="stack">
          <ul>
            <li>{t('previewNew', { count: analysis.preview.definitionsNew })}</li>
            <li>{t('previewReused', { count: analysis.preview.definitionsReused })}</li>
            <li>{t('previewChanged', { count: analysis.preview.definitionsConflicting })}</li>
            <li>
              {t('previewTemplates', {
                dashboards: analysis.preview.dashboardTemplates,
                widgets: analysis.preview.widgetTemplates,
              })}
            </li>
          </ul>
          <p className="text-muted">{t('previewPromise')}</p>
          {warnings.length > 0 ? (
            <div className="stack stack--tight">
              <IssueList issues={warnings} />
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  checked={acceptWarnings}
                  onChange={(event) => setAcceptWarnings(event.target.checked)}
                />
                {t('acceptWarnings')}
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        {index > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setStep(STEPS[index - 1]!)}>
            {t('back')}
          </Button>
        ) : null}
        {step !== 'preview' ? (
          <Button
            type="button"
            variant="primary"
            disabled={!complete[step] || errors.length > 0}
            onClick={() => setStep(STEPS[index + 1]!)}
          >
            {t('next')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={!STEPS.every((entry) => complete[entry]) || pending}
            busy={pending}
            busyLabel={t('installing')}
            onClick={install}
          >
            {analysis.installedVersion ? t('update') : t('installNow')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Findings grouped by the stage of the flow they belong to, in words. */
function IssueList({ issues }: { readonly issues: readonly PackageIssue[] }) {
  const t = useTranslations();
  if (issues.length === 0) return null;

  return (
    <div className="stack stack--tight">
      {PACKAGE_CHECK_STAGES.map((stage) => {
        const inStage = issues.filter((issue) => issue.stage === stage);
        if (inStage.length === 0) return null;
        return (
          <section key={stage} aria-label={t(`install.stage.${stage}`)}>
            <h3 className={styles.stageTitle}>{t(`install.stage.${stage}`)}</h3>
            <ul className={styles.issues}>
              {inStage.map((issue, position) => (
                <li key={position} data-severity={issue.severity}>
                  <strong>
                    {issue.severity === 'error' ? t('install.error') : t('install.warning')}:
                  </strong>{' '}
                  {t.has(issue.messageKey)
                    ? t(issue.messageKey, issue.messageParams ?? {})
                    : issue.messageKey}
                  {issue.path ? <span className="text-muted"> ({issue.path})</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
