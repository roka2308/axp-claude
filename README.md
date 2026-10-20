# Analytics Experience Platform — Claude Code track

Semantic analytics, dashboard and reporting platform on top of Matomo.
This repository is **Track A (Claude Code)**, the canonical engineering track of
the Version D dual-track plan.

The product specification lives outside this repository, in
`../analytics_experience_version_d_v1.0/`. That handoff package is the source of
truth; this repository implements it and never redefines it.

| Document                                         | Role                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `01_Version_D_Master_Specification_v1.0.md`      | Binding product specification (D1–D10)                       |
| `02_Shared_Product_Engineering_Contract_v1.0.md` | Invariants shared with the Emergent track                    |
| `03_Claude_Code_Development_Plan_v1.0.md`        | Milestones F0–F10 and their gates                            |
| `acceptance/acceptance_checklist.md`             | Acceptance criteria, identical for both tracks               |
| `fixtures/demo_seed.json`                        | Canonical demo fixture (copied to `packages/fixtures/data/`) |

Current milestone: **Engineering MVP reached** (Phases 0–10, Gate F10;
tag `v0.10-mvp-acceptance`). Acceptance verdict and classified remaining work:
[`docs/acceptance/mvp-acceptance.md`](docs/acceptance/mvp-acceptance.md).
Handover to the team that operates the platform (German):
[`docs/UEBERGABE.md`](docs/UEBERGABE.md).

## Requirements

- Node.js 22.12 or newer (developed on 24)
- Docker Desktop, for MySQL 8.4 and the mail catcher
- No local MySQL installation needed

If Docker Desktop is unavailable — on Windows 10 Home it needs the WSL 2
backend, which not every machine has — see [Without Docker](#without-docker).

## Getting started

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # CREDENTIAL_ENCRYPTION_KEY
npm install
npm run docker:up
npm run db:migrate
npm run dev
```

`npm run dev` starts three processes: the Next.js web app on
<http://localhost:3000>, the API on <http://localhost:4000> and the worker.
Adminer is on <http://localhost:8081>, the mail catcher on
<http://localhost:8025>.

### Creating the first administrator

There are **no default accounts and no default passwords**. A fresh instance is
`UNINITIALIZED` and the first platform admin is created through a privileged
local process that mints one short-lived, single-use activation token:

```bash
npm run bootstrap-admin
```

Open the printed URL, choose an address and a password, and the setup path
closes permanently. A second attempt is rejected.

If administrative access is ever lost, the separate and fully audited
break-glass path is:

```bash
npm run recover-admin -- --requested-by "your name"
```

### Without Docker

`scripts/local-mysql.mjs` runs MySQL from the official Oracle ZIP distribution
as an ordinary user process: no installer, no Windows service, no administrator
rights, and nothing written outside `.local/`. Server settings are identical to
`docker-compose.yml`, so behaviour does not differ between the two.

```bash
npm run db:local:setup -- --zip path/to/mysql-8.4.10-winx64.zip
```

Afterwards `npm run db:local:start`, `db:local:stop` and `db:local:status`
manage it, and `npm run gate:f0:local` runs the milestone gate against it.
Delete the whole thing with `node scripts/local-mysql.mjs remove`.

The mail catcher and Adminer are Docker-only; neither is needed before Phase 8.

### Demo data

```bash
npm run seed:demo
```

Seeds the canonical fixture: tenant _Corporate Communications Demo_, project
_Employee Portal_ and the five demo accounts, each with its own random password
printed once. Refused when `APP_ENV=production` or `ENABLE_DEMO_FIXTURES` is off.

## Architecture

A modular monolith in three processes, built from one codebase:

```
browser ──▶ apps/web (Next.js)  ──▶ apps/api (Fastify) ──▶ MySQL
            holds the session       owns authorization,      product
            cookie, renders UI      tenant isolation and     configuration
                                    all Matomo access        only
                                            ▲
                          apps/worker ──────┘ same domain services
```

The browser never talks to the API or to Matomo directly. The session token
lives in an httpOnly cookie on the web origin and is forwarded server-side as a
bearer token, so the API needs neither CORS nor CSRF handling.

| Package                  | Contents                                                              |
| ------------------------ | --------------------------------------------------------------------- |
| `packages/contracts`     | Canonical vocabulary: roles, scopes, lifecycles, value states, errors |
| `packages/config`        | Validated runtime configuration and build metadata                    |
| `packages/observability` | Structured logging, correlation ids, telemetry redaction              |
| `packages/db`            | Drizzle schema and deterministic MySQL migrations                     |
| `packages/core`          | Domain modules — identity, access, tenancy, platform, audit           |
| `packages/ui`            | Design system: tokens, theme contract, accessible components          |
| `packages/fixtures`      | Canonical demo fixture and seed runner                                |

Architecture decisions are recorded in `docs/adr/`, and each milestone gate is
documented with its evidence in `docs/gates/`.

## Invariants

These hold everywhere in this repository. Breaking one blocks MVP acceptance.

1. Matomo is the only persistent analytics data store — MySQL holds
   configuration only.
2. The browser never receives Matomo credentials and never queries Matomo.
3. Tenant isolation is enforced server-side; ids from the browser are never
   trusted without independent resolution.
4. The five system roles are additive, not hierarchical, and no role grants
   automatic analytics data access.
5. Published dashboards are immutable snapshots; editing happens in a draft.
6. Missing, unknown and unavailable values are never rendered as numeric zero.
7. Permission, entitlement, capability and setup are separate concepts with
   separate UI surfaces.
8. Accessibility is an MVP requirement, not a later polish step.

## Commands

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `npm run dev`              | Web, API and worker in watch mode                    |
| `npm run typecheck`        | TypeScript across every workspace and the test suite |
| `npm run lint`             | ESLint, including the architecture boundary rules    |
| `npm test`                 | Unit tests (no database)                             |
| `npm run test:integration` | Integration tests against MySQL                      |
| `npm run test:e2e`         | Playwright end-to-end tests                          |
| `npm run build`            | Production build of all three processes              |
| `npm run verify`           | Everything above, in CI order                        |
| `npm run gate:f0`          | Demonstrate the Phase 0 milestone gate end to end    |
| `npm run db:generate`      | Generate a migration from schema changes             |
| `npm run db:migrate`       | Apply pending migrations                             |
| `npm run db:reset`         | Drop all tables (non-production only)                |

## Track discipline

The Emergent track builds the same specification independently. Both use the
same contracts, fixtures and acceptance checklist; code and databases stay
separate. Any deviation from the specification is recorded in `DEVIATIONS.md`
before it is treated as product truth — never silently.
