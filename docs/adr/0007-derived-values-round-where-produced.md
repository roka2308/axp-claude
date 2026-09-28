# ADR 0007 — Derived values chain, and round where they are produced

Status: accepted
Date: 2026-09-28
Phase: 6 (Pulse reference solution)

## Context

Formulas and scores are derived after Matomo answers (Master Spec §13). Until
Phase 6 every derivation saw only the leaves Matomo returned: a formula that
referenced another formula, or a score built on a formula, found its input
missing. Phase 3 never exercised such a chain; the Pulse reference solution is
nothing but one — Engagement Rate → Interaction Index → PULSE.

The canonical fixture also fixes the numbers the chain must produce
(`06_Canonical_Demo_Data_Pulse_v1.0.md`): Interaction Index is computed from
the _displayed_ rates ("Engagement Rate display basis 18 × 0.8 + Creation Rate
display basis 5 × 0.2 = 15.4"), and PULSE from the displayed Interaction Index
and Adoption Rate, giving 40.32. Computed at full precision the same chain
gives 15.372 and 40.33. The fixture asks for rounding that is "explicit and
consistent".

## Decision

1. **Derivations chain.** They are evaluated in dependency order, and each one
   sees the values of those before it, for scalars, every point of a series and
   every breakdown row.
2. **A derived value is rounded to the decimals its own definition declares,
   at the moment it is produced.** Dependents consume that value. Scores
   already rounded this way; formulas now do too.

Rounding is explicit because every definition declares its decimals, and
consistent because the number a dependent formula uses is the number the
dashboard shows. A reader can recompute PULSE from the four cards above it —
which is the point of showing the calculation trace at all.

## Consequences

- The Pulse chain yields 18 %, 5 %, 51 %, 15.4 and 40.32 with the reference
  package's declared decimals (0, 0, 0, 1, 2). `derive.test.ts` pins it.
- A definition author who wants more precision downstream declares more
  decimals on the input. That is a visible, versioned choice, not an accident
  of floating point.
- Native metrics are counts from Matomo and are not rounded.
