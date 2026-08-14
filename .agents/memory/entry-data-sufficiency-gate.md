---
name: Entry data-sufficiency gate (Phase-2 composition)
description: How the live-entry data-sufficiency truth gate composes the pure Phase-1 engine, and the freshness-source trap that falsely blocks owner MT5-broker live testing.
---

# Entry data-sufficiency gate

Phase-2 "data-sufficiency truth" surfaces **compose** the pure Phase-1 engine
`evaluateMarketDataSufficiency` (`@workspace/domain/market`; MIN=5 bars;
`canShowTradeSetup === status==="sufficient"`) — they never re-derive it. The
live-entry gate (`evaluateEntryDataSufficiency(symbol)`) is **BLOCK-ONLY +
FAIL-CLOSED**, **NEW-ENTRY only**, and runs at BOTH preflight (`createLiveDraft`→
`preflight`, gated on `PLACE_LIVE_MARKET/PENDING`) and dispatch
(`dispatchLiveCommand`, gated on `isEntryRow`) through the SAME shared helper so
they stay in lockstep (TOCTOU re-check). It sits additively in FRONT of the
existing chain (ARX focus → synthetic floor → SL → 18 gates), all of which still
run and keep final say. The verdict can only **block/downgrade, never grant**.

**Why:** a live-trading safety surface must never become a second authorization
path. A sufficient verdict must simply fall through to the unchanged downstream
chain; an unverifiable feed must refuse (fail-closed), never pass.

**How to apply / TRAP — freshness source:** entry freshness MUST come from
`buildChartIntelligenceState` (built over `routeCandles`, recognizes the
`mt5_broker` slot) — NOT `resolveSymbolFeedVerdictForSymbol`, whose freshness is
Deriv-tick-gated (`hasRecentDerivTickFor`). The Deriv-gated resolver falsely
marks MT5-broker EURUSD as `AWAITING`, which would block the owner's real live
testing path. Derive freshness like rubyChartContext:
`aiUsable && !stale ? LIVE : liveDelayed ? LIVE_DELAYED : AWAITING`.

**Lazy-import perf + fail-closed:** `buildChartIntelligenceState` pulls a heavy
graph — importing it statically into the helper cost ~42s in the unit test.
Resolve it via a dynamic `await import(...)` behind an injectable `deps.buildState
?? import(...)` seam (`??` short-circuits when a stub is injected → cheap test).
Keep that dynamic import **inside** the `try` so a module-load failure also fails
closed, not just a `buildState` throw/timeout. Production is unaffected
(chartIntelligence is already in the server bundle).

**Backtest (PART B) is display-only:** the reliability badge composes the same
engine with freshness forced `LIVE` (historical data is complete by definition);
it never blocks a run and never touches the live path.
