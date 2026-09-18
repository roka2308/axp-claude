# ADR 0001 — Modular monolith in three processes

- Status: accepted
- Date: 2026-09-18
- Milestone: F0
- Specification reference: Master Spec §3, Shared Contract §1

## Context

The specification prescribes a modular monolith, TypeScript-first, a React/Next.js
frontend, a TypeScript backend and a separate background worker built from the
same codebase, with MySQL as the product store. It explicitly rules out
microservices, Kubernetes and any cloud provider as MVP prerequisites.

The open question was how the three processes share domain logic, and whether
the web app should reach the database directly.

## Decision

One repository with npm workspaces. Domain logic lives in `packages/core` and is
imported by `apps/api` and `apps/worker`. `apps/web` never imports it.

The browser talks only to the Next.js server. Next.js holds the session cookie
and calls the API server-side with a bearer token. The API owns authorization,
tenant isolation and all Matomo access.

An ESLint rule forbids `@axp/core`, `@axp/db`, `mysql2` and `drizzle-orm`
imports inside `apps/web`, so the boundary fails the build rather than eroding.

## Consequences

Positive:

- The three deployable processes of the specification exist literally, while
  domain rules have exactly one implementation.
- The API has no browser-facing attack surface: no CORS, no CSRF handling, no
  cookie parsing. CSRF is covered by Next.js Server Action origin verification.
- A future split into separate services is a deployment change, not a rewrite.

Negative:

- One extra network hop between web and API. Acceptable: the specification's
  performance targets are per widget, and the hop is loopback or in-cluster.
- Types shared between web and API must live in `packages/contracts`, which is
  a small discipline cost and a large consistency benefit.

## Alternatives considered

**Next.js route handlers as the entire backend.** Fewer moving parts, but the
worker would then either duplicate domain logic or import from a Next app, and
the specification's "separate background worker from the same codebase" would
become aspirational.

**Direct database access from Next.js server components.** Faster reads, but it
would place authorization decisions in the rendering layer and make the tenant
isolation boundary impossible to audit in one place.
