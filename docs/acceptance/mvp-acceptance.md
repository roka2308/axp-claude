# MVP acceptance - Track A (Claude Code)

Status of every item of `acceptance/acceptance_checklist.md`, with its
evidence. Gate F10 (`npm run gate:f10`) reads this table and fails if any item
is neither Pass, Mocked, Partial nor N/A, or if a Mocked or Partial item has
no class. Matomo runs through the mock adapter throughout (the user's choice
for this track); items whose truth depends on a real Matomo say so.

Classes for what remains: **MVP+** (agreed later scope), **Performance Gate**
(needs measurements against a real Matomo), **Production Readiness** (needed
before live operation, outside the Engineering MVP), **On Hold** (specification
leaves it open).

Evidence abbreviations: `int:` integration test file in `tests/integration`,
`e2e:` Playwright spec in `tests/e2e`, `unit:` unit test, `F<n>`: gate record
in `docs/gates`.

## A. Hard invariants

| ID  | Item                                                                    | Status | Evidence                                                                                                                                                                                 | Class |
| --- | ----------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A1  | No Matomo analytics results are persisted in MySQL                      | Pass   | int:persistence-rules (pinned table list, no result columns); int:analytics "writes no row at all while rendering", "leaves no measured value"; F1                                       |       |
| A2  | No Visit/Action raw data is persisted                                   | Pass   | int:persistence-rules; the connector has no raw-data call; F1                                                                                                                            |       |
| A3  | Browser never receives Matomo credentials                               | Pass   | int:analytics "never returns the Matomo token on any route"; e2e:dashboard-viewer "never ships a Matomo credential to the browser"; F9 bundle scan                                       |       |
| A4  | Tenant isolation is enforced server-side                                | Pass   | int:isolation - every registered route with another tenant's ids, all four tenant roles, valid bodies (408× 403, 8× 404, 0 successes); F10                                               |       |
| A5  | Platform Admin does not automatically receive customer analytics access | Pass   | int:isolation "gives the platform administrator none of a customer's analytics"; e2e:administration "a Platform Admin sees no customer analytics"                                        |       |
| A6  | Tenant Admin cannot escalate to Platform Admin                          | Pass   | int:access "and neither can a tenant admin"; e2e:administration "never offers Platform Admin to a Tenant Admin"; ADR 0006                                                                |       |
| A7  | Missing/unknown/unavailable is never silently rendered as numeric zero  | Pass   | unit:contracts valueEnvelope; e2e:viewer-detail "shows every value state in words"; int:export-reliability (Matomo down: "nicht verfügbar", no zero); int:performance (timed-out widget) |       |
| A8  | Published dashboard is not mutated by draft editing                     | Pass   | int:analytics "keeps the published dashboard unchanged while the draft is edited"; e2e:dashboard-editor "leaves the published dashboard untouched until publish"                         |       |
| A9  | Package import accepts no arbitrary executable code                     | Pass   | unit:package-validation, unit:package-adversarial (nesting, prototype keys, lookalike ids, sizes); e2e:solutions "refuses an uploaded package that carries code"; ADR 0008               |       |

## B. D10 core journeys

| ID  | Item                                                                          | Status  | Evidence                                                                                                                                                                      | Class                |
| --- | ----------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| B1  | Viewer: Login                                                                 | Pass    | e2e:bootstrap-and-login "signs in and lands on Home" (Chromium, desktop WebKit, mobile Safari)                                                                                |                      |
| B2  | Viewer: Home / Dashboard Library                                              | Pass    | e2e:viewer-detail "reaches a dashboard from the library"; int:viewer "lists the library across projects"                                                                      |                      |
| B3  | Viewer: Open published dashboard                                              | Pass    | e2e:dashboard-viewer "shows the dashboard with its data scope and all of its widgets"                                                                                         |                      |
| B4  | Viewer: Change Time Range                                                     | Pass    | e2e:dashboard-viewer "changes the time range, and the numbers follow"                                                                                                         |                      |
| B5  | Viewer: Change Comparison                                                     | Pass    | e2e:dashboard-viewer "turns the comparison off and on again"                                                                                                                  |                      |
| B6  | Viewer: Data Scope stays visible/read-only                                    | Pass    | e2e:dashboard-viewer data scope; e2e:viewer-detail "has no cross-filter"                                                                                                      |                      |
| B7  | Viewer: Open Widget Detail                                                    | Pass    | e2e:viewer-detail "opens a detail view that inherits the dashboard context", "is a shareable URL"                                                                             |                      |
| B8  | Viewer: Access definition/explanation                                         | Pass    | e2e:dashboard-viewer "explains the definition behind a number"                                                                                                                |                      |
| B9  | Viewer: Export current view                                                   | Pass    | e2e:sharing "downloads a workbook of exactly the view on screen", "exports one widget as CSV"                                                                                 |                      |
| B10 | Editor: Enter edit mode                                                       | Pass    | e2e:dashboard-editor "creates a dashboard and opens the editor on it"                                                                                                         |                      |
| B11 | Editor: Add widget                                                            | Pass    | e2e:dashboard-editor "adds widgets from the gallery, templates first"                                                                                                         |                      |
| B12 | Editor: Configure via Inspector                                               | Partial | e2e:dashboard-editor "shows a widget's settings when it is selected" (title, size, visualisation, context); choosing another catalog definition per widget is not offered yet | MVP+                 |
| B13 | Editor: Move on 12-column grid                                                | Pass    | e2e:dashboard-editor "moves and resizes a widget from the keyboard alone", "never lets two widgets overlap"; ADR 0004                                                         |                      |
| B14 | Editor: Resize on grid                                                        | Pass    | same; "clamps an invalid size instead of storing it"                                                                                                                          |                      |
| B15 | Editor: Use non-drag keyboard/dialog alternative                              | Pass    | e2e:dashboard-editor keyboard move and resize                                                                                                                                 |                      |
| B16 | Editor: Tablet/Mobile preview                                                 | Pass    | e2e:dashboard-editor "previews desktop, tablet and mobile"                                                                                                                    |                      |
| B17 | Editor: Override and reset breakpoint layout                                  | Pass    | e2e:dashboard-editor "offers an override at a derived breakpoint, and a reset"                                                                                                |                      |
| B18 | Editor: Undo/Redo                                                             | Pass    | e2e:dashboard-editor "undoes and redoes a change"                                                                                                                             |                      |
| B19 | Editor: Autosave draft                                                        | Pass    | e2e:dashboard-editor "autosaves without a save button"; int:dashboard-editing stale-write refusal                                                                             |                      |
| B20 | Editor: Preview                                                               | Pass    | e2e:dashboard-editor preview; viewer `?source=draft`                                                                                                                          |                      |
| B21 | Editor: Publish impact summary                                                | Pass    | e2e:dashboard-editor "shows the publish impact, then publishes"                                                                                                               |                      |
| B22 | Editor: Publish                                                               | Pass    | same; int:analytics "creates a new version on publish"                                                                                                                        |                      |
| B23 | Project and Data: Create project                                              | Pass    | e2e:solutions "creates a project in four steps and lands on its checklist"                                                                                                    |                      |
| B24 | Project and Data: Resume setup checklist                                      | Pass    | e2e:project-setup "reaches setup from the project"; e2e:solutions "marks an optional step not relevant"                                                                       |                      |
| B25 | Project and Data: Select existing or create Matomo connection                 | Mocked  | e2e:project-setup "stores a connection and assigns one of its sites"; int:solutions reuse of an existing site; against the mock adapter                                       | Production Readiness |
| B26 | Project and Data: Test connection/capabilities                                | Mocked  | e2e:project-setup "tests a connection before storing it", "reports an unusable address"; unit:matomo capability rules; HTTP adapter not run against a real Matomo             | Production Readiness |
| B27 | Project and Data: Select site                                                 | Pass    | e2e:project-setup site assignment; int:analytics cross-tenant site refusal                                                                                                    |                      |
| B28 | Project and Data: Resolve mapping                                             | Pass    | e2e:semantics "records a mapping without creating a definition version"; int:semantic                                                                                         |                      |
| B29 | Project and Data: Create/use semantic metric                                  | Pass    | int:semantic; e2e:semantics catalog                                                                                                                                           |                      |
| B30 | Project and Data: Create formula                                              | Pass    | e2e:semantics "builds a formula from controls, with no expression field anywhere"                                                                                             |                      |
| B31 | Project and Data: Create score                                                | Pass    | e2e:semantics score builder; int:semantic score versions                                                                                                                      |                      |
| B32 | Administration: Open User Detail                                              | Pass    | e2e:administration "answers what a person can do, where, and why"                                                                                                             |                      |
| B33 | Administration: Edit locally managed profile field                            | Pass    | e2e:administration self service and user detail; int:access profile updates                                                                                                   |                      |
| B34 | Administration: SSO-managed field appears read-only/managed                   | Pass    | int:access managed attributes refused on write; int:account-mail "leaves an address the identity provider manages alone"; UI marks "Durch Identity Provider verwaltet"        |                      |
| B35 | Administration: Assign group/role/scope within permission                     | Pass    | int:access "can assign the four tenant roles inside the tenant"; e2e:administration                                                                                           |                      |
| B36 | Administration: View Effective Access                                         | Pass    | e2e:administration "shows my own profile and my own effective access"                                                                                                         |                      |
| B37 | Administration: View why access exists                                        | Pass    | e2e:administration "shows who can open a dashboard, and why"                                                                                                                  |                      |
| B38 | Administration: View impact preview before access change                      | Pass    | e2e:administration "previews a change first, and says so when it would change nothing"                                                                                        |                      |
| B39 | Platform Admin: Tenant list                                                   | Pass    | e2e:administration tenants                                                                                                                                                    |                      |
| B40 | Platform Admin: Visible Tenant anlegen action                                 | Pass    | e2e:administration "creates a tenant through the wizard"                                                                                                                      |                      |
| B41 | Platform Admin: Create tenant                                                 | Pass    | same; int:access "creates a tenant with its first administrator and a first project"                                                                                          |                      |
| B42 | Platform Admin: Open Tenant Detail                                            | Pass    | e2e:administration; e2e:productization entitlements tab                                                                                                                       |                      |
| B43 | Platform Admin: Suspend/reactivate flow                                       | Pass    | e2e:administration "changes the lifecycle behind a typed confirmation"; F8 suspension                                                                                         |                      |
| B44 | Platform Admin: Offboarding state visible                                     | Pass    | tenant lifecycle tab and impact preview; int:authorization offboarding refusal; F5                                                                                            |                      |
| B45 | Platform Admin: Dangerous action requires explicit confirmation/re-auth       | Pass    | e2e:administration typed confirmation and password; e2e:productization diagnostics re-auth                                                                                    |                      |
| B46 | Solution: Open Solutions                                                      | Pass    | e2e:solutions                                                                                                                                                                 |                      |
| B47 | Solution: Select Employee Portal Health / Pulse                               | Pass    | e2e:solutions install flow                                                                                                                                                    |                      |
| B48 | Solution: Capability/mapping check                                            | Pass    | e2e:solutions "walks through check, mapping, conflicts and preview"; int:solutions analysis                                                                                   |                      |
| B49 | Solution: Conflict/dependency preview                                         | Pass    | same                                                                                                                                                                          |                      |
| B50 | Solution: Install                                                             | Pass    | int:solutions "installs, then a dashboard from its template shows the canonical values"                                                                                       |                      |
| B51 | Solution: Create dashboard from solution template                             | Pass    | e2e:solutions "creates a dashboard as a copy and opens it in the editor"                                                                                                      |                      |
| B52 | Solution: Pulse canonical values match fixture                                | Mocked  | e2e:solutions "shows the canonical Pulse values" - the fixture values come from the mock adapter by design                                                                    | Production Readiness |
| B53 | Solution: Existing published dashboard not silently changed by package update | Pass    | int:solutions "does not silently change a published dashboard"                                                                                                                |                      |
| B54 | Problem state: Loading                                                        | Pass    | e2e:viewer-detail "sends every tile in the loading state first"                                                                                                               |                      |
| B55 | Problem state: Empty                                                          | Pass    | e2e:viewer-detail state model; int:analytics "distinguishes a measured zero from an empty result"                                                                             |                      |
| B56 | Problem state: Zero                                                           | Pass    | same                                                                                                                                                                          |                      |
| B57 | Problem state: Missing                                                        | Pass    | e2e:viewer-detail "shows every value state in words"; DEV-002                                                                                                                 |                      |
| B58 | Problem state: Unknown                                                        | Pass    | same                                                                                                                                                                          |                      |
| B59 | Problem state: Not Applicable                                                 | Pass    | same                                                                                                                                                                          |                      |
| B60 | Problem state: Not Tracked                                                    | Pass    | same ("Diese Website erfasst diesen Bericht nicht")                                                                                                                           |                      |
| B61 | Problem state: Unavailable                                                    | Pass    | same; int:performance timed-out widget; int:export-reliability                                                                                                                |                      |
| B62 | Problem state: Warning                                                        | Pass    | e2e:viewer-detail "explains a warning in the detail view"                                                                                                                     |                      |
| B63 | Problem state: Permission denied                                              | Pass    | e2e:administration "offers no administration it does not allow"; e2e:semantics "keeps the catalog away from a plain viewer"                                                   |                      |
| B64 | Problem state: Entitlement required                                           | Pass    | e2e:productization "switching a module off is an entitlement, and deletes nothing"; F9                                                                                        |                      |
| B65 | Problem state: Capability unsupported                                         | Pass    | int:analytics "fails only the widget a missing capability affects"; e2e:project-setup capability report                                                                       |                      |
| B66 | Problem state: Setup required                                                 | Pass    | e2e:project-setup "is told which steps belong to another role"; int:solutions setup states                                                                                    |                      |

## C. Accessibility

| ID  | Item                                          | Status | Evidence                                                                                                                                        | Class |
| --- | --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C1  | Core journeys keyboard operable               | Pass   | e2e: login, viewer, detail view, editor move/resize all from the keyboard                                                                       |       |
| C2  | Visible focus                                 | Pass   | e2e:dashboard-viewer "shows a visible focus ring"; theme check "focus indicator" pair (F9)                                                      |       |
| C3  | Dialog focus management                       | Pass   | e2e:viewer-detail "closes with Escape and returns focus", "keeps focus inside the dialog"                                                       |       |
| C4  | No color-only status                          | Pass   | e2e:dashboard-viewer "states every widget status as text", KPI "never as a colour alone"                                                        |       |
| C5  | Theme contrast validation                     | Pass   | F9; unit:theme pairs incl. muted text on sunken and selected surfaces; e2e:accessibility axe colour-contrast on every core page, light and dark |       |
| C6  | Chart data alternative                        | Pass   | e2e:viewer-detail "gives every chart its data as a table"                                                                                       |       |
| C7  | Grid move/resize alternative                  | Pass   | e2e:dashboard-editor keyboard move and resize                                                                                                   |       |
| C8  | Reduced motion preference respected           | Pass   | e2e:accessibility "nothing moves when the system asks for less motion"; tokens.css                                                              |       |
| C9  | Form errors associated with controls          | Pass   | e2e:bootstrap-and-login "form errors are associated with their control"; axe label rules                                                        |       |
| C10 | Viewer reflows on representative mobile width | Pass   | e2e:dashboard-viewer, viewer-detail, reporting, sharing, solutions, themes reflow checks on iPhone 14                                           |       |

## D. Security and auth

| ID  | Item                                                  | Status | Evidence                                                                                                           | Class |
| --- | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ----- |
| D1  | No default admin credentials                          | Pass   | F0; ADR 0003; int:bootstrap                                                                                        |       |
| D2  | Bootstrap works once only                             | Pass   | e2e:bootstrap-and-login "creates the first platform admin and then closes the setup path"; int:bootstrap           |       |
| D3  | Break-glass path separate and audited                 | Pass   | int:bootstrap recovery token purpose and audit; `/recover` route separate from `/setup`                            |       |
| D4  | Invite token one-use/expiring                         | Pass   | e2e:administration "an invitation link works exactly once"; int:account-mail; F10 mailed invitation                |       |
| D5  | Recovery does not enumerate accounts                  | Pass   | int:account-mail "answers the same for an unknown address, a deactivated account and a real one"; e2e:account; F10 |       |
| D6  | Sensitive changes can require recent authentication   | Pass   | e2e:administration lifecycle re-auth; e2e:productization diagnostics; address change needs the current password    |       |
| D7  | Deactivation revokes access/sessions appropriately    | Pass   | int:access, int:auth deactivation ends sessions; password reset ends every session (int:account-mail)              |       |
| D8  | Credential replacement never reveals stored plaintext | Pass   | int:analytics "offers no route that reads a credential back", "stores the token only as ciphertext"                |       |
| D9  | Cross-tenant negative test suite passes               | Pass   | int:isolation (every route); F10                                                                                   |       |

## E. Dashboard/version semantics

| ID  | Item                                              | Status | Evidence                                                                    | Class |
| --- | ------------------------------------------------- | ------ | --------------------------------------------------------------------------- | ----- |
| E1  | Save != Publish                                   | Pass   | e2e:dashboard-editor autosave vs publish; int:analytics                     |       |
| E2  | Published stays stable while draft changes        | Pass   | int:analytics; e2e:dashboard-editor                                         |       |
| E3  | Rollback creates a new version                    | Pass   | int:dashboard-editing rollback                                              |       |
| E4  | Editor lock lease/expiry behavior tested          | Pass   | unit:draft-lease; int:dashboard-editing                                     |       |
| E5  | Takeover is authorized/audited                    | Pass   | int:dashboard-editing "ends the other session deliberately and records it"  |       |
| E6  | Exports/shares/schedules use Published by default | Pass   | int:sharing "never the draft"; F7; F8 "schedules use the Published Runtime" |       |

## F. Matomo

| ID  | Item                                               | Status | Evidence                                                                                                                           | Class                |
| --- | -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| F1  | Capability fingerprint generated                   | Mocked | int:analytics "records what an installation can do, derived from probes"; HTTP adapter probes exist but no real Matomo was reached | Production Readiness |
| F2  | Compatibility state not derived from version alone | Pass   | unit:matomo "is decided by capabilities, never by the version string"                                                              |                      |
| F3  | Core capability absence blocks affected use case   | Pass   | unit:matomo "blocks only the affected use case"; int:analytics                                                                     |                      |
| F4  | Optional capability absence degrades gracefully    | Pass   | unit:matomo "degrades gracefully when only optional capabilities are missing"                                                      |                      |
| F5  | Drift warning does not auto-rewire mapping         | Pass   | int:semantic drift; attention scan `mapping_review` (F8)                                                                           |                      |
| F6  | Site timezone used for analytics calendar          | Pass   | int:analytics "resolves the range in the Matomo site time zone"                                                                    |                      |

## G. Exports/reporting

| ID  | Item                                                | Status | Evidence                                                                                    | Class |
| --- | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- | ----- |
| G1  | PDF                                                 | Pass   | unit:renderers (tagged PDF); int:export-reliability; F7                                     |       |
| G2  | Widget CSV                                          | Pass   | unit:renderers (formula injection neutralised); e2e:sharing                                 |       |
| G3  | Dashboard XLSX                                      | Pass   | unit:renderers; e2e:sharing workbook                                                        |       |
| G4  | PPTX hybrid behavior documented/tested              | Pass   | unit:renderers "keeps simple content native and makes charts images"; F7; F8 stability gate |       |
| G5  | Temporary files protected and auto-deleted          | Pass   | int:sharing encryption and expiry; F7; F9 diagnostic cleanup                                |       |
| G6  | Scheduled report uses relative period/timezone      | Pass   | F8; unit:rhythm DST                                                                         |       |
| G7  | Scheduled report uses Published Runtime             | Pass   | F8                                                                                          |       |
| G8  | Suspended/offboarding tenant stops schedules/shares | Pass   | F8; int:reporting                                                                           |       |

## H. Observability and diagnostics

| ID  | Item                           | Status | Evidence                                                                                | Class |
| --- | ------------------------------ | ------ | --------------------------------------------------------------------------------------- | ----- |
| H1  | Structured logs                | Pass   | int:telemetry; F10 live log review (method, path without query, status, correlation id) |       |
| H2  | Correlation IDs                | Pass   | request context plugin; correlation id in every error body and log line; F10            |       |
| H3  | Job correlation                | Pass   | JobRunner runs each job under its own correlation id (F8)                               |       |
| H4  | Health/readiness/liveness      | Pass   | `/livez`, `/readyz` on API and worker; every gate waits on them                         |       |
| H5  | No analytics payload in logs   | Pass   | int:telemetry "holds no number from Matomo"; unit:redaction                             |       |
| H6  | Diagnostic bundle sanitization | Pass   | F9; int:productization                                                                  |       |
| H7  | Diagnostic artifact cleanup    | Pass   | F9 (worker deletes an expired bundle and its file)                                      |       |

## I. Performance

| ID  | Item                                  | Status | Evidence                                                                                                                                                          | Class            |
| --- | ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| I1  | Widget requests independent           | Pass   | ADR 0005; e2e loading-state streaming; int:performance                                                                                                            |                  |
| I2  | Slow widget does not block all others | Pass   | int:performance "lets a slow widget fail on its own while the others arrive"                                                                                      |                  |
| I3  | Bounded parallelism                   | Pass   | int:performance "keeps requests to Matomo within the configured parallelism"                                                                                      |                  |
| I4  | Short-lived RAM cache only            | Pass   | int:performance cache expiry; int:analytics no rows written                                                                                                       |                  |
| I5  | Timeouts/cancel/retry controlled      | Pass   | int:performance timeout and stalled-Matomo cancellation (headers-then-silence included); analytics never retries on its own, durable jobs retry with backoff (F8) |                  |
| I6  | Cold/warm measurements captured       | Mocked | F10 cold/warm timings with the mock adapter (product overhead); real-Matomo latency not measured                                                                  | Performance Gate |

## Phase 10 workstreams beyond the checklist

| Workstream                                | Result                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full E2E suite for the seven D10 journeys | Pass - Chromium full suite, mobile Safari viewer suite                                                                                                                                                           |
| Browser matrix smoke tests                | Partial - core journeys in desktop WebKit and mobile Safari besides Chromium; Firefox is wired in (`E2E_FIREFOX=1`) but this machine refuses to start its browser, so it was not run here - Production Readiness |
| Accessibility audit and keyboard pass     | Pass - axe WCAG 2.1 AA on every core page per role, light and dark, desktop and phone; found and fixed muted-text contrast on tinted surfaces                                                                    |
| Screenreader-oriented checks              | Partial - accessible names, roles, live regions and landmarks verified by axe and role-based locators; a manual pass with NVDA/JAWS/VoiceOver is Production Readiness                                            |
| Responsive viewer / desktop authoring     | Pass - reflow checks on iPhone 14; authoring desktop-first by decision                                                                                                                                           |
| Audit completeness review                 | Pass - every sensitive action of the contract has an audit action; Phase 10 added recovery and address change                                                                                                    |
| Log/telemetry data-content review         | Pass - int:telemetry and F10 live review; found and fixed empty request records                                                                                                                                  |
| Backup/restore rehearsal                  | Pass - F10; runbook `docs/operations/backup-and-restore.md`                                                                                                                                                      |
| Upgrade/migration rehearsal               | Pass - F10 from `v0.9` with its own code; runbook `docs/operations/upgrade.md`                                                                                                                                   |
| Package import adversarial tests          | Pass - unit:package-adversarial                                                                                                                                                                                  |
| Export/report reliability tests           | Pass - int:export-reliability; F8                                                                                                                                                                                |
| Pivot Lite                                | On Hold - only after the Performance Gate (development plan)                                                                                                                                                     |

## Remaining work, classified

| Item                                                                                                                                        | Class                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Inspector: choose another catalog definition per widget                                                                                     | MVP+                             |
| Annotations store (chart annotations)                                                                                                       | MVP+                             |
| Attention kinds beyond the five operational ones (capability drift, theme contrast, package update impact)                                  | MVP+                             |
| Logos and customer fonts as themeable tokens; dark mode as reference design                                                                 | MVP+                             |
| Timings, timeouts and parallelism tuned against real Matomo installations                                                                   | Performance Gate                 |
| Pivot Lite                                                                                                                                  | On Hold (after Performance Gate) |
| Certification against real Matomo versions (capability probes, HTTP adapter)                                                                | Production Readiness             |
| OIDC sign-in (the account model with provider-managed fields exists)                                                                        | Production Readiness             |
| Manual screen-reader pass (NVDA, JAWS, VoiceOver)                                                                                           | Production Readiness             |
| Firefox smoke run on a machine that can start the Playwright Firefox build                                                                  | Production Readiness             |
| Reverse proxy in front of the web server that sets `X-Forwarded-For`; `API_TRUSTED_PROXIES` for the web server's address                    | Production Readiness             |
| Two npm advisories in code the product never runs (`image-size` via pptxgenjs, `uuid` v3/v5/v6 via exceljs) - replace when upstream updates | Production Readiness             |
| Schema downgrade path; automated, scheduled backups with retention                                                                          | Production Readiness             |
| Mail deliverability (SPF, DKIM, bounce handling)                                                                                            | Production Readiness             |
| Offboarding purge and retention durations                                                                                                   | On Hold (Master Spec §5)         |
