import type { CSSProperties, ReactNode } from 'react';
import type { WidgetPresentation } from '@axp/contracts';
import styles from './DashboardGrid.module.css';

export interface DashboardGridProps {
  readonly widgets: readonly WidgetPresentation[];
  readonly renderWidget: (widget: WidgetPresentation) => ReactNode;
}

/**
 * Places widgets on the 12/8/4 raster.
 *
 * Desktop uses the authored placement. Tablet and mobile are derived here
 * rather than stored, which is what makes "reset to automatic" trivial: there
 * is nothing to delete (D2).
 *
 * Widgets are emitted in reading order - top to bottom, then left to right -
 * so the derived layouts and the tab order both follow what a reader expects.
 */
export function DashboardGrid({ widgets, renderWidget }: DashboardGridProps) {
  const ordered = [...widgets].sort((a, b) => {
    const rowDelta = a.placement.desktop.y - b.placement.desktop.y;
    return rowDelta !== 0 ? rowDelta : a.placement.desktop.x - b.placement.desktop.x;
  });

  return (
    <div className={styles.grid}>
      {ordered.map((widget) => {
        const { x, y, w, h } = widget.placement.desktop;
        // Grid lines are 1-based; placements are 0-based.
        const style = {
          '--widget-x': String(x + 1),
          '--widget-y': String(y + 1),
          '--widget-w': String(w),
          '--widget-h': String(h),
        } as CSSProperties;

        return (
          <div key={widget.widgetId} className={styles.cell} style={style}>
            {renderWidget(widget)}
          </div>
        );
      })}
    </div>
  );
}
