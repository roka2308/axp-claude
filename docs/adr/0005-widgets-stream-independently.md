# ADR 0005 — Widgets stream independently: layout first, one request per tile

- Status: accepted
- Date: 2026-09-27
- Milestone: F4
- Specification reference: D4 (Master Spec §11), D10, Gate F4

## Context

Master Spec §11: "Widgets laden und scheitern unabhängig voneinander." Until
Phase 4 the viewer called one endpoint, `GET /dashboards/:id/presentation`,
which built every widget server-side before answering. Failures were already
isolated (`Promise.allSettled`, one widget in `unavailable`), but loading was
not: the page waited for the slowest metric, and the `loading` state of D10
existed in the type union without ever reaching a viewer. Gate F4 requires
all D10 states to be demonstrable, and `loading` is one of them.

## Decision

The viewer asks for a dashboard in two stages:

1. `GET /dashboards/:id/layout` — meta, time range, data scope and a _shell_
   per widget (id, family, title, placement). Built from the stored snapshot
   alone; it asks Matomo nothing, so it is fast and cannot fail for a
   data-source reason.
2. `GET /dashboards/:id/widgets/:widgetId` — one widget's values. One request
   per tile, authorized and resolved exactly like the dashboard (a shared
   `resolveView` in the API).

The web page renders the grid from the layout and wraps each tile in its own
React `<Suspense>` boundary. Each boundary streams in when its own request
resolves; until then the tile shows a skeleton that says "Wird geladen" in
words and carries `aria-busy`. A tile whose request fails renders
`unavailable` in the same vocabulary as every other tile.

The detail view is a third route, `/widgets/:widgetId/detail`, reading the same
snapshot through the same builder.

`GET /dashboards/:id/presentation` stays. It is the whole presentation model in
one answer, which is what exports (Phase 7) read: an export must not depend on
a browser rendering anything.

## Consequences

- The first paint is the layout, regardless of how slow any metric is; a slow
  or failing report affects one tile.
- `loading` is a state viewers actually see, and the streamed document is the
  evidence: every fallback precedes every value in the response
  (`tests/e2e/viewer-detail.spec.ts`).
- More requests per dashboard view (one per widget, plus the layout). They are
  served by the same process and the same ephemeral analytics cache, and the
  per-tile requests run concurrently.
- React reveals streamed boundaries on the next animation frame. A client that
  never paints — a hidden or throttled tab, a headless renderer without frames
  — can leave tiles on their fallbacks although their content has arrived.
  Real browsers are unaffected (verified in Playwright, desktop and mobile);
  it is the reason exports keep the single-request route rather than rendering
  the viewer.

## Alternatives considered

- **Client-side fetching per widget.** Same independence, but the values would
  arrive only after hydration, the content would not be in the document for a
  reader without JavaScript, and the session token would have to reach client
  code. Rejected.
- **Suspense around slices of one server-side presentation.** Independence in
  the rendering only: the single request still gates everything, so the
  slowest query still decides the first paint. Rejected.
