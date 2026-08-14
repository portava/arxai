---
name: Verifying merged code is actually running (dev) + LIVE_DELAYED transience
description: How to prove a merged backend/frontend change is live in the dev preview, and why an honest transient verdict can be "invisible" without being broken.
---

# "Merged but not showing" — how to diagnose without touching feature code

When a merged change "isn't visibly running," confirm the running artifacts
before suspecting the code, all read-only:

1. **Code on main:** `git --no-optional-locks log --oneline` + `git ... merge-base
   --is-ancestor <commit> HEAD`. HEAD is usually *ahead* of the merged commit (later
   merges stacked on top); ancestor-check proves the fix is included.
2. **Backend running new code:** the api-server dev script is
   `build && start` → it runs the **built bundle** `dist/index.mjs`, NOT a
   source watcher. So the running process only has new code if the workflow was
   restarted (which rebuilds). Prove it two ways: (a) `ps -eo pid,lstart,args`
   start time of `node ./dist/index.mjs` vs the commit time; (b) grep the built
   bundle itself — `rg -c "<new-symbol>" artifacts/api-server/dist/index.mjs`.
   Bundle freshness (mtime) > HEAD commit time + the new token present = running
   new code. This sidesteps all timeline guessing.
3. **Frontend:** the dashboard runs **Vite dev** (`vite --host`), which serves
   `src/` transformed on the fly — there is **no served prebuilt bundle in dev**.
   A stale `dist/` is irrelevant to the preview (it only matters for a *published*
   deployment, which builds fresh on publish). So "stale frontend bundle" is a
   deploy-only failure mode, not a dev-preview one. A long-open browser tab can
   still hold pre-restart modules — hard refresh.
4. **Runtime proof for per-user routes:** mint an ephemeral `auth_user_sessions`
   row (cookie `arx_user_session` = raw token, DB stores `sha256` hex in
   `token_hash`), `fetch`/curl through the proxy `localhost:80`, then DELETE the
   row. Use an OWNER/ADMIN user id to avoid simulator masking.

**Why:** post-merge.sh only does `pnpm install` + `drizzle-kit push-force` — it
does NOT build the frontend or restart workflows (the platform's separate
workflow-reconciliation step restarts them). A *failed/timed-out* post-merge can
skip that restart, but a later successful merge or any workflow restart supersedes
it, and the db push itself completes ("[✓] Changes applied") before a timeout.

## LIVE_DELAYED (and similar honest verdicts) can be correctly invisible

The shared feed verdict is tri-state: LIVE (tick fresh AND bar fresh) /
LIVE_DELAYED (tick fresh but bar stale) / AWAITING (no tick). `LIVE_DELAYED` only
renders during an actual tick-alive/bar-stale window. When the Deriv synthetic +
MT5 feeds are genuinely healthy, every symbol resolves to LIVE and LIVE_DELAYED
legitimately appears nowhere — that is correct honesty, not a missing-code bug.
Before concluding a verdict "never shows," confirm the live feed is actually in
that intermediate state (probe `/api/chart/feed-status`: `feedReadinessState`,
`stale`, `quality`, `lastTickTime` vs `lastCandleTime`).
