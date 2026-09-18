# ADR 0002 — Drizzle ORM with SQL migrations

- Status: accepted
- Date: 2026-09-18
- Milestone: F0
- Specification reference: Master Spec §25, Development Plan Phase 0

## Context

The specification requires deterministic, repo-versioned, automated and tested
MySQL migrations, with additive changes preferred and DOWN migrations explicitly
not required. The persistence layer must also make the "no analytics results in
MySQL" rule reviewable.

## Decision

Drizzle ORM with `mysql2`, and `drizzle-kit generate` producing plain SQL
migration files that are committed.

Schema is defined in TypeScript, split per domain module under
`packages/db/src/schema/`, mirroring the module boundaries of the monolith.

Timestamps are `datetime(3)` in UTC rather than `timestamp`, and primary keys
are UUIDv7 in `char(36)`.

## Consequences

Positive:

- Migrations are readable SQL in the repository; a reviewer sees exactly what
  will run against a customer database.
- Schema files sit next to the module that owns them, so adding a table to a
  domain is a local change and shows up in review as one.
- No query engine binary and no code generation step in the dev loop.
- `datetime` avoids MySQL's session-timezone conversion, so a stored instant
  does not depend on connection settings.

Negative:

- Less automatic relation loading than Prisma; joins are written explicitly.
- `char(36)` keys cost more storage than binary ids. Accepted: this is a
  configuration store, not an analytics store, and readable ids help support.

## Alternatives considered

**Prisma.** Better relation ergonomics and a mature migration tool, but it
centralises the schema in one file set that does not follow module boundaries,
and it adds a generated client plus an engine to the build.

**Kysely with hand-written migrations.** Maximum SQL control, but every schema
change would be written twice — once as types, once as SQL — which is exactly
the drift risk deterministic migrations are meant to remove.
