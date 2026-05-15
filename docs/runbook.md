# Operations runbook

## Rotate JWT secret

1. Generate a new secret: `openssl rand -hex 64`.
2. Set `JWT_SECRET` in the host environment (or secret manager).
3. Restart the Node process — **all** outstanding JWTs become invalid; users must log in again.
4. (Optional) If you add refresh tokens later, rotate using a `kid` claim for zero-downtime rotation.

## Database backup

- Take nightly `pg_dump` of the warehouse database to off-site storage.
- Do **not** commit `.db` / dumps into git.

## Restore from backup

1. Stop the API.
2. Restore Postgres from `pg_dump` into a clean database or overwrite target (with care).
3. Restore `backend/uploads` from backup if you store driver POD / attachments there.
4. Start the API and verify `/api/health` and a read-only report.

## Account lockout

If a user is locked out after failed logins, clear in SQL:

```sql
UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE username = 'their_username';
```

## Revoked tokens housekeeping

`revoked_tokens` grows with logouts. Periodically delete expired rows:

```sql
DELETE FROM revoked_tokens WHERE expires_at < NOW() - INTERVAL '7 days';
```

(Adjust interval to your longest JWT lifetime.)
