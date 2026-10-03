# Deviations — Claude Code track

Every difference between this implementation and the Version D specification is
recorded here **before** it is treated as product truth. Generated ideas are not
requirements (Master Spec §0).

Status values: `candidate` · `rejected` · `accepted_shared` · `track_specific`.

---

## DEV-001 — Navigation entries for unbuilt milestones are rendered, disabled

- Status: `track_specific`
- Milestone: F0
- Specification reference: D1 (Master Spec §8), Development Plan Phase 0

### What differs

The application shell renders all five primary navigation entries from D1.
Four of them — Projekte, Dashboards, Vorlagen, Administration — are not links
yet. They appear as non-interactive text with `aria-disabled="true"` and a
visible badge naming the milestone that will make them usable.

### Why

Phase 0 delivers a "component shell". Hiding the agreed information
architecture would make the shell unreviewable and would make the cross-track
comparison of navigation impossible at E0/F0. Rendering the entries as working
links would be worse: they would lead to 404s and imply features that do not
exist.

### Risks / impact

Low. The badges are temporary and disappear as each milestone lands. The risk
is cosmetic: a reviewer could mistake the badge for a product concept. Mitigated
by the badge text naming a development phase rather than a product state.

### Proposed action

Keep. Remove each badge in the milestone that implements the entry. No change
to the shared contract.

### Resolution

Resolved in Phase 6: "Vorlagen" was the last entry to become a link. All five
primary entries now lead somewhere real; no badge remains.

---

## DEV-002 — `not_calculable` is modelled as a cause of `missing`, not an 11th state

- Status: `candidate`
- Milestone: F0
- Specification reference: D10 (Master Spec §17), `contracts/state_model.md`, §13

### What differs

The shared contract defines exactly ten value states. The specification also
requires that a score with missing required inputs yields `not calculable`
rather than zero or a reweighted result.

`not_calculable` is not one of the ten states. This implementation models it as
`{ state: 'missing', cause: { kind: 'not_calculable', missingInputs: [...] } }`
instead of adding an eleventh state.

### Why

The ten-state list is a contract shared with the Emergent track and should not
grow without an explicit decision. A structured cause preserves the full
information — including which inputs were missing — while keeping the state
vocabulary intact, and it lets the UI render a score-specific explanation.

### Risks / impact

If the Emergent track introduces `not_calculable` as a state of its own, the two
tracks will render the same situation through different vocabularies and the
comparison of state handling will be misleading. Low technical risk; real
comparability risk.

### Proposed action

Raise at the first comparison gate. Either confirm this modelling in the shared
contract, or agree on an eleventh state in both tracks. Do not resolve it
unilaterally.

---

## DEV-003 — No persistent job queue in Phase 0

- Status: `track_specific`
- Milestone: F0
- Specification reference: Development Plan Phase 0 and Phase 8

### What differs

The worker is a real separate process running real domain services, but it has
no durable job queue. It runs periodic maintenance tasks (session cleanup,
bootstrap token cleanup) from an in-process scheduler.

### Why

Phase 0 explicitly excludes reporting exporters, and the `JobQueue` abstraction
with claim/retry/fail/complete semantics belongs to Phase 8. Designing that
interface now — before the exports and scheduled reports that define its
requirements exist — would produce an abstraction fitted to guesses.

### Risks / impact

None for Phase 0 acceptance. Gate F8 requires the durable queue; its absence is
scheduled work, not debt.

### Proposed action

Keep. Implement `JobQueue` in Phase 8 as specified. The scheduler stays for
periodic maintenance that does not need durability.

### Resolution

Resolved in Phase 8: the durable `JobQueue` (MySQL, leases, retry with
backoff, dead jobs, idempotent enqueue) runs report delivery
([ADR 0010](docs/adr/0010-durable-jobs-scheduled-reports-attention.md)). The
in-process scheduler remains for housekeeping and for finding due schedules.

---

## DEV-004 — Only `native_metric` source bindings are executable

- Status: `track_specific`
- Milestone: F3
- Specification reference: Master Spec §13, Development Plan Phase 3

### What differs

A custom metric resolves its requirement through the project's source
mappings. Of the six binding kinds the product can record, one is executed:
`native_metric`. A mapping to a custom dimension, an event, a goal or site
search is stored, shown and versioned exactly as specified — but asking Matomo
for it is not implemented, so the value comes back as `missing` with the cause
`analytics.binding_kind_not_executable` rather than as a number.

`not_available` is executed in the sense that matters: it resolves to
`missing` with `source_field_absent`, which is what it means.

### Why

Each remaining kind is a different Matomo API call with its own parameters and
its own capability requirement — `CustomDimensions.getCustomDimension`,
`Events.getCategory`, `Goals.get`, `Actions.getSiteSearchKeywords`. Phase 3's
gate is about the semantic layer: that a definition is separate from its
mapping, that a formula is an AST, that a score refuses to reweight around a
missing input. Building four connector call shapes against a mock adapter, with
no real Matomo to verify them, would produce four guesses rather than four
features.

### Risks / impact

A tenant can record a mapping that does not yet produce a value. The product
says so, in words, naming the requirement — it does not render zero and does
not fail the surrounding query. Nothing about the stored mapping has to change
when the calls land; this is a gap in the connector, not in the model.

Gate F3 is unaffected: its criteria concern semantic versioning, cycles,
pinning, mapping separation and score behaviour, none of which depend on which
binding kinds execute.

### Proposed action

Keep. Implement the remaining call shapes against a real Matomo instance, with
the capability probe deciding which are offered. The natural milestone is the
first one with a live Matomo available.

---

## DEV-005 — A local account's e-mail address is not self-service yet

- Status: `track_specific`
- Milestone: F5
- Specification reference: Master Spec §12 ("E-Mail-Änderungen bei Local Auth
  erfordern Re-Auth und Verifikation")

### What differs

"Mein Profil" shows the e-mail address and explains why it cannot be changed
there yet; first name, last name and language are editable. Invitations
likewise return their single-use link to the inviting administrator, who
passes it on, instead of the product mailing it.

### Why

Verification means sending a message to the new address. The product has no
mail transport before scheduled reports (Phase 8). Changing the address without
verification would let a hijacked session redirect password recovery to an
attacker's mailbox, which is precisely what the requirement exists to prevent.

### Risks / impact

An administrator cannot correct a typo in someone's address from the UI; it
takes an invitation to the right address. Nothing else depends on it.

### Proposed action

Implement the verified change - re-auth, token to the new address, switch on
confirmation - together with the mail transport in Phase 8, and deliver
invitation links by mail at the same time.

Update (Phase 8): the mail transport exists now (console, SMTP; ADR 0010) and
carries reports and attention notices. The verified address change and mailed
invitations are still to be built; they move to Phase 10 hardening.

---

## DEV-006 — Solution package schema 1 carries no theme tokens

- Status: `track_specific`
- Milestone: F6
- Specification reference: Master Spec §14 ("Solution Package kann deklarativ
  enthalten: … optionale Theme Tokens")

### What differs

Package schema version 1 has no `themeTokens` section. A package that brings
one is refused as containing an unknown field, like any other.

### Why

Tenant and project themes, their contrast checks and their override rules
arrive in Phase 9 (D9). Accepting tokens now would mean either storing values
nothing reads, or applying them without the accessibility checks the theme
system requires ("Theme-Konfiguration darf Accessibility nicht stillschweigend
brechen").

### Risks / impact

Low: the tokens are optional content, and the reference solution has none. A
package author who wants to ship them cannot do so before Phase 9.

### Proposed action

Add an optional, validated `themeTokens` section in a schema extension with
the theme work of Phase 9, running the same contrast checks as the theme
editor. Record it for the cross-track comparison of package schemas.

---

## DEV-007 — Export files use the default theme, not the tenant's

- Status: `track_specific`
- Milestone: F7
- Specification reference: Master Spec §16 (D9: Themes gelten für Web und
  Exporte), §15 (Export-Formate)

### What differs

PDF, XLSX and PPTX files are drawn with the default theme's token values
(`packages/core/src/export/palette.ts`, compared with `tokens.css` by a test),
whatever theme a tenant uses on screen.

### Why

Tenant themes do not exist before Phase 9. The export palette already reads
from named tokens, so switching it to the tenant's resolved theme is a change
of input, not of the renderers.

### Risks / impact

Low: until Phase 9 every tenant sees the default theme on screen too, so file
and screen agree.

### Proposed action

In Phase 9, resolve the tenant's published theme for an export (including its
contrast-checked evaluation band colours) and pass it to the renderers.

---

## DEV-008 — Scheduled delivery and a presentation stability gate come with Phase 8

- Status: `resolved`
- Milestone: F7
- Specification reference: Master Spec §15 ("PDF/XLSX; PPTX nur nach Stability
  Gate"), development plan Phase 8

### What differs

Phase 7 renders exports in the API process, on request. Rendering for
scheduled reports, and the stability gate that decides when PPTX may be
delivered by schedule, are not built.

### Why

That is the split the development plan makes: manual exports in Phase 7,
scheduled reporting with its job queue in Phase 8. The renderers take a
presentation model and return bytes, so the worker can call them unchanged.

### Risks / impact

A very large dashboard is rendered inside an API request (at most two at
once). The reference dashboards render in about a second.

### Proposed action

Move rendering to the worker's job queue in Phase 8 and define the PPTX
stability gate there.

### Resolution

Resolved in Phase 8: scheduled reports render in the worker, through the job
queue; manual exports stay in the API request. The PPTX stability gate is the
`REPORTS_PPTX_ENABLED` switch, off by default; schedules cannot choose PPTX
until it is turned on (ADR 0010).
