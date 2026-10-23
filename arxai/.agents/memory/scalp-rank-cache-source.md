---
name: Broad scan + Ruby opportunities read on-demand, not the frontend cache
description: Where Broad scalp rank, Ruby's opportunities tool, and the opportunity radar get their scored rows (on-demand scanSymbolTimeframe, NOT the frontend-driven cache)
---

Broad scalp ranking (`rankScalpsForUniverse` → `/me/scalp/rank`) reads its
candidates via `buildRankInputs` → `scanSymbolTimeframe` — an **on-demand LIVE
read per symbol**. It does **NOT** depend on the background/frontend-driven
scanner cache, so it returns live results immediately on a freshly restarted
api-server (the file's own header comments and `buildRankInputs` docstring state
this). The old belief that `/me/scalp/rank` returns `scanned: 0` on a fresh
server because it reads an empty cache is **stale** — that is no longer how it
works.

Ruby's broad market intelligence is the same shape: the opportunities tool and
the per-user opportunity radar both route through `scanCoreOpportunities`
(`lib/data/marketOverview.ts`), which loops the SAME single scoring path
(`scanSymbolTimeframe`) and keeps ONLY `dataStatus === "live"` rows. So Ruby's
opportunities also work immediately on a fresh server and never depend on the
frontend cache.

**Why:** the single scoring path (`scanSymbolTimeframe`) is the source of truth
for scored rows; reading the frontend-driven cache made results depend on
whether the Scanner page had been polled, which is fragile and surfaces a
misleading empty state.

**How to apply:** the in-memory `scannerOpportunities(n)` cache (populated by the
scanner's `scanOnce` loop) is now only read by the **Scanner page route**
(`routes/scanner.ts`). Do not assume Broad scan, the Ruby opportunities tool, or
the radar read it. If any of those return empty, it is an honest no-live-feed /
no-live-row result from the on-demand scan, never an unfilled cache — never
"fix" it by fabricating or forcing a server-side scan onto the request hot path.

Still true: new Express routes registered in `routes/index.ts` are NOT picked up
by the running api-server until the workflow is restarted (the `/api/me/*` auth
gate returns 401 before routing, so an unregistered route shows 401
unauthenticated but "Cannot POST" 404 once authenticated — restart fixes it).
