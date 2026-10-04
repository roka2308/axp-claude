# Claude Code — repository instructions

This repository is **Track A (Claude Code)**, the canonical engineering track of
the Analytics Experience Platform. The product specification lives in
`../analytics_experience_version_d_v1.0/` and is authoritative; this repository
implements it.

Read before changing anything substantial:

1. `../analytics_experience_version_d_v1.0/01_Version_D_Master_Specification_v1.0.md`
2. `../analytics_experience_version_d_v1.0/02_Shared_Product_Engineering_Contract_v1.0.md`
3. `../analytics_experience_version_d_v1.0/03_Claude_Code_Development_Plan_v1.0.md`
4. `../analytics_experience_version_d_v1.0/acceptance/acceptance_checklist.md`
5. `docs/adr/` — decisions already taken here

Current milestone: **Phase 10 — MVP Hardening and Acceptance**. Phases 0–9
are complete and their gates are demonstrated
(`npm run gate:f0|…|f9`, see `docs/gates/`). Data access needs a
role capability and an object grant (ADR 0006) — a new data path must check
both. Solution packages are untrusted declarative data (ADR 0008). Shares lend
their creator's access and exports are ephemeral encrypted files; anything
built for an audience outside the product uses the `external` or `export`
presentation audience, which drops internal notes (ADR 0009). Background work
goes through the durable job queue with ids-only payloads; attention kinds are
a closed operational list (ADR 0010). A theme is a map of allowlisted tokens
to validated values - never free CSS - and publishing is blocked by failing
contrast; a missing entitlement is its own state (`entitlement_required`),
never a permission error, and never deletes configuration (ADR 0011). Still open
from earlier phases: the Inspector cannot yet pick a catalog definition per
widget, and annotations have no store. Gate criteria are in the development
plan.

## Non-negotiable invariants

Breaking one of these blocks MVP acceptance. They are not trade-offs.

- Matomo is the only persistent analytics data store. MySQL holds product
  configuration only — never analytics result sets, visit/action raw data or
  Matomo API payloads. Adding such a table requires a deviation record, and
  `tests/integration/persistence-rules.test.ts` will fail until the expected
  table list is updated deliberately.
- The browser never receives Matomo credentials and never queries Matomo.
- Tenant isolation is enforced server-side. Tenant and project ids from the
  browser are resolved and authorized independently, never trusted.
- Exactly five additive, non-hierarchical system roles. No role grants
  automatic analytics data access; object grants are separate.
- Tenant Admin can never assign Platform Admin.
- Published dashboards are immutable snapshots; editing happens in a draft.
- Semantic business definitions and technical source mappings are separate,
  independently versioned concepts.
- Missing, unknown and unavailable are never rendered as numeric zero. Use
  `valueEnvelope` from `@axp/contracts`; it refuses to coerce.
- Permission, entitlement, capability and setup are distinct states with
  distinct UI surfaces — never one generic error page.
- Formulas are a validated AST. No SQL, JavaScript, regex or arbitrary code,
  and solution packages never carry executable content.
- D1 navigation only. Do not invent Search/Interests, Funnel/Processes,
  analytics alerts, a generic data explorer or a marketplace.
- Accessibility is an MVP requirement: keyboard operation, visible focus, no
  colour-only information, chart data alternatives, a non-drag alternative to
  grid move/resize, reduced motion.

## Working method

- Inspect existing code before introducing a new abstraction.
- Implement one milestone at a time. Do not start a later milestone before the
  current gate is demonstrably met.
- Prefer a few meaningful module boundaries over many packages.
- Migrations are deterministic and committed. Generate them with
  `npm run db:generate`; never push schema changes directly to a database.
- Add tests at the layer where the behaviour lives: unit for pure logic,
  integration against real MySQL for persistence and authorization, Playwright
  for journeys.
- Record an ADR in `docs/adr/` for real architecture decisions.
- Record a deviation in `DEVIATIONS.md` instead of silently changing a
  requirement.
- Before declaring a milestone complete, run `npm run verify` and demonstrate
  the gate against the canonical fixtures.

## Conventions

- Domain vocabulary comes from `@axp/contracts`. Renaming a term there is a
  contract change and needs an ADR — the Emergent track uses the same names.
- Time: never call `new Date()` in product code. Inject `Clock` from
  `@axp/core`; an ESLint rule enforces this. All system timestamps are UTC.
- Errors: throw `AppError` with a category and an i18n message key. Raw vendor
  or driver text never reaches a client.
- Logging: `@axp/observability` sanitises every record. Do not bypass it, and
  do not log analytics values or credentials — the guard exists because that is
  an acceptance criterion, not a style preference.
- The web app must not import `@axp/core` or `@axp/db`; it calls the API. The
  ESLint boundary rule will fail the build.
- UI components consume design tokens only. No hard-coded colours, spacing or
  fonts — tenant theming depends on it.
- Both UI languages are first-class: every user-facing string goes into
  `apps/web/src/messages/de.json` and `en.json`.

## Cross-track discipline

The Emergent track implements the same specification independently. Same
contracts, same canonical fixtures, same acceptance checklist; separate code and
databases. When this track needs to differ, write the deviation first and
classify it — the comparison gates depend on both tracks describing the same
product.
