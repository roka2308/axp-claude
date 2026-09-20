# ADR 0004 — The grid resolves overlaps but never compacts a layout

- Status: accepted
- Date: 2026-09-20
- Milestone: F2
- Specification reference: D2, Master Spec §20, Gate F2

## Context

D2 is binding: a 12/8/4 raster, snap-to-grid, grid-based resize, no free
canvas, **no overlaps**, desktop-first with derived tablet and mobile layouts
plus breakpoint overrides.

Most grid libraries in this space (react-grid-layout and its descendants)
couple two behaviours that are not the same thing: preventing overlaps, and
pulling every widget upwards to close vertical gaps. The second is usually on
by default and is what makes those grids feel "springy".

D2 requires the first. It says nothing about the second, and Gate F2 asks only
that grid behaviour be deterministic and free of overlaps.

## Decision

The grid engine (`packages/core/src/dashboard/layout.ts`) resolves overlaps and
nothing else.

- **Overlap resolution** pushes widgets down, never sideways, and by exactly
  the overlap. The widget the user is holding has priority and stays where it
  was put; everything else yields to it, cascading.
- **No vertical compaction.** An empty row stays empty. Deleting a widget
  leaves a hole, and the hole stays until someone fills it.
- **Derivation** for tablet and mobile scales width proportionally, holds it to
  the family minimum, and places widgets in reading order with first fit.
  Heights are not scaled.
- **Overrides are anchors.** A stored override keeps its exact position and the
  derived widgets flow around it. Only overrides are stored, so resetting one
  is a field deletion.

Every function is pure and total: same input, same layout, regardless of the
order the widgets arrive in. Ties in reading order are broken by widget id.

## Consequences

Positive:

- The layout a user builds is the layout they get. Dragging a widget down to
  separate two groups does not snap it back.
- "Deterministic" in Gate F2 is a property we can test rather than an
  observation about one run. The tie-break by id is what makes it true.
- No dependency on a grid library, so the raster rules live in one readable
  file that both the editor and the viewer read, and the Emergent track can be
  compared against the same rules rather than against a library's defaults.

Negative:

- A layout can drift into something gap-ridden, and the product offers no
  "tidy up" action to fix it in one click. If that turns out to matter, the
  answer is an explicit command the user invokes — not an engine that
  rearranges their work while they are not looking.
- Deriving with first fit can place a narrow widget beside a tall one in a way
  a human would not have chosen. Breakpoint overrides exist for exactly that
  case, and the editor makes them one action.

## Alternatives considered

**Adopt react-grid-layout with `verticalCompact`.** Rejected: it would have
decided D2's open question by importing a default, the compaction is hard to
switch off convincingly once users rely on the springy feel, and the accessible
non-drag alternative D2 requires would still have had to be built by hand.

**Compact on publish only.** Rejected: the editor would then show a different
layout than the viewer, which contradicts D3's rule that preview renders
through the same presentation path.
