# Deployment (summary)

## Environment

Required for production:

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | At least 32 characters of entropy; not a placeholder string |
| `CORS_ORIGIN` | Comma-separated browser origins (no `*` in production) |

Optional:

| Variable | Purpose |
|----------|---------|
| `PG_POOL_MAX` | Postgres pool size (default 25) |
| `PG_CONNECTION_TIMEOUT_MS` | Wait for a free pool client before error (default 10000) |
| `PG_IDLE_TIMEOUT_MS` | Close idle clients after this many ms (default 30000) |
| `LOG_LEVEL` | `info`, `debug`, etc. for `pino` |
| `AUTH_LIMIT_MAX` / `AUTH_LIMIT_WINDOW_MS` | Per-IP login rate limit |
| `AUTH_USER_LIMIT_MAX` / `AUTH_USER_LIMIT_WINDOW_MS` | Per-username login rate limit |
| `AUTH_LOCK_MAX_ATTEMPTS` / `AUTH_LOCK_MINUTES` | Account lockout after failed logins |
| `GOOGLE_WEB_CLIENT_ID` | Google OAuth web client ID (server verifies ID tokens) |
| `GOOGLE_ANDROID_CLIENT_ID` | Google OAuth Android client ID |
| `GOOGLE_IOS_CLIENT_ID` | Google OAuth iOS client ID (future) |
| `JWT_MAX_LIFETIME_DAYS` | Max JWT lifetime (default 7; cap 30) |

Frontend (Vite): `VITE_GOOGLE_WEB_CLIENT_ID` — same value as `GOOGLE_WEB_CLIENT_ID`.

Mobile (Expo): `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, optional `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`.

## Process

1. Run DB migrations on startup (automatic via `warehousePostgresDb` + `schema-migrate`).
2. Place `backend/uploads` on persistent disk; never expose it as a public static URL.
3. Put Node behind nginx/Caddy with TLS; proxy `/api` to the Node port.
4. Build the SPA (`frontend/dist`) and serve it from nginx or the same host as the API.

## VPS sync does not replace the database

`bash scripts/sync-to-vps.sh --deploy` (or `deploy/vps/rsync-to-godaam-vps.sh --deploy`) only:

- Copies application **code** to `/opt/godaam` (rsync excludes `.env` and `backend/warehouse.db`)
- Rebuilds the frontend and **restarts** `godaam-backend`
- On startup, **`migrateGodamSchema` adds** missing columns/tables only — it does not truncate or drop business data

Production data lives in **PostgreSQL** at `DATABASE_URL` in `/etc/godaam/backend.env` (not in the git repo). That file is **not** overwritten by rsync.

**Never run on the VPS against production `DATABASE_URL`:**

| Command | Risk |
|---------|------|
| `npm run fresh-db` / `wipe-db` | Deletes warehouse data |
| `npm run migrate:sqlite-to-pg` | Can **DROP** tables when copying from SQLite |
| `npm run pg:bootstrap` | Copies SQLite into PG if PG looks empty |
| `npm run seed:*` | Inserts test/demo data |

After each deploy, the script prints a **PostgreSQL check** (database name + user count) so you can confirm the API still points at the same DB.

If data “disappeared” after deploy, usual causes are: `DATABASE_URL` changed to a different/empty database, Postgres volume was recreated, or a wipe/migrate/seed script was run on the server — not rsync itself.

## Local Docker Postgres

`docker-compose.godam-postgres.yml` maps **`127.0.0.1:5432`** only (not all interfaces). Default URL in `.env.example` and `./dev.sh` matches `POSTGRES_USER` / `POSTGRES_DB` / password in that file. Set `TZ=UTC` in the container for consistent timestamps.

See also [`runbook.md`](./runbook.md) and root [`SECURITY.md`](../SECURITY.md).
