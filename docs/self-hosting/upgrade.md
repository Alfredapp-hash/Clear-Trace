# Upgrading and rolling back

## How schema upgrades work (v1.4.0 and later)

The database carries a schema version (`PRAGMA user_version`). On startup ClearTrace runs
every migration newer than that version (`src/lib/db/migrations.ts`):

- **Before migrating** a database that already holds data, it writes a consistent copy with
  `VACUUM INTO` to `<data>/backups/pre-migrate-v<from>-<timestamp>.db` (`/app/data/backups` in
  Docker, owner-only permissions). With `BACKUP_PASSPHRASE` set in the app container the copy
  is encrypted to `pre-migrate-v<from>-<timestamp>.db.enc` (the backup format) and the
  plaintext copy removed. A brand-new empty database gets no snapshot. Snapshots are deleted
  after `BACKUP_SNAPSHOT_RETENTION_DAYS` (default 30).
- Each migration runs in its own `BEGIN IMMEDIATE` transaction that also bumps the version.
  If one fails, the database stays at the previous version and the app does not start; the
  log line names the migration.
- A database from before v1.4.0 has version 0. Migration v1 is the v1.3.0 baseline and is a
  no-op on an up-to-date v1.2 / v1.3 database; v2 adds the ongoing-protection tables.
- If the database is **newer** than the image (you rolled the image back but not the data),
  startup stops with `database is newer than this ClearTrace version — restore a backup or
  upgrade`. ClearTrace never runs a newer database on older code.

Migrations log only the migration name and its duration.

## Upgrade checklist (Docker)

1. Take a backup and copy it offsite (see [backup-restore.md](./backup-restore.md)):
   `docker compose exec cleartrace node scripts/backup.mjs`.
2. Note the image you are running now (`docker compose images cleartrace`), or the git tag you
   built it from. That is your rollback image.
3. `git pull` (or check out the new tag), then `docker compose up -d --build`.
4. Watch the logs: `docker compose logs -f cleartrace` shows one `db.migration` line per
   migration and a `server.start` line with `version` and `schemaVersion`.
5. `curl -fsS http://127.0.0.1:3000/api/health`.

## Rolling back

Rollback = **the pre-migrate snapshot + the previous image**. Rolling back only the image does
not work once the schema has moved forward (the old code refuses the newer database).

```bash
docker compose stop cleartrace
# 1. Previous image: check out the previous tag and rebuild (or retag your saved image).
git checkout v1.3.0 && docker compose build cleartrace
# 2. Put the pre-migrate snapshot back as the live database.
docker compose run --rm --no-deps --entrypoint sh cleartrace -c '
  cd /app/data &&
  ls backups/pre-migrate-v*.db &&
  mv cleartrace.db backups/rolled-back-$(date -u +%Y%m%dT%H%M%SZ).db &&
  rm -f cleartrace.db-wal cleartrace.db-shm &&
  cp backups/pre-migrate-v0-<timestamp>.db cleartrace.db'
docker compose up -d
```

Anything written between the upgrade and the rollback is not in the snapshot. If you need it,
keep the `rolled-back-*.db` file and re-apply those changes by hand, or roll forward instead.

If the snapshot is encrypted (`.db.enc`), restore it with `scripts/restore.mjs` from the
previous image instead of the `cp` step above (stop the app first; see backup-restore.md):
`docker compose run --rm --no-deps cleartrace node scripts/restore.mjs /app/data/backups/pre-migrate-v0-<timestamp>.db.enc`.

Without `BACKUP_PASSPHRASE` a pre-migrate snapshot is an unencrypted SQLite file (same
protection as the live database: it lives on the data volume with owner-only permissions).
Either way it is a full copy, so cases erased after the upgrade stay in it until it expires:
the worker and every backup run delete snapshots older than `BACKUP_SNAPSHOT_RETENTION_DAYS`
(default 30). Roll back within that window, or raise it before upgrading if you need longer.
Never copy snapshots offsite.

To roll back to an encrypted backup instead of the snapshot, use `scripts/restore.mjs` from the
image whose schema version is at least the backup's (see backup-restore.md).
