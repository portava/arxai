---
name: Ruby feed-not-confirmed honesty surfaces
description: Where the "feed not confirmed" low-confidence caveat is produced across Ruby's read surfaces, and the per-surface data source.
---

The "feed not confirmed at read-time — limited visibility" honesty signal spans
multiple Ruby read surfaces. Each surface derives its own verdict from its own
underlying data source — they are intentionally NOT a single shared verdict,
because the surfaces read different chart-data systems. The caveat string lives
in one shared constant `FEED_NOT_CONFIRMED_CAVEAT` in `tools.ts`:

- **chart-read** (`POST /api/me/assistant/read-chart`) and **draft-read**
  (`POST /api/me/assistant/draft-read`): verdict comes from
  `ChartIntelligenceState` via `feedUsable()` (aiUsable + freshness + truth≥75 +
  mirror + AACI handshake). draft-read exposes it as `dataQuality:"ok"|"insufficient"`
  (mirrors chart-read's field) and always injects the caveat caution when insufficient.
- **chat / voice tools** — `getSymbolMarketContext` AND `getTradeMarketContext`
  (open-trade context): both derive `feedConfirmed = marketContext.dataQuality.quality
  === "good" && freshness === "REALTIME"` → `feedConfirmed` + `feedCaveat` on their
  `context` object. The system prompt's UX6 FEED-NOT-CONFIRMED rule covers BOTH and
  tells Ruby to open with the caveat when `feedConfirmed` is false.
- **`getMarketSnapshot`** (live quote): `feedConfirmed` only when connected,
  non-stale, `freshness === "REALTIME"`, AND positive numeric price; the
  not-connected branch is always unconfirmed. Fields are top-level (no `context`
  wrapper). The system prompt's market/news section carries its own rule.

**Why per-surface:** chart surfaces own a verified ChartIntelligenceState;
chat's symbol tool uses the lighter marketContext builder. Reconciling them into
one verdict would be over-engineering and add latency. Honest-by-source is fine.

**Testing gotcha:** the chat/voice marketContext surfaces (`getSymbolMarketContext`,
`getTradeMarketContext`) read the ASSISTANT marketProvider chain via
`buildMarketContext` — NOT the MT5 `updateCandlesFromMT5` candle seam (that seam
only drives the chart/draft `ChartIntelligenceState`). So to drive the
"feed confirmed" (good+REALTIME) branch deterministically without API keys you
must inject a provider through `_setMarketProviderForTests` and reset with
`_resetMarketProviderForTests` after. The "not confirmed" branch just needs a
no-feed ticker (default null/real provider yields insufficient/UNAVAILABLE).
`getTradeMarketContext` also requires a real user-owned trade row
(`resolveUserTrade` → `live_positions`/`shared_trade_attribution`).

**Invariant:** all three are advisory/decision-support ONLY. The caveat NEVER
gates execution (Ruby is read-only) and never fabricates data — on an
unconfirmed feed the read degrades to honest low-confidence, it does not invent.

**Rule — a gated trustLine must be feed-derived, never the reused verified
string.** The success-path trustLine is built from raw Phase-3 gate flags and can
read "Verified <TF> candles · Live feed · …" even when a read is
GATED/INSUFFICIENT (e.g. EURUSD **W1**: gate flags pass but the current weekly
bucket hasn't streamed → `aiUsable:false` → basis INSUFFICIENT). So a gated
branch must NOT reuse `rubyCtx.trustLine`; it must emit a line derived from the
ACTUAL feed state. **Done (both surfaces):** chart-read
(`POST /api/me/assistant/read-chart`) AND draft-read
(`POST /api/me/assistant/draft-read`) emit the gated line via the pure helper
`buildGatedTrustLine(timeframe,{available,stale,aiUsable,basis})` in
`rubyChartContext.ts` — it never emits "Verified"/"Live feed" (precedence:
unavailable → stale → delayed → PARTIAL "mirror syncing" → "awaiting sync").
draft-read resolves a real basis via `buildRubyChartContext` (reusing its
`state`, with `buildChartIntelligenceState` as fallback) and overrides
`draftRead.trustLine` whenever `basis !== "VERIFIED"`. Both branches are locked
by `scripts/src/gatedChartTrustLineHonestyTest.ts` (read-chart = check #9,
draft-read = check #10; static-wiring scans strip `//` comments to avoid
false-pass).
**Why it matters:** the trustLine is the one field that can label a non-live feed
as "Live feed", violating never-label-stale-as-live; headline/basis/dataQuality
are already honest.
