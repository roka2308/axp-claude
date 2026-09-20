import { describe, expect, it } from 'vitest';
import { GRID_COLUMNS, type GridPlacement, type WidgetConfig } from '@axp/contracts';
import {
  applyPlacement,
  clampToGrid,
  clearOverride,
  findFreeSlot,
  hasOverride,
  overlaps,
  placeNewWidget,
  readingOrder,
  resolveLayout,
  resolveOverlaps,
  resolveResponsiveLayout,
  scaleWidth,
} from './layout';

/**
 * Gate F2 asks for two properties above all: the grid behaves deterministically
 * and widgets never overlap. These tests are written as those two properties
 * rather than as a tour of the API.
 */

function widget(
  id: string,
  family: WidgetConfig['family'],
  desktop: GridPlacement,
  overrides: Partial<Record<'tablet' | 'mobile', GridPlacement>> = {},
): WidgetConfig {
  return {
    id,
    family,
    title: id,
    placement: { desktop, ...overrides },
    data: { semanticVersionIds: [], fixedFilters: [] },
    presentation: { showComparison: false },
    context: { showDefinition: false },
  };
}

const card = (id: string, x: number, y: number, w = 3, h = 3) => widget(id, 'card', { x, y, w, h });

/** Every pair of placements in a layout, for the no-overlap invariant. */
function anyOverlap(placements: readonly GridPlacement[]): boolean {
  return placements.some((a, index) => placements.slice(index + 1).some((b) => overlaps(a, b)));
}

describe('the raster is binding', () => {
  it('snaps a placement onto whole cells', () => {
    expect(clampToGrid({ x: 2.4, y: 1.6, w: 3.2, h: 2.8 }, 'card', 12)).toEqual({
      x: 2,
      y: 2,
      w: 3,
      h: 3,
    });
  });

  it('keeps a widget inside the grid instead of refusing the move', () => {
    // A drag that ends past the edge should land at the edge: the raster is a
    // constraint on the result, not a reason to reject the gesture.
    expect(clampToGrid({ x: 11, y: 0, w: 4, h: 3 }, 'card', 12)).toMatchObject({ x: 8, w: 4 });
    expect(clampToGrid({ x: -3, y: -2, w: 3, h: 3 }, 'card', 12)).toMatchObject({ x: 0, y: 0 });
  });

  it('holds a widget to its family minimum', () => {
    // A time series below four columns stops being a time series.
    expect(clampToGrid({ x: 0, y: 0, w: 1, h: 1 }, 'time_series', 12)).toMatchObject({
      w: 4,
      h: 3,
    });
  });

  it('lets a minimum wider than the breakpoint become full width', () => {
    // On a four-column phone a table cannot have its six-column minimum; the
    // rule exists to keep it readable, not to push it off the screen.
    expect(clampToGrid({ x: 0, y: 0, w: 4, h: 3 }, 'flexible_table', 4)).toMatchObject({
      x: 0,
      w: 4,
    });
  });
});

describe('widgets never overlap', () => {
  it('pushes a displaced widget down, never sideways', () => {
    // Moving B onto A must not shuffle the layout horizontally: a sideways
    // push would change the reading order of rows nobody touched.
    const layout = resolveOverlaps(
      [
        { id: 'a', family: 'card', placement: { x: 0, y: 0, w: 3, h: 3 } },
        { id: 'b', family: 'card', placement: { x: 0, y: 0, w: 3, h: 3 } },
      ],
      'b',
    );

    const b = layout.find((item) => item.id === 'b')!;
    const a = layout.find((item) => item.id === 'a')!;
    expect(b.placement).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    expect(a.placement).toMatchObject({ x: 0, y: 3 });
  });

  it('cascades a push through everything it reaches', () => {
    const layout = resolveOverlaps(
      [
        { id: 'a', family: 'card', placement: { x: 0, y: 0, w: 3, h: 3 } },
        { id: 'b', family: 'card', placement: { x: 0, y: 3, w: 3, h: 3 } },
        { id: 'c', family: 'card', placement: { x: 0, y: 0, w: 3, h: 3 } },
      ],
      'c',
    );

    expect(anyOverlap(layout.map((item) => item.placement))).toBe(false);
    expect(layout.find((item) => item.id === 'c')!.placement.y).toBe(0);
  });

  it('leaves a layout that already fits completely alone', () => {
    const original = [
      { id: 'a', family: 'card' as const, placement: { x: 0, y: 0, w: 3, h: 3 } },
      { id: 'b', family: 'card' as const, placement: { x: 3, y: 0, w: 3, h: 3 } },
      { id: 'c', family: 'card' as const, placement: { x: 0, y: 9, w: 3, h: 3 } },
    ];

    // Including the gap between rows 3 and 9: an empty row is a layout
    // decision, and the engine does not argue with it (ADR 0004).
    expect(resolveOverlaps(original)).toEqual(readingOrder(original));
  });

  it('never produces an overlap, whatever it is given', () => {
    // A deliberately hostile layout: everything stacked on one cell.
    const piled = Array.from({ length: 12 }, (_, index) => ({
      id: `w${index}`,
      family: 'card' as const,
      placement: { x: 0, y: 0, w: 4, h: 2 },
    }));

    const layout = resolveOverlaps(piled);
    expect(layout).toHaveLength(12);
    expect(anyOverlap(layout.map((item) => item.placement))).toBe(false);
  });
});

describe('the grid is deterministic', () => {
  it('produces the same layout regardless of input order', () => {
    const widgets = [card('a', 0, 0), card('b', 3, 0), card('c', 6, 0), card('d', 0, 3)];
    const shuffled = [widgets[3]!, widgets[1]!, widgets[0]!, widgets[2]!];

    expect(resolveLayout(shuffled, 'tablet')).toEqual(resolveLayout(widgets, 'tablet'));
    expect(resolveLayout(shuffled, 'mobile')).toEqual(resolveLayout(widgets, 'mobile'));
  });

  it('breaks a tie by id rather than by chance', () => {
    // Two widgets on the same cell have no reading order of their own; the id
    // gives them one, so repeated runs cannot disagree.
    const first = readingOrder([
      { id: 'b', family: 'card', placement: { x: 0, y: 0, w: 3, h: 3 } },
      { id: 'a', family: 'card', placement: { x: 0, y: 0, w: 3, h: 3 } },
    ]);
    expect(first.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('repeats itself exactly on the same input', () => {
    const widgets = [card('a', 0, 0), card('b', 2, 1), card('c', 5, 0)];
    const once = applyPlacement(widgets, 'b', { x: 0, y: 0, w: 3, h: 3 }, 'desktop');
    const twice = applyPlacement(widgets, 'b', { x: 0, y: 0, w: 3, h: 3 }, 'desktop');
    expect(once).toEqual(twice);
  });
});

describe('tablet and mobile are derived', () => {
  const widgets = [
    card('kpi-1', 0, 0),
    card('kpi-2', 3, 0),
    widget('trend', 'time_series', { x: 6, y: 0, w: 6, h: 5 }),
    widget('table', 'flexible_table', { x: 0, y: 3, w: 6, h: 5 }),
  ];

  it('scales width onto the narrower raster', () => {
    expect(scaleWidth({ x: 0, y: 0, w: 6, h: 5 }, 'time_series', GRID_COLUMNS.tablet)).toBe(4);
    expect(scaleWidth({ x: 0, y: 0, w: 3, h: 3 }, 'card', GRID_COLUMNS.tablet)).toBe(2);
  });

  it('stacks rather than shrinks on a phone', () => {
    // Below its minimum a chart is not a smaller chart, it is an unreadable
    // one - so it takes the full four columns instead.
    const mobile = resolveLayout(widgets, 'mobile');
    expect(mobile.get('trend')).toMatchObject({ x: 0, w: 4 });
    expect(mobile.get('table')).toMatchObject({ x: 0, w: 4 });
  });

  it('keeps every derived layout free of overlaps and inside the raster', () => {
    for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
      const layout = [...resolveLayout(widgets, breakpoint).values()];
      expect(anyOverlap(layout), breakpoint).toBe(false);
      for (const placement of layout) {
        expect(placement.x + placement.w, breakpoint).toBeLessThanOrEqual(GRID_COLUMNS[breakpoint]);
      }
    }
  });

  it('preserves reading order when deriving', () => {
    const mobile = resolveLayout(widgets, 'mobile');
    const order = [...mobile.entries()]
      .sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)
      .map(([id]) => id);

    expect(order).toEqual(['kpi-1', 'kpi-2', 'trend', 'table']);
  });

  it('resolves all three breakpoints for every widget', () => {
    const all = resolveResponsiveLayout(widgets);
    expect(all.size).toBe(widgets.length);
    for (const placements of all.values()) {
      expect(Object.keys(placements).sort()).toEqual(['desktop', 'mobile', 'tablet']);
    }
  });
});

describe('breakpoint overrides', () => {
  const widgets = [
    card('a', 0, 0),
    card('b', 3, 0),
    widget('c', 'card', { x: 6, y: 0, w: 3, h: 3 }, { mobile: { x: 0, y: 0, w: 4, h: 2 } }),
  ];

  it('anchors an override and flows the derived widgets around it', () => {
    const mobile = resolveLayout(widgets, 'mobile');

    // The override stays exactly where it was put...
    expect(mobile.get('c')).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    // ...and nothing collides with it.
    expect(anyOverlap([...mobile.values()])).toBe(false);
    expect(mobile.get('a')!.y).toBeGreaterThanOrEqual(2);
  });

  it('leaves the other breakpoints untouched', () => {
    expect(resolveLayout(widgets, 'desktop').get('c')).toEqual({ x: 6, y: 0, w: 3, h: 3 });
    expect(resolveLayout(widgets, 'tablet').get('c')).toMatchObject({ w: 2 });
  });

  it('stores an override only where the user made one', () => {
    expect(hasOverride(widgets[2]!, 'mobile')).toBe(true);
    expect(hasOverride(widgets[2]!, 'tablet')).toBe(false);
    // Desktop is the authored layout, not a derivation, so it is never an
    // "override" and can never be reset.
    expect(hasOverride(widgets[0]!, 'desktop')).toBe(false);
  });

  it('returns a widget to the derived layout when the override is cleared', () => {
    const reset = clearOverride(widgets[2]!, 'mobile');
    expect(reset.placement.mobile).toBeUndefined();

    // Back to derivation: a three-column card scales to two on a phone, so
    // the cards sit two per row and `c` starts the second one.
    const mobile = resolveLayout([widgets[0]!, widgets[1]!, reset], 'mobile');
    expect(mobile.get('c')).toEqual({ x: 0, y: 3, w: 2, h: 3 });
    expect(anyOverlap([...mobile.values()])).toBe(false);
  });

  it('refuses to reset desktop, because there is nothing to derive it from', () => {
    expect(clearOverride(widgets[0]!, 'desktop')).toEqual(widgets[0]);
  });
});

describe('editing a placement', () => {
  const widgets = [card('a', 0, 0), card('b', 3, 0), card('c', 6, 0)];

  it('moves the edited widget exactly where it was put', () => {
    const { widgets: next } = applyPlacement(widgets, 'c', { x: 0, y: 0, w: 3, h: 3 }, 'desktop');
    expect(next.find((w) => w.id === 'c')!.placement.desktop).toEqual({ x: 0, y: 0, w: 3, h: 3 });
  });

  it('reports what it displaced, so the editor can say so', () => {
    const { displacedIds } = applyPlacement(widgets, 'c', { x: 0, y: 0, w: 3, h: 3 }, 'desktop');
    expect(displacedIds).toEqual(['a']);
  });

  it('displaces nothing when the move fits', () => {
    const { widgets: next, displacedIds } = applyPlacement(
      widgets,
      'c',
      { x: 0, y: 6, w: 3, h: 3 },
      'desktop',
    );
    expect(displacedIds).toEqual([]);
    expect(next.find((w) => w.id === 'a')!.placement.desktop).toEqual({ x: 0, y: 0, w: 3, h: 3 });
  });

  it('enforces the size rules on a resize', () => {
    const { widgets: next } = applyPlacement(widgets, 'a', { x: 0, y: 0, w: 1, h: 1 }, 'desktop');
    expect(next.find((w) => w.id === 'a')!.placement.desktop).toMatchObject({ w: 2, h: 2 });
  });

  it('writes an override when the edit happens at a derived breakpoint', () => {
    const { widgets: next } = applyPlacement(widgets, 'b', { x: 0, y: 0, w: 4, h: 2 }, 'mobile');

    const edited = next.find((w) => w.id === 'b')!;
    expect(edited.placement.mobile).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    // The authored desktop layout is untouched by a mobile edit.
    expect(edited.placement.desktop).toEqual({ x: 3, y: 0, w: 3, h: 3 });
  });

  it('records a displacement at a derived breakpoint as an override too', () => {
    // The widget was moved by a deliberate action; re-deriving it later would
    // contradict what the user is looking at.
    const { widgets: next, displacedIds } = applyPlacement(
      widgets,
      'c',
      { x: 0, y: 0, w: 4, h: 2 },
      'mobile',
    );

    expect(displacedIds.length).toBeGreaterThan(0);
    for (const id of displacedIds) {
      expect(next.find((w) => w.id === id)!.placement.mobile).toBeDefined();
    }
  });

  it('ignores an edit to a widget that is not there', () => {
    expect(applyPlacement(widgets, 'ghost', { x: 0, y: 0, w: 3, h: 3 }, 'desktop').widgets).toBe(
      widgets,
    );
  });
});

describe('placing a new widget', () => {
  it('fills a gap before starting a new row', () => {
    const occupied = [
      { id: 'a', family: 'card' as const, placement: { x: 0, y: 0, w: 3, h: 3 } },
      { id: 'b', family: 'card' as const, placement: { x: 6, y: 0, w: 3, h: 3 } },
    ];
    expect(findFreeSlot(occupied, { w: 3, h: 3 }, 12)).toEqual({ x: 3, y: 0, w: 3, h: 3 });
  });

  it('starts a new row when nothing fits between the widgets', () => {
    const occupied = [{ id: 'a', family: 'card' as const, placement: { x: 0, y: 0, w: 12, h: 3 } }];
    expect(findFreeSlot(occupied, { w: 6, h: 4 }, 12)).toEqual({ x: 0, y: 3, w: 6, h: 4 });
  });

  it('arrives at the recommended size, not the minimum', () => {
    // A widget that shows up too small to read teaches the wrong thing about
    // the family it belongs to.
    expect(placeNewWidget([], 'time_series')).toMatchObject({ w: 6, h: 5 });
    expect(placeNewWidget([], 'card')).toMatchObject({ w: 3, h: 3 });
  });

  it('lands below what is already there rather than on top of it', () => {
    const widgets = [card('a', 0, 0), card('b', 3, 0), card('c', 6, 0), card('d', 9, 0)];
    const placement = placeNewWidget(widgets, 'time_series');

    expect(widgets.some((existing) => overlaps(existing.placement.desktop, placement))).toBe(false);
  });
});
