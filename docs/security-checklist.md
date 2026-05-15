# Security checklist (release)

Use before tagging a production release (see also [`../SECURITY.md`](../SECURITY.md)).

- [ ] `JWT_SECRET` set, strong, not a known placeholder; `NODE_ENV=production`.
- [ ] `CORS_ORIGIN` explicit list — no `*` / `CORS_ALLOW_ALL` in production.
- [ ] `DATABASE_URL` and admin credentials only on the host / secret manager — not in the repo.
- [ ] No public static route for `uploads/`; attachments only via `/api/files/uploads/*`.
- [ ] `npm audit` run for `backend/` and `frontend/`; critical/high issues triaged.
- [ ] Gitleaks / pre-commit secrets scan clean on changed files.
- [ ] Smoke test: login, one stock read, one outbound list, one delivery note read.
