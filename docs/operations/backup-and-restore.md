# Backup and restore

Engineering MVP runbook. Rehearsed by Gate F10 (`npm run gate:f10`), which
backs up a seeded installation, destroys its database, restores it and checks
that the product state is identical and still usable.

## What holds product state

| Store                         | Contents                                                                                                                                                                                | Back up?                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| MySQL database (`axp`)        | All product configuration: tenants, people, roles, grants, dashboards and their versions, semantic catalog, connections (credentials encrypted), shares, schedules, themes, audit trail | **Yes** - this is the product state                                       |
| `CREDENTIAL_ENCRYPTION_KEY`   | Key for stored Matomo tokens, export files and diagnostic bundles                                                                                                                       | **Yes, separately** from the database dump, in the secret store           |
| `SESSION_SECRET`              | Required by the configuration; sessions are random tokens stored as hashes in the database, so nothing is signed with it                                                                | With the other secrets, to start the same configuration again             |
| `.local/exports` (export dir) | Encrypted export files and diagnostic bundles, minutes to hours old                                                                                                                     | **No** - ephemeral by design (ADR 0009); a restore simply has none        |
| Matomo                        | All analytics data                                                                                                                                                                      | Not ours - Matomo is the only analytics store and is backed up on its own |

A dump without the matching `CREDENTIAL_ENCRYPTION_KEY` restores everything
except the Matomo credentials, which then have to be entered again per
connection ("replace credential"). Nothing else depends on the key.

## Backup

Consistent online dump, no downtime (InnoDB, single transaction):

```bash
mysqldump --single-transaction --routines --triggers --no-tablespaces \
  --set-gtid-purged=OFF --default-character-set=utf8mb4 axp > axp-backup.sql
```

With the Docker stack: `docker compose exec -T mysql mysqldump … axp > axp-backup.sql`.
Store the dump encrypted; it contains people's names and addresses and the
audit trail (no analytics values, no plaintext credentials).

## Restore

1. Stop the API and the worker (the web server may stay up; it shows the API
   as unreachable).
2. Recreate the database and load the dump:

   ```bash
   mysql -e "DROP DATABASE IF EXISTS axp; CREATE DATABASE axp CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
   mysql axp < axp-backup.sql
   ```

3. Make sure the environment carries the same `CREDENTIAL_ENCRYPTION_KEY` as
   when the dump was taken.
4. Run `npm run db:migrate` - a no-op for a dump of the same version, the
   upgrade path for an older one (see [upgrade.md](upgrade.md)).
5. Start API and worker; `GET /readyz` answers `ready`. Administration →
   System shows the expected schema version.

Sessions in the dump are valid again after a restore. To force everyone to sign
in, truncate `sessions` before starting the API.

## What the rehearsal checks

- every product table has the same row count and content checksum before the
  backup and after the restore;
- people sign in with their existing passwords;
- a dashboard shows the same values as before (the restored, encrypted Matomo
  credential opens with the configured key);
- the audit trail is complete, including the entries written before the
  backup.
