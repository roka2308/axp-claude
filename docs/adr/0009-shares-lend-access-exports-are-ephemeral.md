# ADR 0009 — Shares lend their creator's access; exports are ephemeral files

Status: accepted
Date: 2026-09-29
Phase: 7 (Sharing and Exports)

## Context

Master Spec §15 and Shared Contract §11 ask for external shares - a whole
published dashboard behind a server-side object with a mandatory expiry,
revocation, explicit rights for time range, comparison, detail and export,
an optional password, and no draft content or internal notes - and for manual
exports (PDF, widget CSV, dashboard XLSX, hybrid PPTX) that reproduce the
current viewer state. Master Spec §4 forbids persisting analytics data, and an
export file is analytics data.

Three questions had no answer in the specification: what a share's data
access rests on, what "internal notes" are, and where an export file lives
between rendering and download.

## Decision

1. **A share lends its creator's access and cannot outlive it.** A share has
   no permissions of its own. On every request it is resolved afresh: not
   revoked, not expired, the dashboard published and not archived or trashed,
   the tenant active, and its creator still active with `dashboard.share` and
   a view grant on the dashboard. When any of these fails, the recipient gets
   the same neutral "not available" as for a link that never existed; the
   owners see which condition failed.
2. **Rights are enforced on the server.** A share without the time range or
   comparison right serves the dashboard's defaults and refuses anything else;
   detail and export routes refuse outright without their right.
3. **Tokens never travel in API URLs.** The link token (32 random bytes) and a
   password session go from the web server to the API as request headers,
   where the log redaction removes them. Only SHA-256 hashes are stored; the
   password is an Argon2id hash. Five wrong passwords pause a share for 15
   minutes, on top of a per-address rate limit.
4. **Internal notes are a snapshot field for the team.** A dashboard and each
   widget may carry an `internalNote`. The presentation builder takes an
   `audience`: `internal` (the signed-in product) keeps the notes, `external`
   (a share) and `export` (a file) lose them in the builder itself, so no
   route can forget to strip them. Exports never carry notes, even for
   signed-in users, because a file leaves the product.
5. **Exports are rendered from the presentation model, never screenshots.**
   One normalised export document is built from `DashboardPresentation`; the
   four renderers only lay it out. A value without a number is written as its
   state in words in every format. PDF (pdfkit) is tagged, with language,
   title, figure alternatives and header cells; charts are vectors. PPTX
   (pptxgenjs) is hybrid: text, key figures, evaluations and tables are
   native, a line chart is a PNG rendered from SVG (resvg) with a text
   alternative and its values in the slide notes. Fonts are DejaVu Sans from
   npm, so every host renders the same file.
6. **Export files are ephemeral artifacts.** The file is encrypted with
   AES-256-GCM (bound to its artifact id) in `EXPORT_ARTIFACT_DIR`, readable
   only by whoever requested it (a user or a share), and deleted with its
   metadata row after `EXPORT_ARTIFACT_TTL_MINUTES` (default 15) by the
   worker; an expired file is refused by the API even before the worker runs.
   The `export_artifacts` row holds format, name, size, owner and expiry -
   never content. Revoking a share deletes its files at once.

## Consequences

- A departed or demoted employee's links stop working without anyone having
  to find them.
- A recipient cannot learn whether a link was revoked, expired or archived.
- The persistence rule holds: MySQL gains configuration and metadata tables
  only (`dashboard_shares`, `share_sessions`, `export_artifacts`), guarded by
  `persistence-rules.test.ts`.
- Rendering is CPU work in the API process; at most two renders run at once.
  Scheduled reports (Phase 8) will move rendering to the worker.
- Tenant themes do not reach export files yet; exports use the default theme's
  token values, checked against `tokens.css` by a test (DEV-007).
- `pptxgenjs` pulls in `image-size`, which has advisories for JXL/HEIF/ICNS
  parsing. It only ever sees PNGs this product rendered itself.
