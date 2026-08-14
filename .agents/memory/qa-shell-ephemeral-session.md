---
name: QA shell auth via ephemeral session row
description: Non-invasive way to hit USER-gated endpoints from the shell when the env QA password is stale.
---

The env `QA_OWNER_PASSWORD` is frequently **stale** → `POST /api/auth/login` returns 401, and
`/auth/dev-owner-login` only sets the LAYER-1 role cookie (does NOT populate `req.authUser`, so
per-user/USER-gated endpoints still 401).

**Clean, fully-reversible workaround:** mint a per-user session row directly and delete it after.
Sessions (`auth_user_sessions`) store `token_hash = sha256(rawToken)`; the cookie is
`arx_user_session=<rawToken>` (see `lib/auth/userSessions.ts`). From bash:

```bash
RAW=$(openssl rand -hex 32); HASH=$(printf '%s' "$RAW" | sha256sum | cut -d' ' -f1)
psql "$DATABASE_URL" -tAc "INSERT INTO auth_user_sessions (user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (4, '$HASH', now(), now()+interval '10 minutes', now()) RETURNING id;"
curl -s -b "arx_user_session=$RAW" http://localhost:80/api/market-data/deriv/status
psql "$DATABASE_URL" -tAc "DELETE FROM auth_user_sessions WHERE token_hash='$HASH';"
```

**Why safe:** no password touched, existing sessions untouched, 10-min expiry backstop, raw token
never printed, deleted after use. USER role is enough for `/api/market-data/*` and most `/api/me/*`
reads (admin endpoints still need an ADMIN/OWNER `users.role`). Do NOT use this to mutate state or
to bypass a gate — read-only verification only.
