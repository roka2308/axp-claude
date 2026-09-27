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
