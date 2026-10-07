# Backups and restore

ClearTrace keeps everything in one SQLite file (`/app/data/cleartrace.db` in Docker,
`DATABASE_URL` elsewhere). From v1.4.0 it ships three operator scripts that use only Node
built-ins and `better-sqlite3`:

| Script | What it does |
| --- | --- |
| `scripts/backup.mjs` | Online SQLite backup → `PRAGMA integrity_check` → AES-256-GCM encryption → `<data>/backups/cleartrace-<ISO>.db.enc`. Keeps the newest `BACKUP_KEEP` (default 7). |
| `scripts/restore.mjs` | Restores a backup over the live database, but only after every safety check passes (see below). |
| `scripts/check-key.mjs` | Confirms that `ENCRYPTION_KEY` decrypts the identity claims in a database. |

## Two secrets, stored apart

1. **`BACKUP_PASSPHRASE`** encrypts the backup file. The key is derived with scrypt
   (N=2^17, r=8, p=1, random 16-byte salt per file).
2. **`ENCRYPTION_KEY`** encrypts the identity claims *inside* the database (names, emails,
   phone numbers, addresses).

**A backup is useless without `ENCRYPTION_KEY`.** Restoring with the wrong key gives you a
database whose identity claims cannot be read. Escrow `ENCRYPTION_KEY` (and
`BACKUP_PASSPHRASE`) somewhere other than where the backups go: a password manager, a printed
copy in a safe, or your organization's secret store. Do not put them in the same bucket, disk
or restic repository as the backup files.

## Taking backups (Docker)

Add a passphrase to `.env` (`openssl rand -base64 48`):

```bash
BACKUP_PASSPHRASE=...
BACKUP_KEEP=7          # optional, default 7
```

One-off backup while the app runs (SQLite's online backup API is safe during writes):

```bash
docker compose up -d                       # picks up BACKUP_PASSPHRASE
docker compose exec cleartrace node scripts/backup.mjs
```

Scheduled backups: the `backup` service is off by default. Turn it on with its profile:

```bash
docker compose --profile backup up -d      # every BACKUP_INTERVAL_HOURS (default 24)
```

Backups land on the data volume at `/app/data/backups/`. The scripts log one JSON line with
counts only (tables, users, cases, claims, bytes, kept, removed) — never paths, names or claim
values. `--plaintext` writes an unencrypted `.db` instead; use it only when the destination is
already encrypted.

Bare metal: `DATABASE_URL=/var/lib/cleartrace/cleartrace.db BACKUP_PASSPHRASE=... node scripts/backup.mjs`.

### File format

`CTBK1` magic (5 bytes) · salt (16) · scrypt N, r, p (3 × uint32 BE) · IV (12) · GCM tag (16) ·
ciphertext. Everything before the IV is authenticated as GCM additional data, so a modified
header or ciphertext fails to decrypt.

## Offsite copies

Backups on the same disk as the database protect against mistakes, not against losing the
machine. Copy the encrypted backups (`/app/data/backups/cleartrace-*.db.enc`) offsite, and only
those: the same folder also holds pre-migrate / pre-restore snapshots, which are plaintext when
`BACKUP_PASSPHRASE` was not set when they were written, and which must not outlive their local
retention window (see [Local snapshots](#local-snapshots)). Two common tools:

**restic** (deduplicating, encrypted repository):

```bash
# once
restic -r s3:s3.amazonaws.com/my-bucket/cleartrace init
# daily, e.g. from host cron after the backup service has run: stage ONLY the newest
# encrypted backup (never the whole backups folder) in an owner-only directory.
install -d -m 700 ./cleartrace-backups
latest=$(docker compose exec -T cleartrace sh -c 'ls -1 /app/data/backups/cleartrace-*.db.enc | tail -n 1' | tr -d '\r')
docker compose cp "cleartrace:$latest" ./cleartrace-backups/
restic -r s3:s3.amazonaws.com/my-bucket/cleartrace backup ./cleartrace-backups --exclude 'pre-*'
rm -f ./cleartrace-backups/*.db.enc
restic -r s3:s3.amazonaws.com/my-bucket/cleartrace forget --keep-daily 7 --keep-weekly 8 --prune
```

**rclone** (plain copy to any cloud remote):

```bash
install -d -m 700 ./cleartrace-backups
latest=$(docker compose exec -T cleartrace sh -c 'ls -1 /app/data/backups/cleartrace-*.db.enc | tail -n 1' | tr -d '\r')
docker compose cp "cleartrace:$latest" ./cleartrace-backups/
rclone copy ./cleartrace-backups remote:cleartrace-backups --include 'cleartrace-*.db.enc'
rm -f ./cleartrace-backups/*.db.enc
```

The `cleartrace-*.db.enc` files are already encrypted, so a plain copy of them is safe; the
restic repository adds a second layer. Keep the restic password with your other escrowed
secrets, not on the server.

### Local snapshots

ClearTrace also writes two kinds of full database copies to `/app/data/backups`:

- `pre-migrate-v<N>-<ts>.db` before a schema upgrade (see [upgrade.md](./upgrade.md));
- `pre-restore-<ISO>.db`, the database a restore replaced.

With `BACKUP_PASSPHRASE` set (in the app container for pre-migrate snapshots, and for
`restore.mjs`) both are written encrypted as `.db.enc` in the backup format above, and
`restore.mjs` can restore them. Either way they are deleted once they are older than
`BACKUP_SNAPSHOT_RETENTION_DAYS` (default 30), by the worker tick and by every backup run.
Because they are copies, a case you erase stays inside any snapshot taken before the erasure
until that snapshot expires; lower the retention, or delete old snapshots by hand, if you need
an erasure to take effect sooner. They are never meant to leave the server.

Test a restore from the offsite copy now and then (below). An untested backup is a guess.

## Restoring

`restore.mjs` refuses, and changes nothing, unless all of these hold:

1. **The app is stopped.** It probes `CLEARTRACE_URL` (default
   `http://127.0.0.1:3000/api/health`; it only probes and never starts anything), and it must
   be able to take an exclusive lock on the live database. An open app connection blocks the
   lock, even from another container on the same volume.
2. The backup decrypts with `BACKUP_PASSPHRASE` and passes `PRAGMA integrity_check`.
3. Its schema version is not newer than this release (`database is newer than this ClearTrace
   version — restore a backup or upgrade`). An older backup is fine: the app migrates it on the
   next start, taking a pre-migrate snapshot first.
4. `ENCRYPTION_KEY` decrypts its identity claims (`check-key.mjs`).

Only then does it move the current database to `backups/pre-restore-<ISO>.db` (encrypted to
`.db.enc` when `BACKUP_PASSPHRASE` is set), swap the restored file in and remove stale `-wal` /
`-shm` files. The set-aside copy expires with the other local snapshots.

Docker:

```bash
docker compose stop cleartrace
docker compose run --rm --no-deps cleartrace node scripts/restore.mjs /app/data/backups/cleartrace-<ISO>.db.enc
docker compose up -d
```

Restoring a file from outside the volume (for example an offsite copy):

```bash
chmod a+r ./cleartrace-<ISO>.db.enc        # the container runs as a non-root user
docker compose run --rm --no-deps -v "$PWD:/restore:ro" cleartrace \
  node scripts/restore.mjs /restore/cleartrace-<ISO>.db.enc
```

Restoring onto a new machine: copy `.env` (same `ENCRYPTION_KEY`, `SESSION_SECRET` and
`BACKUP_PASSPHRASE`), build the image (`docker compose build`), run the restore command above
(`docker compose run` creates the empty data volume), then `docker compose up -d`.

Exit codes: `0` restored, `2` refused (bad passphrase, wrong key, newer schema, corrupt file),
`3` refused because the app is running.

Check a key without restoring:

```bash
docker compose exec cleartrace node scripts/check-key.mjs /app/data/cleartrace.db
```

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `BACKUP_PASSPHRASE` | — (required unless `--plaintext`) | backup, restore |
| `BACKUP_KEEP` | `7` | backup |
| `BACKUP_DIR` | `<dirname(DATABASE_URL)>/backups` | backup, restore |
| `BACKUP_INTERVAL_HOURS` | `24` | compose `backup` service |
| `CLEARTRACE_URL` | `http://127.0.0.1:3000/api/health` | restore (probe only) |
| `ENCRYPTION_KEY` | — (required) | restore, check-key |
