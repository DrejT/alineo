# `@alineo-labs/telemetry`

The ingest server for `alineo` CLI telemetry. One route — `POST /v1/events` — writing to a
SQLite file. Standalone by design: no workspace dependencies in either direction, so it builds
and runs without the monorepo (see `db.ts` on why its event interface is duplicated rather than
imported).

Public at `https://telemetry.alineo.tech`, which Caddy proxies to `127.0.0.1:3002` on the VPS.

## Running it

```bash
bun run server                        # port 3002, db at ./data/telemetry.db
docker compose up -d --build          # the same thing, how it runs in production
```

`TELEMETRY_DB_PATH` and `PORT` are the only knobs.

## The database

SQLite in WAL mode, bind-mounted from `./data` rather than living in a named volume or an image
layer — the file already exists on the VPS with real history in it, and this keeps it readable
from the host with `sqlite3`/`bun` and backed up by copying files.

**A backup must include `telemetry.db-wal`.** The main file is a few KB; in WAL mode
essentially every event sits in the `-wal` until a checkpoint, so copying `telemetry.db` alone
gives you an empty database that looks like a real one. Either copy all three files, or take a
consistent single-file snapshot:

```bash
bun -e 'new (require("bun:sqlite").Database)("data/telemetry.db",{readonly:true})
        .run("VACUUM INTO \"/tmp/telemetry-backup.db\"")'
```

## Why Docker, and what it replaced

This ran as a `alineo-telemetry.service` systemd user unit from August 2026. Both its
`WorkingDirectory` and its `TELEMETRY_DB_PATH` pointed at `/home/drejt/drej-oss/...`, a path
that stopped existing when the repo was renamed to `alineo`. The process survived only because
it already held the open file descriptor — `/proc/<pid>/fd` showed the renamed path — so it
kept writing correctly while being, in fact, unrestartable. A reboot would have taken telemetry
down until someone edited the unit.

The container has no such hidden state: the path it uses is the path in the compose file.

## Deploying a change

No CI. On the VPS:

```bash
cd ~/alineo && git pull
cd apps/telemetry && docker compose up -d --build
curl -s https://telemetry.alineo.tech/health
```

## Migrations

`migrate-command-names.ts` runs at boot, bringing rows written by a pre-0.4.0 CLI onto the
current verbs (`spawn`→`start`, `fork`→`spawn`, `kill`→`stop`). It is keyed on `cli_version`
rather than a date, because old CLIs keep sending the old vocabulary long after a new one
ships — and pre-0.4.0 `spawn` meant "create a root agent", which is today's `start`, while
post-0.4.0 `spawn` means "create a child". The same string, two actions, in one column.

Unlike the migrations in `apps/alineod` and `packages/ledger`, this one records that it ran, in
a `migrations` table. Those are idempotent by construction — `WHERE event IN (…old names…)`
matches nothing on a second pass. That argument does not survive a _chained_ rename: once this
has run, a pre-0.4.0 row reading `spawn` is a migrated `fork`, indistinguishable from an
unmigrated `spawn` that a second pass would rewrite to `start`.
