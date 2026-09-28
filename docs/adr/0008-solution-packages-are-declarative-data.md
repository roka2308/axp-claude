# ADR 0008 — Solution packages are declarative data, installed by analysis

Status: accepted
Date: 2026-09-28
Phase: 6 (Project Setup and Solution Packages)

## Context

A solution package carries semantic definitions, formulas, scores, evaluation
schemes, glossary, widget and dashboard templates and a context template from
one installation to another (Master Spec §14, §23). It is **untrusted input**:
it may come from any file a person uploads. It must never carry code,
analytics data, credentials, users or customer-specific ids, and installing it
must never silently overwrite anything or change a published dashboard.

## Decision

1. **Safety by shape, not by scanning.** Package schema version 1
   (`@axp/contracts/solution.ts`) is strict at every level: a key it does not
   name invalidates the whole package. There is no field that could hold code,
   SQL, a URL to fetch, a credential or a site/connection id, so there is
   nothing to sanitise. Formulas are the same controlled AST as everywhere
   else, with portable references. Size, depth and count ceilings are checked
   before parsing the content.
2. **Portable ids, resolved per project.** Everything inside refers to
   everything else by portable id. On install, references resolve against the
   target project: new definitions get new local ids, existing ones are
   reused. The installation records which local rows the portable ids became.
3. **Requirements, not sources.** A custom metric names a requirement in
   business words. Which report, event or dimension satisfies it is chosen at
   install time from what the target site offers (Gate F6: no hard-coded
   source ids).
4. **Analysis first, and again on install.** `analyze` runs the whole flow -
   validate, compatibility, dependencies, mapping, conflicts, preview -
   without writing. `install` runs it again on the server; the client is never
   trusted to have analysed the same thing.
5. **No silent overwrite.** A portable id the project already has is
   _identical_ (reused), _changed_ (the installer decides: keep what is there,
   or add the package's content as a **new version**) or _foreign_ (blocked).
   Published dashboards pin semantic versions, so a new version never reaches
   them.
6. **Copy-on-insert templates.** Templates live in four layers (global,
   solution, tenant, project). A dashboard or widget created from one is a
   copy pinned to the versions active at that moment; later template changes -
   by edit or by package update - reach no existing dashboard.
7. **Best-effort compensation instead of one transaction.** Installation uses
   the existing services (semantic catalog, templates, bindings), each with
   its own writes. Everything that can fail on content fails during analysis;
   the install undoes what it wrote, in reverse order, if a later step fails.

## Consequences

- Malicious payloads are rejected before persistence with every reason listed
  (unit tests, integration tests and Gate F6).
- A package update is an explicit, reviewable decision per changed object.
- Export produces the same schema and is validated like an upload, so what
  this product exports it can install.
- Theme tokens, listed as optional package content in the specification, are
  not in schema version 1; they arrive with the theme work of Phase 9 as a
  schema extension.
