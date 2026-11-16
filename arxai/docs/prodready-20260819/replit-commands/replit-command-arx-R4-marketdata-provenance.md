# Replit command — R4: market-data provenance (decision-source == execution-broker)

**Prerequisite:** R1 merged. **Risk class:** data-truth architecture feeding live decisions — branch + owner merge.

Companion report: `audit-reports/audit-marketdata.md` (8 dependency-ordered slices, 8 red-fail tests incl. a provenance-violation guard that fails red against today's code).

Instruction for Claude Code in the Replit shell:

---

Implement the provenance series from `audit-marketdata.md` on branch `feat/marketdata-provenance`:

1. **Provenance type** — extend the candle/quote wire types with a provenance envelope (source, connection/bridge identity, environment, received/source timestamps, delayed flag) per spec §10.1; `dataManager.getMarketData` stops stripping the router's source label.
2. **Bridge-scoped serving** (the critical fix) — the in-memory `mt5Provider` store and the `market_candles` "mt5_broker" mirror are keyed `symbol|timeframe` only, collapsing candles across broker accounts. Key them by bridge/connection identity like `broker_candles` already does. Two bridges pushing the same symbol must never overwrite each other in the serving layer.
3. **Enforceable dispatch gate** — `isBrokerConfirmedLive` exists but is consumed observe-only in the dispatch preflight. Make it enforcing: live ENTRY dispatch requires fresh candles/quotes from the SAME bridge that will execute; close/reduce commands stay exempt. Ship behind a default-ON env flag with an explicit documented override for owner testing.
4. **Decision-grade WAIT** — add a decision-grade read mode to the router: when the execution broker's feed is stale/unavailable, return WAIT/refusal instead of silently falling through mt5 → deriv → assistant_real for the same series. Display surfaces may keep the fallback chain; decision/execution surfaces may not.
5. **Deriv runtime discovery** — retain the `active_symbols` payload (currently reduced to a count), validate the five hard-coded symbol maps against it at connect time, log + quarantine mismatches (the BOOM500/CRASH500 vs BOOM500N/CRASH500N drift is live today), and pin the four-symbol initial universe in config.
6. **Symbol registry unification** — route resolution through `lib/markets` canonical registry instead of display-string `classifySymbol`; fold the five parallel symbol maps into venue alias tables.
7. **Entitlement records** — per-connection/instrument data-quality record (realtime/delayed/snapshot/unavailable) surfaced in the feed-status endpoints.
8. **CI guard** — `check-provenance-no-collapse`: fails when any serving-layer store is keyed by bare symbol|timeframe, and the provenance-violation red-fail test from the report.

Binding: no fabricated data anywhere; display honesty caps stay downgrade-only; `syntheticLiveFloor` binding moves from broker-name regex to connection provenance (slice 3 dependency).

---

**Hold point:** after slice 3 (the enforcement flip), verify live-testing still dispatches with the master bridge feed healthy, then continue.
