'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type {
  FormulaNode,
  ScoreDefinition,
  SemanticDefinitionBody,
  SemanticDefinitionRef,
  SemanticUsage,
  SemanticVersionRef,
} from '@axp/contracts';
import { Button, Callout, Card, SelectField, TextField } from '@axp/ui';
import {
  changeVersionStatusAction,
  createDefinitionAction,
  listVersionsAction,
  previewAction,
  type PreviewOutcome,
} from '@/app/projects/[projectId]/semantics/actions';
import { blankNode, FormulaBuilder, formulaToText } from './FormulaBuilder';
import { blankScore, ScoreBuilder } from './ScoreBuilder';
import { ValueReadout } from './ValueReadout';
import styles from './SemanticLibrary.module.css';

export interface SemanticLibraryProps {
  readonly projectId: string;
  readonly definitions: readonly SemanticDefinitionRef[];
  /** Active version per definition id, for showing what each one means today. */
  readonly active: Readonly<Record<string, SemanticVersionRef>>;
  /** Where each definition is used, keyed by definition id. */
  readonly usage: Readonly<Record<string, SemanticUsage>>;
  readonly siteId: string | null;
  readonly canManage: boolean;
}

type Draft =
  | { readonly kind: 'formula'; readonly ast: FormulaNode }
  | { readonly kind: 'score'; readonly score: ScoreDefinition };

/**
 * The project's semantic library (D6).
 *
 * A list of what the numbers mean, and the builders that change it. Version
 * history is on demand rather than always open: most of the time the question
 * is "what does this mean now", and the answer should not be buried under a
 * changelog.
 */
export function SemanticLibrary({
  projectId,
  definitions,
  active,
  usage,
  siteId,
  canManage,
}: SemanticLibraryProps) {
  const t = useTranslations('semantics');
  const [pending, startTransition] = useTransition();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'critical'; text: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);

  const names = new Map(
    definitions
      .filter((definition) => definition.currentVersionId)
      .map((definition) => [definition.currentVersionId!, definition.name]),
  );

  const usable = definitions.filter((definition) => definition.currentVersionId);
  const firstMetric = usable[0]?.currentVersionId ?? '';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<Draft>({
    kind: 'formula',
    ast: blankNode('binary', firstMetric),
  });

  const body = (): SemanticDefinitionBody =>
    draft.kind === 'score'
      ? draft.score
      : {
          kind: 'formula',
          ast: draft.ast,
          unit: 'ratio',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 2,
        };

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await createDefinitionAction(projectId, {
        portableId: `project.${slug(name)}`,
        type: draft.kind === 'score' ? 'score' : 'formula',
        name,
        ...(description ? { description } : {}),
        body: body(),
      });

      setMessage(
        result.status === 'saved'
          ? { tone: 'success', text: t('savedAsDraft') }
          : { tone: 'critical', text: result.message ?? t('saveFailed') },
      );
      if (result.status === 'saved') {
        setName('');
        setDescription('');
      }
    });
  }

  function runPreview() {
    if (!siteId) return;
    setPreview(null);
    startTransition(async () => setPreview(await previewAction(projectId, body(), siteId)));
  }

  function setStatus(definitionId: string, versionId: string, to: 'active' | 'deprecated') {
    startTransition(async () => {
      const result = await changeVersionStatusAction(projectId, definitionId, versionId, to);
      setMessage(
        result.status === 'saved'
          ? { tone: 'success', text: t('statusChanged') }
          : { tone: 'critical', text: result.message ?? t('saveFailed') },
      );
    });
  }

  const selected = definitions.find((definition) => definition.id === selectedId) ?? null;

  return (
    <div className="stack stack--loose">
      {message ? (
        <Callout tone={message.tone} live>
          {message.text}
        </Callout>
      ) : null}

      <Card title={t('libraryTitle')} description={t('libraryBody')}>
        {definitions.length === 0 ? (
          <p className="text-muted">{t('empty')}</p>
        ) : (
          <table className={styles.table}>
            <caption className="sr-only">{t('libraryTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('columnName')}</th>
                <th scope="col">{t('columnType')}</th>
                <th scope="col">{t('columnStatus')}</th>
                <th scope="col">{t('columnUsage')}</th>
                <th scope="col">{t('columnMeaning')}</th>
              </tr>
            </thead>
            <tbody>
              {definitions.map((definition) => {
                const version = active[definition.id];
                return (
                  <tr key={definition.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => {
                          setSelectedId(definition.id);
                          setShowHistory(false);
                        }}
                      >
                        {definition.name}
                      </button>
                    </th>
                    <td>{t(`type.${definition.type}`)}</td>
                    <td>
                      {/* A word, never a coloured dot (D10). */}
                      {version
                        ? t('statusActive', { version: version.version })
                        : t('statusDraftOnly')}
                    </td>
                    <td>{usageOf(usage[definition.id], t)}</td>
                    <td className={styles.meaning}>{meaningOf(version, names, t)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {selected ? (
        <DefinitionDetail
          projectId={projectId}
          definition={selected}
          version={active[selected.id]}
          usage={usage[selected.id]}
          names={names}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((open) => !open)}
          canManage={canManage}
          onActivate={(versionId) => setStatus(selected.id, versionId, 'active')}
        />
      ) : null}

      {canManage ? (
        <Card title={t('newTitle')} description={t('newBody')}>
          {usable.length === 0 ? (
            <p className="text-muted">{t('noMetrics')}</p>
          ) : (
            <div className="stack">
              <TextField
                label={t('definitionName')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />

              {/*
                The glossary entry. Optional in the form but asked for here
                rather than later: a definition explained in the business's own
                words is the difference between a catalog and a list of names.
              */}
              <TextField
                label={t('definitionDescription')}
                hint={t('definitionDescriptionHint')}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />

              <SelectField
                label={t('definitionType')}
                value={draft.kind}
                options={[
                  { value: 'formula', label: t('type.formula') },
                  { value: 'score', label: t('type.score') },
                ]}
                onChange={(event) =>
                  setDraft(
                    event.target.value === 'score'
                      ? { kind: 'score', score: blankScore(firstMetric) }
                      : { kind: 'formula', ast: blankNode('binary', firstMetric) },
                  )
                }
              />

              {draft.kind === 'formula' ? (
                <FormulaBuilder
                  node={draft.ast}
                  onChange={(ast) => setDraft({ kind: 'formula', ast })}
                  metrics={definitions}
                />
              ) : (
                <ScoreBuilder
                  definition={draft.score}
                  onChange={(score) => setDraft({ kind: 'score', score })}
                  metrics={definitions}
                />
              )}

              <div className="row">
                <Button type="button" onClick={runPreview} disabled={!siteId || pending}>
                  {t('preview')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={save}
                  disabled={!name || pending}
                  busy={pending}
                  busyLabel={t('saving')}
                >
                  {t('saveDraft')}
                </Button>
              </div>

              {preview ? <PreviewPanel preview={preview} /> : null}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}

/** What a definition means today, plus its history when asked for. */
function DefinitionDetail({
  projectId,
  definition,
  version,
  usage,
  names,
  showHistory,
  onToggleHistory,
  canManage,
  onActivate,
}: {
  readonly projectId: string;
  readonly definition: SemanticDefinitionRef;
  readonly version: SemanticVersionRef | undefined;
  readonly usage: SemanticUsage | undefined;
  readonly names: ReadonlyMap<string, string>;
  readonly showHistory: boolean;
  readonly onToggleHistory: () => void;
  readonly canManage: boolean;
  readonly onActivate: (versionId: string) => void;
}) {
  const t = useTranslations('semantics');
  const [history, setHistory] = useState<SemanticVersionRef[] | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    onToggleHistory();
    if (history || showHistory) return;

    startTransition(async () => {
      setHistory(await listVersionsAction(projectId, definition.id));
    });
  }

  return (
    <Card title={definition.name} description={t(`type.${definition.type}`)}>
      <div className="stack">
        <dl className={styles.facts}>
          {definition.description ? (
            <>
              <dt>{t('glossary')}</dt>
              <dd>{definition.description}</dd>
            </>
          ) : null}
          <dt>{t('portableId')}</dt>
          <dd>{definition.portableId}</dd>
          <dt>{t('columnMeaning')}</dt>
          <dd>{meaningOf(version, names, t)}</dd>
          {version ? (
            <>
              <dt>{t('unit')}</dt>
              <dd>{t(`unitName.${version.body.unit}`)}</dd>
              <dt>{t('scope')}</dt>
              <dd>{t(`scopeName.${version.body.scope}`)}</dd>
            </>
          ) : null}
          <dt>{t('columnUsage')}</dt>
          <dd>{usageOf(usage, t)}</dd>
        </dl>

        {/*
          Which version each published dashboard holds. This is what pinning
          means in practice: activating a new version changes nothing here
          until a dashboard is published again (Gate F3).
        */}
        {usage && usage.pinnedVersions.length > 0 ? (
          <ul className={styles.pinned} aria-label={t('pinnedVersions')}>
            {usage.pinnedVersions.map((pinned) => (
              <li key={pinned.versionId}>
                {t('pinnedVersion', { version: pinned.version, count: pinned.dashboards })}
              </li>
            ))}
          </ul>
        ) : null}

        {/* History on demand: the usual question is what it means now. */}
        <div>
          <Button type="button" onClick={toggle} busy={pending} busyLabel={t('loading')}>
            {showHistory ? t('hideHistory') : t('showHistory')}
          </Button>
        </div>

        {showHistory && history ? (
          <ul className={styles.history} aria-label={t('versionHistory')}>
            {history.map((entry) => (
              <li key={entry.id} className={styles.historyRow}>
                <span>{t('versionNumber', { version: entry.version })}</span>
                <span className="text-muted">{t(`lifecycle.${entry.status}`)}</span>
                {canManage && entry.status !== 'active' ? (
                  <Button type="button" onClick={() => onActivate(entry.id)}>
                    {t('activate')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Where a definition is used, in one line.
 *
 * Published and draft are named separately because they behave differently: a
 * published dashboard holds the version it pinned, a draft will take whatever
 * is active when it is next published.
 */
function usageOf(usage: SemanticUsage | undefined, t: Translator): string {
  if (!usage) return t('usageUnknown');
  if (usage.publishedDashboards === 0 && usage.draftDashboards === 0) return t('usageNone');

  return t('usageSummary', {
    published: usage.publishedDashboards,
    drafts: usage.draftDashboards,
  });
}

/** The preview result: the number, and how it came about. */
function PreviewPanel({ preview }: { readonly preview: PreviewOutcome }) {
  const t = useTranslations('semantics');

  if (preview.status === 'error') {
    return (
      <Callout tone="critical" title={t('previewFailed')} live>
        {preview.message}
      </Callout>
    );
  }

  return (
    <section className={styles.preview} aria-label={t('previewResult')}>
      <h4 className={styles.heading}>{t('previewResult')}</h4>

      {preview.value ? <ValueReadout value={preview.value} large /> : null}

      {/*
        The calculation trace. A number nobody can take apart is a number
        nobody will trust (Master Spec §13).
      */}
      {preview.trace && preview.trace.length > 0 ? (
        <ol className={styles.trace}>
          {preview.trace.map((entry, index) => (
            <li key={index} className={styles.traceRow}>
              <span>{entry.label}</span>
              <ValueReadout value={entry.value} />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

type Translator = ReturnType<typeof useTranslations>;

function meaningOf(
  version: SemanticVersionRef | undefined,
  names: ReadonlyMap<string, string>,
  t: Translator,
): string {
  if (!version) return t('noActiveVersion');

  const body = version.body;
  if (body.kind === 'formula') return formulaToText(body.ast, names);
  if (body.kind === 'score') return t('scoreOf', { count: body.components.length });
  if (body.kind === 'native') return t('nativeOf', { metric: body.sourceMetric });
  return t('customOf', { requirement: body.requirementKey });
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'definition'
  );
}
