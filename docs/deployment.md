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

## Process

1. Run DB migrations on startup (automatic via `warehousePostgresDb` + `schema-migrate`).
2. Place `backend/uploads` on persistent disk; never expose it as a public static URL.
3. Put Node behind nginx/Caddy with TLS; proxy `/api` to the Node port.
4. Build the SPA (`frontend/dist`) and serve it from nginx or the same host as the API.

## Local Docker Postgres

`docker-compose.godam-postgres.yml` maps **`127.0.0.1:5432`** only (not all interfaces). Default URL in `.env.example` and `./dev.sh` matches `POSTGRES_USER` / `POSTGRES_DB` / password in that file. Set `TZ=UTC` in the container for consistent timestamps.

See also [`runbook.md`](./runbook.md) and root [`SECURITY.md`](../SECURITY.md).
