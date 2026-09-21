import {
  type Breakpoint,
  BREAKPOINTS,
  GRID_COLUMNS,
  type GridPlacement,
  type ResponsivePlacement,
  type WidgetConfig,
  type WidgetFamily,
  WIDGET_SIZE_RULES,
} from './dashboard';

/**
 * The grid engine (D2, Master Spec §20).
 *
 * Three rules decide everything in this file:
 *
 *   - the raster is binding: 12 / 8 / 4 columns, integer cells, no free canvas;
 *   - widgets never overlap;
 *   - desktop is authored, tablet and mobile are derived unless a breakpoint
 *     override says otherwise.
 *
 * What this file deliberately does NOT do is compact layouts upwards. "No
 * overlaps" is a constraint; "no gaps" is a preference, and not the user's.
 * A row left empty is a layout decision, and an engine that silently closed it
 * would be arguing with the person who made it (see ADR 0004).
 *
 * Every function here is pure and deterministic: the same input always yields
 * the same layout, which is what Gate F2 asks to demonstrate.
 *
 * It lives in the contracts package rather than in the domain layer because
 * both sides need it: the API validates a layout with it, the editor moves
 * widgets with it in the browser, and the Emergent track implements the same
 * rules from the same description.
 */

export interface PlacedWidget {
  readonly id: string;
  readonly family: WidgetFamily;
  readonly placement: GridPlacement;
}

// --- primitives ------------------------------------------------------------

export function overlaps(a: GridPlacement, b: GridPlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Bottom edge of a placement, exclusive - the first free row below it. */
export function bottomOf(placement: GridPlacement): number {
  return placement.y + placement.h;
}

/**
 * Reading order: top to bottom, then left to right.
 *
 * The id breaks ties so the order is total. Without that, two widgets sharing
 * a cell corner could swap between runs and the "deterministic" in Gate F2
 * would be a coincidence.
 */
export function readingOrder<T extends PlacedWidget>(widgets: readonly T[]): T[] {
  return [...widgets].sort((a, b) => {
    if (a.placement.y !== b.placement.y) return a.placement.y - b.placement.y;
    if (a.placement.x !== b.placement.x) return a.placement.x - b.placement.x;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Forces a placement onto the raster and into the family's size rules.
 *
 * Both are hard constraints, so this clamps rather than rejects: a drag that
 * ends half outside the grid should land at the edge, not fail.
 */
export function clampToGrid(
  placement: GridPlacement,
  family: WidgetFamily,
  columns: number,
): GridPlacement {
  const rules = WIDGET_SIZE_RULES[family];

  // A minimum wider than the breakpoint itself becomes full width; the rule
  // exists to keep a widget readable, not to push it off a phone.
  const minW = Math.min(rules.minW, columns);
  const w = clamp(Math.round(placement.w), minW, columns);
  const h = Math.max(Math.round(placement.h), rules.minH);
  const x = clamp(Math.round(placement.x), 0, columns - w);
  const y = Math.max(Math.round(placement.y), 0);

  return { x, y, w, h };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// --- collision resolution --------------------------------------------------

/**
 * Removes overlaps by pushing widgets down, never sideways.
 *
 * Downward only, and by exactly the overlap: a sideways push would change the
 * reading order of a layout the user did not touch, and a larger push would
 * open gaps nobody asked for. `priorityId` is the widget the user is holding -
 * it stays where it was put and everything else yields to it.
 */
export function resolveOverlaps<T extends PlacedWidget>(
  widgets: readonly T[],
  priorityId?: string,
): T[] {
  const ordered = readingOrder(widgets);
  const priority = priorityId ? ordered.find((widget) => widget.id === priorityId) : undefined;
  const queue = priority ? [priority, ...ordered.filter((w) => w !== priority)] : ordered;

  const settled: T[] = [];
  for (const widget of queue) {
    let placement = widget.placement;

    // Walk down past everything already settled that this would overlap.
    // Each step moves strictly downwards, so this terminates.
    for (;;) {
      const blocker = settled.find((other) => overlaps(other.placement, placement));
      if (!blocker) break;
      placement = { ...placement, y: bottomOf(blocker.placement) };
    }

    settled.push(placement === widget.placement ? widget : { ...widget, placement });
  }

  return settled;
}

/**
 * The first free position for a widget of this size, scanning in reading order.
 *
 * Used when a widget is added from the gallery: it lands where a reader would
 * expect the next one to go, rather than on top of something.
 */
export function findFreeSlot(
  occupied: readonly PlacedWidget[],
  size: { w: number; h: number },
  columns: number,
): GridPlacement {
  const w = Math.min(size.w, columns);
  const lastRow = occupied.reduce((max, widget) => Math.max(max, bottomOf(widget.placement)), 0);

  for (let y = 0; y <= lastRow; y += 1) {
    for (let x = 0; x + w <= columns; x += 1) {
      const candidate = { x, y, w, h: size.h };
      if (!occupied.some((widget) => overlaps(widget.placement, candidate))) return candidate;
    }
  }

  // Nothing fits between the existing widgets: start a new row below them.
  return { x: 0, y: lastRow, w, h: size.h };
}

// --- responsive derivation -------------------------------------------------

/**
 * Scales a desktop placement onto a narrower raster.
 *
 * Width scales proportionally and is then held to the family minimum, which is
 * why a chart that is half the desktop width becomes full width on a phone:
 * below its minimum it stops being readable, and stacking beats shrinking.
 * Height is not scaled - a row is a row.
 */
export function scaleWidth(desktop: GridPlacement, family: WidgetFamily, columns: number): number {
  const scaled = Math.round((desktop.w * columns) / GRID_COLUMNS.desktop);
  const minW = Math.min(WIDGET_SIZE_RULES[family].minW, columns);
  return clamp(scaled, minW, columns);
}

/**
 * The layout for one breakpoint: stored overrides, and everything else derived.
 *
 * Overrides are anchors - they stay exactly where the user put them - and the
 * derived widgets flow around them in reading order. Only an override is ever
 * stored, so "reset to automatic" is a field deletion and not a recomputation
 * of somebody's guess (D2).
 */
export function resolveLayout(
  widgets: readonly WidgetConfig[],
  breakpoint: Breakpoint,
): Map<string, GridPlacement> {
  const columns = GRID_COLUMNS[breakpoint];
  const resolved = new Map<string, GridPlacement>();

  if (breakpoint === 'desktop') {
    for (const widget of widgets) {
      resolved.set(widget.id, clampToGrid(widget.placement.desktop, widget.family, columns));
    }
    return resolved;
  }

  const anchors: PlacedWidget[] = [];
  for (const widget of widgets) {
    const override = widget.placement[breakpoint];
    if (!override) continue;
    const placement = clampToGrid(override, widget.family, columns);
    anchors.push({ id: widget.id, family: widget.family, placement });
    resolved.set(widget.id, placement);
  }

  const placed = [...anchors];
  for (const widget of readingOrderByDesktop(widgets)) {
    if (resolved.has(widget.id)) continue;

    const w = scaleWidth(widget.placement.desktop, widget.family, columns);
    const h = Math.max(widget.placement.desktop.h, WIDGET_SIZE_RULES[widget.family].minH);
    const placement = findFreeSlot(placed, { w, h }, columns);

    resolved.set(widget.id, placement);
    placed.push({ id: widget.id, family: widget.family, placement });
  }

  return resolved;
}

/** Every breakpoint's layout at once, for a renderer that emits all three. */
export function resolveResponsiveLayout(
  widgets: readonly WidgetConfig[],
): Map<string, Record<Breakpoint, GridPlacement>> {
  const perBreakpoint = new Map(
    BREAKPOINTS.map((breakpoint) => [breakpoint, resolveLayout(widgets, breakpoint)] as const),
  );

  return new Map(
    widgets.map((widget) => [
      widget.id,
      {
        desktop: perBreakpoint.get('desktop')!.get(widget.id)!,
        tablet: perBreakpoint.get('tablet')!.get(widget.id)!,
        mobile: perBreakpoint.get('mobile')!.get(widget.id)!,
      },
    ]),
  );
}

function readingOrderByDesktop(widgets: readonly WidgetConfig[]): WidgetConfig[] {
  return readingOrder(
    widgets.map((widget) => ({
      id: widget.id,
      family: widget.family,
      placement: widget.placement.desktop,
    })),
  ).map((placed) => widgets.find((widget) => widget.id === placed.id)!);
}

// --- editing operations ----------------------------------------------------

export interface LayoutChange {
  readonly widgets: readonly WidgetConfig[];
  /** Widgets whose placement the operation moved, besides the one edited. */
  readonly displacedIds: readonly string[];
}

/**
 * Moves or resizes one widget and settles the consequences.
 *
 * At a non-desktop breakpoint the edit writes an override for the widget that
 * was touched. Anything the move displaces gets an override too - it was moved
 * by a deliberate action, and recording that is more honest than re-deriving a
 * position that no longer matches what the user sees.
 */
export function applyPlacement(
  widgets: readonly WidgetConfig[],
  widgetId: string,
  target: GridPlacement,
  breakpoint: Breakpoint,
): LayoutChange {
  const edited = widgets.find((widget) => widget.id === widgetId);
  if (!edited) return { widgets, displacedIds: [] };

  const columns = GRID_COLUMNS[breakpoint];
  const current = resolveLayout(widgets, breakpoint);

  const placed: PlacedWidget[] = widgets.map((widget) => ({
    id: widget.id,
    family: widget.family,
    placement:
      widget.id === widgetId
        ? clampToGrid(target, widget.family, columns)
        : current.get(widget.id)!,
  }));

  const settled = resolveOverlaps(placed, widgetId);
  const byId = new Map(settled.map((widget) => [widget.id, widget.placement]));

  const displacedIds = widgets
    .filter((widget) => widget.id !== widgetId)
    .filter((widget) => !samePlacement(current.get(widget.id)!, byId.get(widget.id)!))
    .map((widget) => widget.id);

  const touched = new Set([widgetId, ...displacedIds]);
  const next = widgets.map((widget) =>
    touched.has(widget.id) ? withPlacement(widget, breakpoint, byId.get(widget.id)!) : widget,
  );

  return { widgets: next, displacedIds };
}

/** Writes a placement for one breakpoint, as authored value or as override. */
export function withPlacement(
  widget: WidgetConfig,
  breakpoint: Breakpoint,
  placement: GridPlacement,
): WidgetConfig {
  const next: ResponsivePlacement =
    breakpoint === 'desktop'
      ? { ...widget.placement, desktop: placement }
      : { ...widget.placement, [breakpoint]: placement };

  return { ...widget, placement: next };
}

/**
 * Drops a breakpoint override, returning the widget to the derived layout.
 *
 * Desktop cannot be reset: it is the authored layout, not a derivation of
 * anything.
 */
export function clearOverride(widget: WidgetConfig, breakpoint: Breakpoint): WidgetConfig {
  if (breakpoint === 'desktop') return widget;

  const { [breakpoint]: _dropped, ...rest } = widget.placement;
  return { ...widget, placement: rest as ResponsivePlacement };
}

export function hasOverride(widget: WidgetConfig, breakpoint: Breakpoint): boolean {
  return breakpoint !== 'desktop' && widget.placement[breakpoint] !== undefined;
}

/**
 * Places a new widget at its recommended size, below what is already there.
 *
 * Recommended rather than minimum: a widget that arrives too small to read
 * teaches the wrong thing about the family it belongs to.
 */
export function placeNewWidget(
  widgets: readonly WidgetConfig[],
  family: WidgetFamily,
): GridPlacement {
  const rules = WIDGET_SIZE_RULES[family];
  const occupied: PlacedWidget[] = widgets.map((widget) => ({
    id: widget.id,
    family: widget.family,
    placement: widget.placement.desktop,
  }));

  return findFreeSlot(
    occupied,
    { w: rules.recommendedW, h: rules.recommendedH },
    GRID_COLUMNS.desktop,
  );
}

function samePlacement(a: GridPlacement, b: GridPlacement): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
