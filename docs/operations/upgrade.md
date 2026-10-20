# Upgrading an installation

Engineering MVP runbook. Rehearsed by Gate F10 (`npm run gate:f10`): the
previous release (`v0.9-themes-entitlements-diagnostics`) is checked out in a
separate worktree, creates its schema and the canonical fixture with its own
code, and the current release then upgrades that database.

## Procedure

1. Back up the database ([backup-and-restore.md](backup-and-restore.md)).
2. Stop the worker first (no job is claimed during the migration), then the
   API. The web server may keep running and shows the API as unreachable.
3. Deploy the new release and run the migrations once:

   ```bash
   npm run db:migrate
   ```

   Migrations are forward-only, deterministic SQL committed with the release
   (`packages/db/migrations`). Each is applied once and recorded in
   `__drizzle_migrations`; running the command again is a no-op.

4. Start the API, then the worker. `GET /readyz` answers `ready`;
   Administration → System shows the new product and schema version and the
   number of applied migrations.

## Rules the migrations follow

- Additive first: new tables and nullable columns, so the previous release
  could still read the database if a rollback of the code (not the schema) is
  needed.
- No migration rewrites or deletes product data. An enum that grows (audit
  actions, job kinds) is widened, never narrowed.
- No migration writes analytics data (Master Spec §4;
  `persistence-rules.test.ts` pins the table list).

## Rollback

Restore the backup taken in step 1 together with the previous release. A schema
downgrade is not offered in the MVP (classified: Production Readiness).

## What the rehearsal checks

- every table that existed before the upgrade keeps its row count;
- the new migrations are applied exactly once and the schema version matches
  the release;
- people of the old release sign in with their passwords; their dashboards,
  semantic definitions, themes and grants work under the new code;
- a second `db:migrate` changes nothing.
