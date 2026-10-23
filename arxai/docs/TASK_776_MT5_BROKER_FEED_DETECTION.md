# Task #776 — MT5 broker live-feed detection fix

## Problem

When the MT5 bridge delivered fresh broker candles/ticks for a **synthetic**
symbol (Deriv-class instruments such as V75, BOOM1000, CRASH1000, etc.), the
symbol was mislabeled **"historical only" / "feed limited" / "analysis only"**
instead of reading broker-confirmed live. The mislabel surfaced on the chart
feed badge, the scanner, the Ruby chart-read, and the owner live-entry feed
gate.

This was **not** a gate-relaxation problem and **not** specific to BOOM1000 —
it was a single wrong layer applied to *all* MT5-served synthetic symbols.

## Root cause

Liveness for synthetic-class symbols was judged on the **Deriv WebSocket tick
stream alone**, regardless of which provider actually won the data race:

- `chartDataService.ts` treated *every* `assetClass === "synthetic"` symbol as
  Deriv-backed for the purpose of liveness. It demanded a fresh Deriv WS tick
  (`hasLiveTick`) before it would report `isLive` / `aiUsable`. When the winning
  provider was `mt5_broker` (broker candles ingested over the bridge), there was
  no Deriv WS tick, so a genuinely fresh broker feed was demoted to
  `delayed` / `aiUsable=false` ("analysis only").
- `symbolFeedVerdictForSymbol.ts` had a Deriv-only early short-circuit with the
  same assumption, so the owner synthetic-floor preflight
  (`liveCommandPipeline.ts`) inherited the same false demotion.

Non-synthetic symbols (forex, metals, indices) were never affected because they
never required a Deriv tick. The scanner path (`marketScanner.ts`) was already
correct — it keyed liveness off whether the *winning provider* was Deriv
(`derivBacked`), not off the asset class.

## Fix

The liveness basis is now keyed off the **winning provider**, not the asset
class — matching the already-correct scanner logic. Liveness now means:

> A Deriv-backed feed must have a fresh Deriv WS tick. **Any other provider
> (including `mt5_broker`) is judged on candle freshness alone.**

### FIX #1 — `artifacts/api-server/src/lib/data/chart/chartDataService.ts`

- Added `derivBacked = synthetic && (source === "deriv" || source?.startsWith("deriv"))`
  where `source = result.primaryProvider` (the provider that actually served the
  candles).
- `syntheticAwaitingTick` is now `derivBacked && !hasLiveTick` (only a real
  Deriv-backed feed can be "awaiting a tick").
- `isLive` now requires `(!derivBacked || hasLiveTick)` — a broker-served
  synthetic with fresh candles reads live without a Deriv tick; a Deriv-served
  synthetic still requires its tick.

### FIX #2 — `artifacts/api-server/src/lib/data/symbolFeedVerdictForSymbol.ts`

- Removed the Deriv-only early short-circuit. The resolver now routes candles
  through the same logic, derives `derivBacked` from the winning provider, and
  only requires a recent Deriv tick (`hasRecentDerivTickFor`) when the feed is
  actually Deriv-backed.

## Honesty constraints preserved (NOT a gate relaxation)

- A **stale** broker feed still reads `stale` with the exact reason and stays
  entry-blocked (no `aiUsable`, no `isLive`).
- A genuinely **Deriv-awaiting** synthetic (Deriv is the winning provider but no
  fresh WS tick) is still demoted to `delayed` / not-usable — `buildFeedStatus`
  behavior is unchanged for that case.
- No execution gate was touched. The 18-gate Phase B dispatch chokepoint, the
  entry data-sufficiency gate, and the owner synthetic-floor relaxations all
  remain exactly as before — this fix only corrects the *liveness/feed-status
  reporting layer* that those surfaces read.

## Diagnostic readout (deliverable)

Both surfaces already render rich, feed-status-driven diagnostics that now
auto-reflect the corrected truth (no second source of truth was introduced):

- **Chart** — `FeedConfidenceBadge.tsx` popover shows Source, State
  (Live/Stale/Delayed), Latency, Last candle, Last tick, Missing candles,
  Anomalies, AI-usable, and Readiness. Because the fix sets `lastTickTime=null`
  for a broker-served synthetic (there is no separate tick stream), the popover
  now renders **"broker candles"** in the *Last tick* row for that case, so the
  empty tick is never misread as a degraded/limited feed on a genuinely live
  broker synthetic.
- **Scanner** — `ScannerDataHealthPanel.tsx` shows plain-English data-health
  lines plus an admin diagnostic (source · tier · count · status ·
  brokerFeedActive). It is driven by the scanner truth resolver, which already
  reads broker-live correctly.

## Tests

`artifacts/api-server/src/lib/data/chart/__qa__/brokerSyntheticFeed.test.ts`
(3 tests, all passing), wired into the root `ci` script and the
`test:broker-synthetic-feed` package script:

1. Synthetic served by **fresh** `mt5_broker` candles (no Deriv tick) reads
   `clean` / `aiUsable` / `live`.
2. Synthetic served by **stale** `mt5_broker` candles still reads
   `stale` / not-usable / not-live.
3. `buildFeedStatus` still demotes a genuinely **Deriv-awaiting** synthetic to
   `delayed` / not-usable (honesty regression guard).

## Verification

- `pnpm run typecheck:libs` — clean
- `pnpm --filter @workspace/api-server run typecheck` — clean
- `pnpm --filter @workspace/trading-dashboard run typecheck` — clean
- `pnpm --filter @workspace/api-server run test:broker-synthetic-feed` — 3/3 pass
- `pnpm run ci:guards` — 49/50 (the single remaining `test-scripts-wired`
  violation is the pre-existing, unrelated `test:approval-path` gap in
  trading-dashboard; the new test is now correctly wired in)
