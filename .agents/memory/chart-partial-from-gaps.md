---
name: Chart partial quality from interior gaps
description: A fresh, live, broker-sourced chart series can still be quality=partial / aiUsable=false purely from missing interior bars.
---
Rule: On `GET /api/chart/candles`, `source=mt5_broker` + `feedStatus.isLive=true` + `stale=false` does NOT imply usable. Quality can still be `partial` with `aiUsable=false` when the returned window has interior sequence gaps — `warning: "Incomplete sequence: N missing, ..."` and `feedStatus.missingCandleCount=N`. This is independent of (a) broker-slot acceptance (NOT a router rejection — the slot was accepted) and (b) trailing-interval staleness (the newest bar is fresh).

**Why:** Observed for EURUSD while the broker feed was fully live: M1/M5/M15 = clean/aiUsable=true; H1/H4/D1 = partial/aiUsable=false with ~96/110/33 missing bars. The durable `broker_candles` backfill leaves holes on higher timeframes (weekend sessions / incomplete backfill pages); the chart truth engine counts expected-vs-actual bars across the window and downgrades on gaps even when the feed is live and fresh.

**How to apply:** When a chart/AI surface reports "not usable" on higher TFs while the feed shows live, look at `missingCandleCount` / the Incomplete-sequence warning and `broker_candles` backfill completeness — NOT the router source or freshness. `aiUsable===(quality==='clean')`.
