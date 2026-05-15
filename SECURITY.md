# Security

## Pre-release checklist

- [ ] No `.env`, `*.db`, or backup blobs tracked (`git ls-files | grep -E '\.env$|\.db$'` should be empty).
- [ ] `JWT_SECRET` is set, not a placeholder, and at least 32 characters in production.
- [ ] `CORS_ORIGIN` lists explicit origins in production (not `*`).
- [ ] `DATABASE_URL` and DB credentials use a secret manager or restricted env on the host.
- [ ] Uploaded files are only reachable via `/api/files/uploads/*` (authenticated), not a public static path.
- [ ] Run `npm audit` in `backend/` and `frontend/`; address critical/high issues or document exceptions.
- [ ] Run Gitleaks: `pre-commit run gitleaks --all-files` or the GitHub Action on a PR.

## Reporting vulnerabilities

Contact the repository maintainers privately; do not open a public issue for undisclosed security problems.

## Token model

- JWTs include a `jti` claim. `POST /api/auth/logout` with `Authorization: Bearer` revokes that session server-side.
- Failed login lockout: after repeated failures, accounts are temporarily locked (see `AUTH_LOCK_*` env vars in `.env.example`).
