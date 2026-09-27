# ADR 0006 — Data access needs a role and an object grant

- Status: accepted
- Date: 2026-09-27
- Milestone: F5
- Specification reference: Master Spec §7, `contracts/roles_permissions.md`, Gate F5

## Context

"Rolle ist nicht gleich automatischer Datenzugriff." The roles contract says a
Viewer sees "explicitly granted published dashboards", a Dashboard Editor works
"in allowed scope" with "scope/object grants still apply", and no role - not
even Tenant or Platform Admin - carries automatic analytics access.

Until Phase 5 the product checked roles only. `object_grants` existed as a
table and nothing read it, so a Viewer role on a project opened every
published dashboard in it. The invariant was stated in `CLAUDE.md` and not
enforced.

## Decision

Seeing or changing the analytics data behind a dashboard needs **both**:

| Need | Role half (at the dashboard's project)       | Grant half (on the dashboard or its project) |
| ---- | -------------------------------------------- | -------------------------------------------- |
| view | `dashboard.read_published`                   | `view` or `edit`                             |
| edit | `dashboard.edit_draft` / `dashboard.publish` | `edit`                                       |

A grant is held by a user directly or by any group the user belongs to, and
grants accumulate. There is no way to express a deny.

Grants can point at a **dashboard** or at a **project**. The project grant is
the one groups get: it covers every dashboard in the project, including ones
created later, which is how access scales by membership (§7: "Gruppen sind der
bevorzugte Skalierungsweg"). `OBJECT_TYPES` in `@axp/contracts` widens from
`['dashboard']` to `['dashboard', 'project']` - an additive contract change.

Authorship produces a grant: creating a dashboard gives its creator an `edit`
grant on it. There is no exception for authors in the rule itself.

Places that show a project's numbers without a dashboard in between - the
catalog's formula preview - need a `project` grant.

Listings follow the same rule: the project page, the library and the product
search list only dashboards the caller could open.

## Consequences

- A Tenant Admin administers and sees no customer data unless someone grants
  it; the same for a Platform Admin, who in addition holds no read capability
  at all. Both properties are tested.
- Every refusal can say which half is missing (`missing: 'role' | 'grant' |
'role_and_grant'`), which is what the Effective Access view shows.
- Tests that are about something else give their users a project grant, the
  way a tenant would through a group (`grantProjectAccess` in the harness).
- The demo fixture grants through a group, `Portal-Leser`, so the explanation
  chain User → Gruppe → Freigabe → Projekt is visible from the first sign-in.

## Cross-track note

The Emergent track must make the same distinction for the comparison gates to
compare like with like. The widened `ObjectType` and the `DataAccessDecision`
shape are in the shared contracts package.
