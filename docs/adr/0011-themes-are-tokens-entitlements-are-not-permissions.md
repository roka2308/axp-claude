# ADR 0011 — Themes are validated tokens; entitlements are not permissions

Status: accepted
Date: 2026-10-04
Phase: 9 (Themes, Entitlements, Diagnostics and Release Metadata)

## Context

Master Spec §16 and §23–§24 and the development plan ask for controlled theme
tokens with Platform → Tenant → optional Project inheritance, a Draft /
Preview / Validate / Publish / Rollback lifecycle with contrast validation, an
`EntitlementService` kept apart from authorization and feature flags, release
and schema metadata, a compatibility surface and a sanitised diagnostic
bundle. Gate F9 adds: invalid contrast cannot silently publish, no arbitrary
customer CSS/JS, entitlement loss does not delete configuration, and the
diagnostic bundle contains no secrets or analytics payloads.

## Decision

1. **A theme is a map from allowlisted tokens to validated values.** The
   allowlist and the value shapes live in `@axp/contracts` (`theme.ts`), so
   the API, the web app and the export renderers share one definition.
   Colours are `#rrggbb`; lengths, shadows and font lists have their own
   narrow shapes. Anything else - an unknown property, a value with `;`, `{`,
   `<`, `\`, `url(`, `@import`, `expression(` - is refused with 422 before it
   is stored. The request envelope is strict, so there is no field for free
   CSS or script. The stylesheet the product serves is rendered from the
   accepted map only (`renderThemeStylesheet`), re-validating on the way out:
   custom-property declarations inside `:root` blocks per mode, nothing else.
   The web app escapes `<` once more when it inlines the result.
2. **Three levels, resolved on the server.** Platform, then the customer's own,
   then optionally a project's. `ThemeService.effective` merges the published
   versions; the API decides which level applies to a caller (their own
   customer, a project only of a customer they belong to, the platform theme
   before sign-in, the share's customer on a public link). Exports resolve the
   same theme into their palette (DEV-007 resolved).
3. **Publishing is gated, not advisory.** `validate` computes the WCAG ratio for
   every declared pair in light and dark mode (text on surfaces, button
   labels, links, focus indicator, control boundary). `publish` re-runs the
   check and refuses with `theme.contrast_failed` - and for a platform or
   customer theme also checks every theme built on it, refusing with
   `theme.dependents_fail` if a dependent would fail. A refused publish
   creates no version, keeps the draft and is not audited as published.
   Rollback publishes an old version again as a new version, keeping history.
4. **Light is the reference; dark is token-ready.** Both modes carry values and
   are both checked; the dark mode is not yet the reference design. The
   default border tokens were raised to meet WCAG 1.4.11 (3:1) - the check
   found the shipped values failing.
5. **Entitlements are a third state.** `tenant_entitlements` stores per-customer
   modules (`reporting.scheduled`, `sharing.external`, `solutions.packages`,
   `theming.custom`); no row means the installation default (enabled).
   `EntitlementService.require` throws category `entitlement_required` (403,
   key `entitlement.missing.<module>`), which the UI renders as a contract
   message, distinct from a missing permission and from a missing setup.
   Feature flags (`reports.pptx`) are installation configuration, shown
   read-only next to the modules but never per customer. Switching a module
   off never deletes anything: schedules skip their runs, shared links answer
   "unavailable", the customer theme yields to the platform theme - and all of
   it returns when the module is switched on again.
6. **Diagnostics are built from an allowlist, then scanned.** The bundle is
   assembled from named fields (release, configuration shape, health,
   providers, flags, compatibility, counts, error codes and correlation ids),
   passed through the log sanitiser and then refused outright if it still
   matches a secret, URL or e-mail pattern. It is encrypted at rest like an
   export, readable only by the platform administrator who generated it, after
   a fresh password confirmation, audited, and deleted by the worker after
   `DIAGNOSTICS_BUNDLE_TTL_MINUTES` (default 60).

## Consequences

- A customer brand is a few colour decisions, not a stylesheet: richer
  branding (logos, fonts from a customer's server) needs a new, validated
  token kind and a contract change.
- A platform theme change can be blocked by a customer theme. The validation
  view names the dependent theme, so the operator knows whom to talk to.
- Entitlements are coarse modules. Billing, quotas and plans remain out of the
  MVP.
