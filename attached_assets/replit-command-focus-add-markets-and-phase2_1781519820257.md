# COMMAND — FOCUS LOCK: ADD JUMP/BOOM-CRASH MARKETS (Tier 1) + PHASE 2 (backtest/dashboard/admin/watchlist)

Read this entire command before changing anything. Two parts in one pass because both touch the market registry: PART A grows the approved universe by 7 synthetic markets; PART B extends Focus-Lock enforcement to the remaining display surfaces (Phase 2). Phase 1 (registry + scanner/chart/Ruby/trade + API/live backstop) is ALREADY MERGED (`67f7288e`) — do not rebuild it; extend it. **Read the LIVE source for `lib/domain/src/market/arxFocusMarkets.ts` first** — any file contents quoted from older archives are stale. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## PART A — ADD 7 MARKETS TO THE REGISTRY (all Tier 1)

The merged registry has 36 markets including BOOM1000, CRASH1000, BOOM500, CRASH500. Add these 7 (registry → 43):

1. Jump 10 Index
2. Jump 25 Index
3. Jump 50 Index
4. Jump 75 Index
5. Jump 100 Index
6. Boom 300 Index
7. Crash 300 Index

All `category: "synthetic"`, `priorityTier: "tier_1"`, `sessionProfile: "24_7"`, `riskProfile` matching the existing synthetic entries' convention, `visibility: "approved_only"`, `enabledFor*` flags matching the other synthetics (scanner/chart/Ruby/backtest/live all true unless an existing synthetic sets one false — mirror the pattern).

### CRITICAL — REAL BROKER/DERIV SYMBOL IDS, NOT GUESSES (this is where "approved but won't open" bugs live)
Each new entry's `canonicalSymbol`, `aliases`, and `mt5Aliases` must use the ACTUAL symbol strings the connected broker/data provider uses — confirm each against the live Deriv symbol map / `resolveDerivSymbol` / the provider routing map / `getBrokerSymbolSpec`, exactly as was done for the existing synthetics and the 1s variants. Standard Deriv ids are typically `JD10/JD25/JD50/JD75/JD100` (Jump) and `BOOM300N`/`CRASH300N` (300 variants) — but VERIFY against this deployment's actual subscribed symbols rather than hardcoding these. For ANY of the 7 where the real symbol/tick cannot be confirmed against the live provider, FLAG it in the report rather than shipping an alias that won't resolve.
- Confirm `resolveArxMarket("Jump 75 Index")` etc. resolve distinctly (no collision with each other or with existing entries).
- Confirm each resolves through the SAME per-symbol Deriv feed path the existing synthetics use (so the per-symbol live/awaiting truth and the live-entry synthetic floor work for them too — do not create a synthetic that bypasses the per-symbol feed verdict).
- Add each to the default-order list in the correct position (group with the other synthetics).

### Tier 1 priority
Add all 7 to the Tier-1 set so they get scanner/cache/chart-prefetch/Ruby-depth priority alongside the existing Tier-1 markets.

### Tests for the additions
- `resolveArxMarket` resolves each of the 7 by canonicalSymbol AND each alias/mt5Alias.
- Registry count is now 43; categories/tiers correct.
- Each of the 7 resolves through the per-symbol Deriv feed path (live vs awaiting), same as existing synthetics.
- The existing 36 still resolve (no regression).

## PART B — PHASE 2: ENFORCE FOCUS LOCK ON THE REMAINING SURFACES

Phase 1 covered scanner/chart/Ruby/trade + the API/live backstop. Phase 2 extends the SAME registry + helpers (`isApprovedArxMarket` / `resolveArxMarket` / `getAllApprovedArxMarkets` / `getApprovedMarketsByCategory` / `getTierOneMarkets`) to the display surfaces that can still leak or display non-approved markets. Reuse the helpers — do NOT add a parallel list or re-implement matching.

### NON-NEGOTIABLE RULES (carry over from Phase 1)
- Additive only. No relaxation of any gate, the synthetic floor, SL policy, or owner/admin relaxations. No trading-path change.
- Position management is NEVER blocked: closing/modifying/cancelling an existing position on ANY symbol works regardless of approval (only NEW-entry discovery/placement is locked — already true from Phase 1; do not regress it).
- Saved/historical user data for now-unapproved markets is HIDDEN/ARCHIVED from the active UI, never hard-deleted (the user may have history on a symbol that's no longer approved — preserve it, just don't surface it).
- Owner/admin diagnostic visibility of the full provider symbol set may remain, but ONLY behind a developer/admin-only diagnostic mode that is not visible to normal users.

### Surfaces to lock

**Backtesting:**
- Symbol selector shows approved markets only.
- Historical candle requests only run for approved symbols (guard at the backtest data path with `resolveArxMarket`; unapproved → blocked envelope, no fetch).
- Backtest reports/results never contain unapproved symbols.
- Saved backtests on now-unapproved symbols are hidden/archived from the active UI (not deleted).

**Dashboard:**
- Market cards, top movers, and any watchlist widget show approved markets only (filter through `resolveArxMarket`).
- If the user previously saved an unapproved market, hide it from the active UI (preserve the record).
- No placeholders for "future"/"coming soon" markets.

**Watchlist / saved markets:**
- Watchlist contents are filtered to approved markets in the UI.
- Adding to watchlist only accepts approved markets (backstop the add endpoint with `resolveArxMarket`).
- Unapproved saved entries are hidden/archived, not deleted.

**Admin market views:**
- Admin market management clearly indicates the current ARX approved universe (the 43).
- Admin does not surface provider symbols outside the approved list to NORMAL users; any full-provider/diagnostic view is admin/developer-only and not visible to normal users.

**Remaining API endpoints (Phase-2 surfaces):**
- Backtest routes, watchlist/saved-market routes, dashboard market-data routes (top movers/cards) validate the requested symbol via `resolveArxMarket` before any work; unapproved → the clean blocked envelope `{ requestedSymbol, isApprovedMarket:false, blocked:true, reason:"Market is outside the active ARX approved market universe." }`, no data fetched, no provider leak. Approved → the extended envelope with `isApprovedMarket:true, category, priorityTier, dataSource, freshness`.

### UI chrome (carry the Phase-1 pattern to these surfaces)
- Category chips render only categories with ≥1 approved market (now: Synthetics, Forex Majors, Forex Minors, Metals, Indices, Crypto).
- Search placeholder "Search approved ARX markets"; empty state "No approved ARX market found." — no external/"try another global market" suggestions.
- The "ARX Focus Markets" badge appears where appropriate on these surfaces.

### Phase-2 tests
- Backtest/watchlist/dashboard data endpoints block unapproved symbols (blocked envelope, no fetch); approved pass.
- Watchlist add rejects an unapproved symbol; an existing unapproved saved entry is hidden from the active list but still present in storage (not deleted).
- Dashboard cards/top-movers contain only approved symbols.
- Admin full-provider view is not reachable by a normal (non-admin) user.
- Position-management for an unapproved-but-open symbol is still allowed (no Phase-2 regression of the Phase-1 exemption).

## VERIFY + QA

Run for real, paste outputs: typecheck:libs, api-server typecheck (scoped per the OOM workaround), trading-dashboard typecheck, `pnpm run ci:guards`, all new + existing tests (including the Phase-1 Focus-Lock tests, the synthetic-floor + SL tripwire tests, and the superset guard — all must stay green).

Authenticated QA:
- As a normal user: open the chart symbol selector / scanner and confirm the 7 new markets now appear and each OPENS a chart with live per-symbol feed status (not an alias failure). Screenshot a Jump and a Boom/Crash 300 chart rendering.
- Backtest/watchlist/dashboard: confirm only approved markets appear; hit a backtest/watchlist endpoint with an unapproved symbol and confirm the blocked envelope (no data).
- Confirm an existing unapproved saved/watchlist entry is hidden from the active UI but not deleted.
- Confirm admin-only provider view is not visible as a normal user.

## FINAL REPORT

PART A: the 7 new entries with their VERIFIED broker/Deriv symbols (or any flagged as unconfirmable); registry count 43; Tier-1 placement; per-symbol-feed-path confirmation for each; the new tests + results; chart-open screenshots for a Jump and a Boom/Crash 300.
PART B: each Phase-2 surface locked + the endpoint guards added; the hide-not-delete handling for saved/historical unapproved data; the admin diagnostic-mode gating; tests + results; QA screenshots.
Plus: explicit confirmation that no gate/synthetic-floor/SL-policy/owner-admin-relaxation/trading-path was modified, position-management exemption still holds, and no parallel approved-list was introduced.

## COMPLETION STANDARD — all must be true

- Registry is 43 markets; the 7 new Jump/Boom-Crash entries resolve by canonical + aliases, are Tier 1, use REAL broker/Deriv symbols (verified or flagged), and each opens a chart with correct per-symbol feed truth via the same synthetic path.
- Backtest, dashboard, watchlist, and admin surfaces expose ONLY approved markets; their endpoints block unapproved symbols with the clean envelope and no data fetch.
- Saved/historical unapproved data is hidden/archived, never deleted; position-management on open unapproved symbols still works.
- Admin full-provider/diagnostic view is not visible to normal users.
- No gate/floor/SL/owner-admin/trading path changed; no parallel approved-list; the Phase-1 + synthetic-floor + SL + superset tests all still pass.
- typecheck (libs + both packages) green; ci:guards green; all new + existing tests pass — outputs pasted.
