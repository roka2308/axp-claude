import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import type { WidgetShell } from '@axp/contracts';
import { WidgetFrame } from '@/components/widgets/WidgetFrame';
import { WidgetContent } from '@/components/widgets/WidgetContent';
import { getWidgetTile, type PresentationQuery } from '@/lib/analytics';
import styles from './WidgetTile.module.css';

export interface WidgetTileProps {
  readonly dashboardId: string;
  readonly shell: WidgetShell;
  readonly query: PresentationQuery;
  readonly detailHref: Route;
}

/**
 * One widget, fetching its own values (Master Spec §11).
 *
 * Each tile is its own async boundary, so the grid appears immediately and each
 * widget resolves when its own query does. A slow metric delays one tile; a
 * failing one produces one tile in a stated state, not a broken dashboard.
 *
 * The request is separate from the layout's rather than sliced out of a single
 * response, because independence that only exists in the rendering is not
 * independence: the slowest query would still gate the first paint.
 */
export async function WidgetTile({ dashboardId, shell, query, detailHref }: WidgetTileProps) {
  let widget;
  try {
    widget = await getWidgetTile(dashboardId, shell.widgetId, query);
  } catch {
    /*
     * The transport failed - the API is unreachable, or it refused. Either way
     * this is one tile's problem, and it reports it in the vocabulary every
     * other tile uses rather than as an exception that takes the page with it.
     */
    widget = {
      ...shell,
      state: 'unavailable' as const,
      unavailable: {
        causeState: 'temporarily_unavailable' as const,
        messageKey: 'widget.source_unavailable',
        actionKey: 'widget.source_unavailable_action',
      },
      dataQuality: [],
    };
  }

  return (
    <WidgetFrame widget={widget} detailHref={detailHref}>
      <WidgetContent widget={widget} />
    </WidgetFrame>
  );
}

/**
 * What a tile looks like while its query is still running (D10 `loading`).
 *
 * Says so in words as well as in shape. A shimmer alone tells a screen-reader
 * user nothing, and the state model requires loading to be a state rather than
 * an absence of one.
 */
export async function WidgetTileSkeleton({ shell }: { readonly shell: WidgetShell }) {
  const t = await getTranslations();

  return (
    <section className={styles.skeleton} aria-label={shell.title} aria-busy="true">
      <h3 className={styles.title}>{shell.title}</h3>
      <p className={styles.state} data-state="loading" role="status">
        {t('states.loading')}
      </p>
      <span className={styles.bar} aria-hidden="true" />
      <span className={styles.barShort} aria-hidden="true" />
    </section>
  );
}
