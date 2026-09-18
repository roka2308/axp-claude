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
