'use client';

import type React from 'react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  applyPlacement,
  type Breakpoint,
  type DashboardSnapshot,
  GRID_COLUMNS,
  type GridPlacement,
  resolveLayout,
  type WidgetConfig,
  WIDGET_SIZE_RULES,
} from '@axp/contracts';
import styles from './EditorCanvas.module.css';

export interface EditorCanvasProps {
  readonly snapshot: DashboardSnapshot;
  readonly breakpoint: Breakpoint;
  readonly selectedId: string | null;
  readonly onSelect: (widgetId: string | null) => void;
  readonly onChange: (snapshot: DashboardSnapshot) => void;
}

type Gesture = {
  readonly kind: 'move' | 'resize';
  readonly widgetId: string;
  readonly startX: number;
  readonly startY: number;
  readonly origin: GridPlacement;
};

/** Row height in pixels, matching `--grid-row-height` in the design tokens. */
const ROW_HEIGHT = 80;

const KEY_STEPS: Record<string, { x: number; y: number } | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The authoring canvas (D2, D3).
 *
 * Canvas-first: the dashboard is the page, and everything else is beside it.
 * Dragging snaps to the raster as it goes, so the preview during a gesture is
 * the layout that will be committed - no settling jump on release.
 *
 * Pointer events rather than HTML drag-and-drop: HTML5 DnD has no useful
 * preview, no touch support worth the name, and no way to show a snapped
 * position mid-gesture.
 *
 * Every gesture has a keyboard equivalent: arrow keys move the focused widget,
 * Shift+arrow resizes it, and the Inspector offers the same as numbers. Not a
 * fallback - the same engine, the same rules, the same result (D2, D10).
 */
export function EditorCanvas({
  snapshot,
  breakpoint,
  selectedId,
  onSelect,
  onChange,
}: EditorCanvasProps) {
  const t = useTranslations('editor');
  const gridRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [preview, setPreview] = useState<DashboardSnapshot | null>(null);

  const columns = GRID_COLUMNS[breakpoint];
  const shown = preview ?? snapshot;
  const layout = resolveLayout(shown.widgets, breakpoint);

  /** Pixels per cell, measured rather than assumed: the grid is fluid. */
  function cellSize() {
    const rect = gridRef.current?.getBoundingClientRect();
    const gap = 16;
    const width = rect ? (rect.width - gap * (columns - 1)) / columns : 80;
    return { width: Math.max(width, 1), height: ROW_HEIGHT + gap };
  }

  function beginGesture(
    event: ReactPointerEvent<HTMLElement>,
    kind: Gesture['kind'],
    widget: WidgetConfig,
  ) {
    // Left button only, and never a gesture started on a control inside.
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    onSelect(widget.id);
    setGesture({
      kind,
      widgetId: widget.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: layout.get(widget.id)!,
    });
  }

  function duringGesture(event: ReactPointerEvent<HTMLElement>) {
    if (!gesture) return;

    const { width, height } = cellSize();
    const dx = Math.round((event.clientX - gesture.startX) / width);
    const dy = Math.round((event.clientY - gesture.startY) / height);

    const target: GridPlacement =
      gesture.kind === 'move'
        ? { ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy }
        : { ...gesture.origin, w: gesture.origin.w + dx, h: gesture.origin.h + dy };

    // The preview is the real engine output, not an approximation: what the
    // user sees mid-drag is exactly what release will commit.
    const { widgets } = applyPlacement(shown.widgets, gesture.widgetId, target, breakpoint);
    setPreview({ ...snapshot, widgets });
  }

  function endGesture() {
    if (!gesture) return;
    if (preview) onChange(preview);
    setGesture(null);
    setPreview(null);
  }

  /**
   * The keyboard path, and not a lesser one (D2, D10).
   *
   * Arrow keys move by a cell, Shift+arrow resizes by a cell. Same engine, same
   * rules, same result as the pointer gesture - someone who cannot aim a mouse
   * at a 16px grip is not doing a reduced version of the task.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>, widget: WidgetConfig) {
    const step = KEY_STEPS[event.key];
    if (!step) return;

    event.preventDefault();
    const origin = layout.get(widget.id)!;
    const target: GridPlacement = event.shiftKey
      ? { ...origin, w: origin.w + step.x, h: origin.h + step.y }
      : { ...origin, x: origin.x + step.x, y: origin.y + step.y };

    const { widgets } = applyPlacement(shown.widgets, widget.id, target, breakpoint);
    onChange({ ...snapshot, widgets });
  }

  return (
    <div
      className={styles.canvas}
      data-breakpoint={breakpoint}
      onPointerDown={(event) => {
        // A click on the canvas background deselects, which is how the
        // Inspector returns to dashboard settings.
        if (event.target === event.currentTarget) onSelect(null);
      }}
    >
      <div
        ref={gridRef}
        className={styles.grid}
        style={{ '--editor-columns': String(columns) } as CSSProperties}
      >
        {shown.widgets.map((widget) => {
          const placement = layout.get(widget.id);
          if (!placement) return null;

          const selected = widget.id === selectedId;
          const style = {
            '--widget-x': String(placement.x + 1),
            '--widget-y': String(placement.y + 1),
            '--widget-w': String(placement.w),
            '--widget-h': String(placement.h),
          } as CSSProperties;

          return (
            <div
              key={widget.id}
              className={styles.cell}
              style={style}
              data-selected={selected || undefined}
              data-dragging={gesture?.widgetId === widget.id || undefined}
            >
              {/*
                The widget itself is a button: selecting is a click, and the
                same control is reachable by Tab. Dragging is an enhancement on
                top, never the only way in.
              */}
              <button
                type="button"
                className={styles.handle}
                onPointerDown={(event) => beginGesture(event, 'move', widget)}
                onPointerMove={duringGesture}
                onPointerUp={endGesture}
                onPointerCancel={endGesture}
                onClick={() => onSelect(widget.id)}
                // Selection follows focus, so the Inspector tracks the keyboard
                // exactly as it tracks the pointer. Without this a keyboard user
                // can move a widget but never see its settings.
                onFocus={() => onSelect(widget.id)}
                onKeyDown={(event) => onKeyDown(event, widget)}
                aria-pressed={selected}
                aria-describedby={`${widget.id}-hint`}
              >
                <span className={styles.widgetTitle}>{widget.title}</span>
                <span className={styles.widgetFamily}>{t(`family.${widget.family}`)}</span>
                <span className={styles.widgetSize}>
                  {t('sizeLabel', { w: placement.w, h: placement.h })}
                </span>
              </button>

              {/* Announced on focus, so the keyboard path is discoverable. */}
              <span id={`${widget.id}-hint`} className={styles.srOnly}>
                {t('keyboardHint')}
              </span>

              {/*
                Resize grip. Hidden from assistive technology on purpose: it is
                a pointer affordance, and the keyboard path is the dialog, not a
                grip nobody can aim at.
              */}
              <span
                className={styles.resize}
                aria-hidden="true"
                onPointerDown={(event) => beginGesture(event, 'resize', widget)}
                onPointerMove={duringGesture}
                onPointerUp={endGesture}
                onPointerCancel={endGesture}
              />
            </div>
          );
        })}
      </div>

      {shown.widgets.length === 0 ? <p className={styles.empty}>{t('canvasEmpty')}</p> : null}
    </div>
  );
}

/** Size limits for a family, for the dialog's min/max attributes. */
export function sizeRulesFor(widget: WidgetConfig, breakpoint: Breakpoint) {
  const rules = WIDGET_SIZE_RULES[widget.family];
  const columns = GRID_COLUMNS[breakpoint];
  return { ...rules, minW: Math.min(rules.minW, columns), maxW: columns };
}
