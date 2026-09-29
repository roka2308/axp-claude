import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  hasNumericValue,
  type CalculationStep,
  type WidgetDetailPresentation,
  type WidgetPresentation,
} from '@axp/contracts';
import { Callout, DataTable } from '@axp/ui';
import { WidgetContent } from '@/components/widgets/WidgetContent';
import { CopyLinkButton } from './CopyLinkButton';
import styles from './WidgetDetail.module.css';

export interface WidgetDetailProps {
  readonly detail: WidgetDetailPresentation;
  /**
   * The control behind the `export` action, supplied by the page that knows
   * where an export goes - the signed-in viewer or a shared link.
   */
  readonly exportControl?: React.ReactNode;
}

/**
 * Widget Detail View (D4, Master Spec §11).
 *
 * The modules are in the order the specification gives, which is relevance
 * order rather than data order: the header, the core value, a larger
 * visualisation, then what the number means, the context it sits in, anything
 * worth knowing about its quality, the breakdown behind it, and finally what
 * can be done with it.
 *
 * Every module is omitted when it has nothing to say. A detail view padded with
 * empty sections teaches people to stop reading it.
 */
export async function WidgetDetail({ detail, exportControl }: WidgetDetailProps) {
  const t = await getTranslations();
  const { widget } = detail;

  return (
    <article className={styles.detail}>
      {/* 1. Header — what this is, and over which period. */}
      <header className="stack stack--tight">
        <h2 className={styles.title}>{widget.title}</h2>
        <p className="text-secondary">
          {detail.dashboard.name} · {detail.timeRange.from} – {detail.timeRange.to}
          {detail.comparison?.from
            ? ` · ${t('viewer.scopeComparison')}: ${detail.comparison.from} – ${detail.comparison.to}`
            : ''}
        </p>
        <p className={styles.scope}>
          {t('viewer.scopeSite')}: {detail.dataScope.siteName} · {detail.dataScope.siteTimezone}
          {detail.dataScope.filters.map((filter) => ` · ${filter.label}: ${filter.value}`).join('')}
        </p>
      </header>

      {/* 2. Core value — the tile's own answer, unchanged. */}
      <section className={styles.core} aria-label={t('detail.coreValue')}>
        <WidgetSurface widget={widget} />
      </section>

      {/* 3. The larger visualisation: the same question over time. */}
      {detail.visualisation ? (
        <section className="stack stack--tight" aria-label={t('detail.visualisation')}>
          <h3 className={styles.heading}>{t('detail.visualisation')}</h3>
          <WidgetContent widget={{ ...widget, content: detail.visualisation }} />
        </section>
      ) : null}

      {/* 4. Definition — core product, not a tooltip (D4). */}
      {widget.definition ? (
        <section className="stack stack--tight" aria-label={t('viewer.definition')}>
          <h3 className={styles.heading}>{t('viewer.definition')}</h3>
          <dl className={styles.facts}>
            <dt>{t('viewer.definitionName')}</dt>
            <dd>
              {widget.definition.name} ·{' '}
              {t('viewer.semanticVersion', { version: widget.definition.semanticVersion })}
            </dd>
            {widget.definition.description ? (
              <>
                <dt>{t('detail.meaning')}</dt>
                <dd>{widget.definition.description}</dd>
              </>
            ) : null}
            <dt>{t('viewer.definitionUnit')}</dt>
            <dd>{t(`units.${widget.definition.unit}`)}</dd>
            <dt>{t('viewer.definitionScope')}</dt>
            <dd>{t(`scopesSemantic.${widget.definition.scope}`)}</dd>
          </dl>
        </section>
      ) : null}

      {/* 4b. How the number came about. */}
      {detail.explanation ? <Explanation steps={detail.explanation} /> : null}

      {/* 5. Context — what the author wanted read alongside the number. */}
      {widget.context ? (
        <section className="stack stack--tight" aria-label={t('detail.context')}>
          <h3 className={styles.heading}>{t('detail.context')}</h3>
          <p>{widget.context}</p>
        </section>
      ) : null}

      {/* 6. Data quality — only what is relevant to interpretation (§18). */}
      {widget.dataQuality.length > 0 ? (
        <section className="stack stack--tight" aria-label={t('detail.dataQuality')}>
          <h3 className={styles.heading}>{t('detail.dataQuality')}</h3>
          {widget.dataQuality.map((note, index) => (
            <Callout
              key={index}
              tone={note.severity === 'problem' ? 'critical' : 'warning'}
              title={t(`quality.severity.${note.severity}`)}
            >
              {t.has(note.messageKey)
                ? t(note.messageKey, note.details as never)
                : t('quality.unspecified')}
            </Callout>
          ))}
        </section>
      ) : null}

      {/* 7. Breakdown — the dimension behind the number, when there is one. */}
      {detail.breakdown ? (
        <section className="stack stack--tight" aria-label={t('detail.breakdown')}>
          <h3 className={styles.heading}>{t('detail.breakdown')}</h3>
          <WidgetContent
            widget={{ ...widget, family: 'flexible_table', content: detail.breakdown.content }}
          />
        </section>
      ) : null}

      {/* 8. Actions — each one stating whether it is possible here. */}
      <section className="stack stack--tight" aria-label={t('detail.actions')}>
        <h3 className={styles.heading}>{t('detail.actions')}</h3>
        <ul className={styles.actions}>
          {detail.actions.map((action) => (
            <li key={action.kind}>
              {action.kind === 'copy_link' && action.available ? (
                <CopyLinkButton label={t(action.labelKey)} copiedLabel={t('detail.linkCopied')} />
              ) : action.kind === 'export' && action.available && exportControl ? (
                exportControl
              ) : action.available && action.href ? (
                // The API decides where an action leads, so the literal-route
                // check cannot see it. The set of shapes it may produce is
                // fixed in `detailActions`.
                <Link href={action.href as Route} className={styles.action}>
                  {t(action.labelKey)}
                </Link>
              ) : (
                <span className={styles.unavailableAction}>
                  {t(action.labelKey)}
                  <span className={styles.unavailableReason}>
                    {action.unavailableKey && t.has(action.unavailableKey)
                      ? t(action.unavailableKey)
                      : t('detail.action.unavailable')}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

/**
 * The tile's own content, or the state it is in.
 *
 * Mirrors `WidgetFrame`'s rule without the frame: a state that carries no
 * number is stated in words, never drawn as an empty chart.
 */
async function WidgetSurface({ widget }: { readonly widget: WidgetPresentation }) {
  const t = await getTranslations();

  const carriesValues =
    widget.state === 'ready' || widget.state === 'zero' || widget.state === 'warning';

  if (carriesValues) return <WidgetContent widget={widget} />;

  const message = widget.unavailable
    ? t.has(widget.unavailable.messageKey)
      ? t(widget.unavailable.messageKey, widget.unavailable.messageParams as never)
      : t('states.unavailable')
    : t(`states.${stateKey(widget.state)}`);

  const action = widget.unavailable?.actionKey
    ? t.has(widget.unavailable.actionKey)
      ? t(widget.unavailable.actionKey)
      : null
    : null;

  const reason =
    widget.stateMessage && t.has(widget.stateMessage.messageKey)
      ? t(widget.stateMessage.messageKey, widget.stateMessage.messageParams as never)
      : null;

  return (
    <div className={styles.state} data-state={widget.state}>
      <span className={styles.stateLabel}>{message}</span>
      {reason ? <span className={styles.stateAction}>{reason}</span> : null}
      {action ? <span className={styles.stateAction}>{action}</span> : null}
    </div>
  );
}

/**
 * The calculation trace (D4).
 *
 * A table rather than a diagram: the rows are the inputs, and a reader wants to
 * compare them. Each step keeps its own state, so a step that could not be
 * computed reads as such instead of leaving a blank cell.
 */
async function Explanation({ steps }: { readonly steps: readonly CalculationStep[] }) {
  const t = await getTranslations();
  const hasScoreColumns = steps.some((step) => step.sharePercent !== undefined);

  return (
    <section className="stack stack--tight" aria-label={t('detail.explanation')}>
      <h3 className={styles.heading}>{t('detail.explanation')}</h3>
      <p className={styles.hint}>{t('detail.explanationHint')}</p>

      <DataTable
        caption={t('detail.explanation')}
        captionHidden
        columns={[
          { key: 'label', label: t('detail.step') },
          { key: 'value', label: t('detail.stepValue'), numeric: true },
          ...(hasScoreColumns
            ? [
                { key: 'points', label: t('detail.stepPoints'), numeric: true },
                { key: 'share', label: t('detail.stepShare'), numeric: true },
              ]
            : []),
        ]}
        rows={steps.map((step, index) => ({
          key: `${index}-${step.label}`,
          // The result row is marked as such in text, not by weight alone.
          cells: {
            label: step.isResult ? `${step.label} (${t('detail.result')})` : step.label,
            value: hasNumericValue(step.value)
              ? step.formatted
              : t(`states.${stateKey(step.value.state)}`),
            points: step.points === undefined ? '—' : step.points.toLocaleString('de-DE'),
            share: step.sharePercent === undefined ? '—' : `${step.sharePercent} %`,
          },
        }))}
      />
    </section>
  );
}

function stateKey(state: string): string {
  if (state === 'not_applicable') return 'notApplicable';
  if (state === 'not_tracked') return 'notTracked';
  return state;
}
