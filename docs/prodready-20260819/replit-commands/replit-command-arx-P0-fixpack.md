# Replit command — ARX P0 fix pack (approved 2026-08-19)

Paste this file's instructions to Claude Code in the Replit shell (workspace `arxai`), or apply `fixpack/fixpack.diff` / drop the files from `fixpack/files/` over the repo root. All changes were pre-verified against a snapshot of `main` @ `8f115c2`: api-server typecheck clean, 56/56 `ci:guards` pass.

## Scope — 5 files, no behavior change outside the listed items

1. **`artifacts/api-server/src/app.ts`** — two hardening changes:
   - `SESSION_SECRET` becomes **fatal when missing in production** (mirrors the existing `PORT` posture in `index.ts`). Dev/test keep the fallback so local workflows are unchanged.
   - `cors()` is no longer mounted wildcard in production. Production mounts CORS **only** for origins listed in a new optional env `ARX_CORS_ALLOWED_ORIGINS` (comma-separated); unset ⇒ same-origin only. Dev/test keep permissive CORS unchanged. The EA is unaffected (WebRequest is not a browser); the dashboard calls the API same-origin via the relative `/api` base.

2. **`artifacts/api-server/src/lib/auth/globalGate.ts`** — comment-only: the stale "Phase 3 pending / User A can see User B's data" block is replaced with the accurate closed status per `docs/TODO_PER_USER_ISOLATION.md` (resolved May 17, 2026). No code change.

3. **`docs/LAUNCH_CANDIDATE.md`** — "16 gates" → "23 gates" (both occurrences); guard count "21/21" → "56/56".

4. **`docs/KNOWN_ISSUES.md`** — the claim that `ARX_LIVE_BROKER_EXECUTION_ENABLED` is unset in dev and prod is corrected to the actual posture (code default false; intentionally `"true"` in this environment for controlled owner/admin live testing, satisfying gate #1 of 18 only).

5. **`replit.md`** — "All 5 trading strategies" → "All 7 trading strategies" (the engine has 7: trend continuation, break of structure, liquidity sweep, volatility expansion, pullback continuation, mean reversion, session breakout).

## Apply + verify

```bash
git checkout -b fix/p0-fixpack-20260819
# apply the diff or drop the files, then:
pnpm --filter @workspace/api-server run typecheck
pnpm run ci:guards
```

Both must be green. Then run the full `pnpm run ci` if time permits (it was not run on the local snapshot — DB-backed lanes need the sanctioned CI database, never the Replit shell's production `DATABASE_URL` per standing rule).

## Deployment note (owner action)

After merge, confirm the deployment secrets include a real `SESSION_SECRET`. With this change, production **will refuse to boot** without one — that is the point. If the deploy fails on the new error message, set the secret in the Replit deployment configuration and redeploy. Do NOT set `ARX_CORS_ALLOWED_ORIGINS` unless a genuinely cross-origin client appears.

## Explicitly NOT in this pack

- No change to any execution gate, EA endpoint, or safety contract.
- `check-no-user-facing-paper-only` remains unregistered (65 pre-existing violations — separate cleanup phase).
- Bridge-v2 missing endpoints (`GET /api/bridge/v2/config`, `/commands`) — separate build slice.
