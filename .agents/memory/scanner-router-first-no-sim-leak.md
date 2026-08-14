---
name: Scanner router-first analysis routing
description: Scanner must route synthetic/volatility through the unified Market Data Router and never fabricate simulator OHLC for them; per-row dataSource tag is authoritative.
---

# Rule

Every scanner symbol — synthetic/volatility especially — must be analysed from
candles returned by `lib/data/marketDataRouter.ts` first. For non-synthetic
asset classes, the simulator is an acceptable fallback when the router has no
feed. For synthetic/volatility symbols the simulator is **never** acceptable;
emit a `LIVE_FEED`-tagged analysis built from an empty candle array (which
yields `rulesFailed.includes("data_available")` → mapped to `AWAITING_FEED`).

**Why:** any simulator candle for a synthetic-index symbol is fabricated
broker-quality data being shown to a user as if it were real. The user can
trade off it. We pay that cost forever — honest "no feed yet" is mandatory.

**How to apply:**

- Detect synthetic with **both** `classifySymbol(sym) === "synthetic"` **and**
  `resolveDerivSymbol(sym) !== null`. The resolver accepts alias forms
  (`V25 1s`, `Volatility 25 (1s) Index`, `Boom 1000`, `Crash 1000`, …) that
  the asset-class classifier may not yet know about. Either signal is
  sufficient to keep the symbol out of the simulator fallback.
- `ScannerOpportunity.dataSource` is the authoritative per-row tag. The
  envelope-level field on `/market-scanner/opportunities` and `/scan` is
  informational only and should be `"ROUTER"`, not `"SIMULATOR"`.
- `ScannerTradeModal` must structurally disable the demo-command submit
  path when `tradingMode.isLiveShared` and redirect the user to the
  `LiveSharedTradeTicket`, which routes through the unified live pipeline
  and Phase B 16-gate evaluator. Demo-bridge readiness panel is hidden in
  that mode.
- Regression coverage:
  `scripts/src/scannerRealFeedRoutingTest.ts` asserts synthetic rows
  carry `LIVE_FEED` or `AWAITING_FEED` (never `SIMULATOR`), AWAITING_FEED
  rows carry zero prices + the `data_available` rule failure, non-synthetic
  may still fall back to simulator, and `arx_live_commands` stays at zero.
