import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import type { WidgetPresentation } from '@axp/contracts';
import styles from './WidgetFrame.module.css';

/**
 * The shell every widget shares.
 *
 * Owns the part of D10 that must never vary between widget families: the
 * distinction between "no data yet", "measured nothing", "value missing" and
 * "source unavailable", and the rule that a state is never signalled by colour
 * alone - every state renders as text.
 */
export async function WidgetFrame({
  widget,
  children,
  detailHref,
}: {
  readonly widget: WidgetPresentation;
  readonly children?: React.ReactNode;
  /**
   * Where the detail view lives, when one is reachable from here.
   *
   * A link rather than a click handler on the tile: the detail view is a URL,
   * so it can be shared, opened in a new tab and reached by keyboard without
   * anything extra (D4, D10).
   */
  readonly detailHref?: Route;
}) {
  const t = await getTranslations();

  const showsContent =
    widget.state === 'ready' || widget.state === 'zero' || widget.state === 'warning';

  return (
    <section className={styles.widget} aria-label={widget.title}>
      <header className={styles.header}>
        <h3 className={styles.title}>
          {detailHref ? (
            <Link href={detailHref} className={styles.titleLink} scroll={false}>
              {widget.title}
              <span className={styles.detailHint}>{t('detail.open')}</span>
            </Link>
          ) : (
            widget.title
          )}
        </h3>
        {widget.freshness ? (
          <span className={styles.freshness}>
            {/*
              No "live" badge: freshness is stated factually, and only where it
              helps interpretation (D4).
            */}
            {t('viewer.updatedAt', {
              time: new Date(widget.freshness.fetchedAt).toLocaleTimeString('de-DE', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: widget.freshness.siteTimezone,
              }),
            })}
          </span>
        ) : null}
      </header>

      <div className={styles.body}>
        {showsContent ? children : <WidgetStateMessage widget={widget} />}
      </div>

      {widget.context ? <p className={styles.context}>{widget.context}</p> : null}

      {widget.definition ? (
        <details className={styles.definition}>
          <summary className={styles.definitionSummary}>{t('viewer.definition')}</summary>
          <dl className={styles.definitionList}>
            <dt>{t('viewer.definitionName')}</dt>
            <dd>
              {widget.definition.name} ·{' '}
              {t('viewer.semanticVersion', { version: widget.definition.semanticVersion })}
            </dd>
            <dt>{t('viewer.definitionUnit')}</dt>
            <dd>{t(`units.${widget.definition.unit}`)}</dd>
            <dt>{t('viewer.definitionScope')}</dt>
            <dd>{t(`scopesSemantic.${widget.definition.scope}`)}</dd>
          </dl>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The non-ready states, as text.
 *
 * `empty`, `missing`, `not_tracked` and `unavailable` read differently on
 * purpose: conflating them is exactly what the state model exists to prevent.
 */
async function WidgetStateMessage({ widget }: { readonly widget: WidgetPresentation }) {
  const t = await getTranslations();

  const message = widget.unavailable
    ? tryTranslate(t, widget.unavailable.messageKey, widget.unavailable.messageParams)
    : t(`states.${stateKey(widget.state)}`);

  const action = widget.unavailable?.actionKey
    ? tryTranslate(t, widget.unavailable.actionKey)
    : null;

  // The reason the source gave, beneath the state word: "Nicht erfasst", and
  // then why (D10). Omitted rather than guessed when there is none.
  const reason =
    widget.stateMessage && t.has(widget.stateMessage.messageKey)
      ? t(widget.stateMessage.messageKey, widget.stateMessage.messageParams as never)
      : null;

  return (
    <div className={styles.state} data-state={widget.state}>
      <span className={styles.stateLabel}>{message}</span>
      {reason ? <span className={styles.stateReason}>{reason}</span> : null}
      {action ? <span className={styles.stateAction}>{action}</span> : null}
    </div>
  );
}

function stateKey(state: WidgetPresentation['state']): string {
  switch (state) {
    case 'not_applicable':
      return 'notApplicable';
    case 'not_tracked':
      return 'notTracked';
    default:
      return state;
  }
}

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/** Falls back to a generic message rather than printing a raw key. */
function tryTranslate(
  t: Translator,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return t.has(key) ? t(key, params as never) : t('states.unavailable');
}
