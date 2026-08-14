---
name: Reaching VERIFIED basis in read-chart tests
description: How to deterministically drive POST /me/assistant/read-chart to basis==="VERIFIED" in an in-process test (no real broker).
---

To make `POST /api/me/assistant/read-chart` reach the verified branch
(`chartRead.basis === "VERIFIED"`, `gated !== true`) in an in-process test:

- Push the feed via the `mt5_broker` seam (`updateCandlesFromMT5(symbol, window)`).
  It is FIRST in the forex/synthetic router chain so the push wins outright, and
  `source === "mt5_broker"` ⇒ `ohlcSourceType="true_ohlc"` ⇒
  `providerDeliversRealOhlc=true` (the linchpin for the chart-truth + handshake
  gates). Seed a matching `arxSymbolSpecsTable` row for the user.
- Window must clear `MIN_CANDLE_HISTORY_COUNT` (150 for M5; 50 for D1) — push ~220.
- The NEWEST bar's openTime must align to the CURRENT timeframe bucket
  (`floor(now/intervalMs)*intervalMs`), so `trailingIntervals === 0` ⇒ feed
  quality `clean` ⇒ `aiUsable=true`. A bar even one interval behind ⇒ `delayed`
  ⇒ aiUsable false ⇒ basis NOT verified.
- Keep candles anomaly-free (valid OHLC, equal ranges, tiny drift, no gaps) or
  the truth assessment drops below CLEAN.

**Why:** the read-chart honesty caveat (`dataQuality:"insufficient"`) has two
sources — a gated read (basis≠VERIFIED) AND a verified read where the client
sent body `aiUsable:false`. Proving the override does real work needs a CONTROL
that genuinely reaches VERIFIED, which requires all of the above.

**How to apply:** any test of read-chart / rubyChartContext honesty branches.
A non-existent ticker with no push falls to basis INSUFFICIENT (the gated case).
