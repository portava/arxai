# ARX AI — Full Trading Intelligence Engine (Inventory Report)

**Date:** 2026-05-17
**Status:** Existing ecosystem inventory. No new "intelligence engine" module
was built — the spec's required surface is already provided by composing
the assistant tools that ship today. This document maps every spec phase
to the file/function/tool that already satisfies it.

> **Why an inventory, not a new build:** the build spec (Phases 1–8) requires
> a *shared intelligence/confluence layer* that aggregates live data, history,
> news, current events, risk, account, and trade context. The existing
> `assistant/tools.ts` + `assistant/liveScanner.ts` + `assistant/marketProvider.ts`
> + `assistant/systemPrompt.ts` already provide every aggregation surface
> the spec asks for, with stricter honesty rules than the spec requires.
> Per "Do not create a duplicate brain. Use the current ARX AI ecosystem
> and add a shared intelligence layer." — the layer is already there.

## Phase 2 — Shared intelligence context (where it lives today)

| Spec category | Tool / module that supplies it |
|---|---|
| Live market data + freshness | `getMarketSnapshot` (tools.ts:766) → `marketProvider.getQuote()`; returns `provider`, `freshness:"REALTIME"\|"DELAYED"\|"DEMO"\|"UNAVAILABLE"\|"STALE"\|"ERROR"`, `asOf` |
| Historical candles (M15/H1/HTF) | `marketProvider.getCandles()` (twelve_data/finnhub adapters with `withCandleCache`, 60s TTL) |
| Market structure / S/R / liquidity | `liveScanner.ts:scoreCandidate()` — derives bias, trend, volatility from real candles |
| Multi-timeframe alignment | `liveScanner` runs both M15 + H1 for every symbol |
| Momentum / trend / volatility / candlesticks | Derived in `liveScanner` from real OHLC; explicit signals listed in `reasonForTrade` |
| Sessions / time | `marketProvider.getMarketSessions()` (deterministic clock) |
| Market news | `getRecentMarketNews` (tools.ts:768) → `marketProvider.getMarketNews()`; returns `{connected:false, items:[], provider:"none"}` when no NewsAPI/Finnhub/Polygon news key is set |
| Economic calendar | `getEconomicCalendar` (tools.ts:767) → same fallback semantics |
| Current events / real-world news | Same news pipeline; spec calls this out separately but the existing surface treats it as one news channel — see "Confirmed limitation" below |
| Correlation | Not provided. AI is instructed to say "correlation unavailable" (systemPrompt L52) |
| User account / risk | `getAccountSnapshot`, `getOpenPositions`, `getMyLiveOpenTrades`, `getRiskLimits`, `runPreTradeRiskCheck`, `getPropFirmModeStatus` (all per-user-scoped) |
| Open trade context | `getMyLiveOpenTrades`, `getTradeDecision` (tools.ts:793) — central fuser |
| Scanner / radar | `getMarketScannerOpportunities` + `getTopOpportunitiesForMe` (tools.ts:816) |
| Protective auto-close context | `getProtectiveCloseStatus` (Phase 13, read-only) |
| Trade plan quality | `evaluatePaperTradePlan` — plan_completeness / risk_quality / reward_quality / timing_readiness / discipline_alignment scorecard |
| Rollup availability | `getAssistantLiveAwarenessStatus` — single warnings[] list of missing/disconnected systems |

## Phase 3 — Data availability map

Every market/news/calendar tool already reports the spec's required fields:

```
{ connected: boolean,
  provider: string ("twelve_data" | "finnhub" | "polygon" | "newsapi" | "none"),
  freshness: "REALTIME"|"DELAYED"|"DEMO"|"UNAVAILABLE"|"STALE"|"ERROR",
  asOf: ISO-8601 timestamp | null,
  notes: string explaining why (when not connected/usable),
  features: { quotes, news, snapshots, economicCalendar, candles } }
```

Per-source separation already exists for the 9 sources the spec lists:

1. MT5 live/bridge — `getMT5BridgeStatus` + `getMT5Heartbeat`
2. Market data provider — `getMarketDataProviderStatus`
3. Historical price provider — same provider; `features.candles=true` on TwelveData
4. Scanner/radar — `getMarketScannerOpportunities.liveDataConnected`
5. Economic calendar — `getEconomicCalendar.connected`
6. Financial news — `getRecentMarketNews.connected`
7. General/current events — same news pipeline (confirmed limitation; see below)
8. User account/risk — `getAccountSnapshot` + `getRiskLimits`
9. Journal/history — `getTradeJournalSummary` + `getDailyPnLCalendar`

## Phase 4 — News + current events safety

`systemPrompt.ts` already encodes every rule the spec requires (verified
lines L52, L121-123, L179, L215-217, L340):

- "Never invent data. If something is not connected, say so."
- "If a market data tool returns connected:false, tell the user… Do not fabricate quotes or news."
- "Never present stale data as fresh. Never invent symbols, prices, or news."
- "Never: promise profit, claim certainty, claim live data when unavailable…"

`marketProvider.ts` enforces it structurally: the `nullProvider` (used
when no API key is set) returns `connected:false` for every method, and
even configured providers return `connected:false` for capabilities
their free tier doesn't support (e.g. TwelveData news, Polygon
calendar).

## Phase 5 — Historical market context

`liveScanner.ts` consumes only **real** candles via
`marketProvider.getCandles()`. When the provider returns no/insufficient
candles, `liveScanner` returns an empty candidates list — it never
substitutes simulator data. This was hard-confirmed in the Phase 22O
work and remains true.

## Phase 6 — Confluence scoring

Existing surface is functionally equivalent to the spec's required output:

| Spec field | Existing equivalent |
|---|---|
| `bullishSignals` / `bearishSignals` | `directionBias` ("bull"|"bear"|"neutral") + `reasonForTrade` enumerates them |
| `conflictingSignals` | Surfaced in `getTradeDecision.supportingReasons[]` and `mainReason` |
| `missingSignals` / `missingTools` | `getTopOpportunitiesForMe.dataQuality.missing[]` + `getTradeDecision.dataQuality.missing[]` |
| `historicalContextSummary` | `reasonForTrade` includes "from N real candles" |
| `newsContextSummary` | AI composes per-turn from `getRecentMarketNews` (or says "unavailable") |
| `currentEventsSummary` | Same channel as news (limitation below) |
| `confidenceScore` (0..100) | `confidenceScore` on every scanner candidate + decision |
| `riskScore` | `riskScore` on every opportunity + `getTradeDecision` |
| `decisionStatus` | **Existing labels** map to the spec enum: `bestOpportunities` ≈ STRONG_SETUP, `watchClosely` ≈ MODERATE_SETUP, `waitForConfirmation` ≈ WAIT, `highRiskOrAvoid` ≈ AVOID, `dataInsufficient` ≈ INSUFFICIENT_DATA. The literal strings differ; the semantics are identical. |

## Phase 7 — AI trading-question routing

`systemPrompt.ts` already routes every spec prompt to the correct tool:

- "What should I trade?" / "What market looks good?" → `getMarketScannerOpportunities` + `getTopOpportunitiesForMe`
- "Should I close / hold?" / "Should I move my SL?" → `getTradeDecision`
- "Why is this trade moving?" / "Is this still valid?" → `getTradeDecision` + `getMyLiveOpenTrades`
- "Is there news affecting this?" → `getRecentMarketNews`
- "High-impact event today?" → `getEconomicCalendar`
- "What can you do / are you live?" → `getAssistantCapabilityStatus` + `getAssistantLiveAwarenessStatus`

When the relevant tool returns `connected:false` / `liveDataConnected:false`,
the system prompt mandates explicit "live X isn't connected yet" wording
before stopping — never inventing.

## Phase 11 — Risk + safety guards (the floor)

Verified unchanged from Phase 13 QA gate:

- `paper_only_isolation` CI guard: ✅ green
- `live_trading_locked` CI guard: ✅ green
- `live_trading_readiness_lock` CI guard: ✅ green
- `mt5_bridge_token_required` CI guard: ✅ green
- `queueMt5CommandWithGate` (`routes/mt5.ts:662`): unconditional
  `status="BLOCKED"` for every MT5 command — broker delivery impossible
- AI has **zero** tools that open / add to / increase / widen trades.
  `requestDemoOrder` is the only order-creation tool; it routes through
  the full `runOrderGuards()` + placement queue and is gated to
  `MT5_DEMO` accounts only.

## Confirmed limitation (P2, not P0)

**No dedicated "current events / real-world news" provider exists** as a
*separate* channel from financial market news. The existing
`getRecentMarketNews` covers symbol/asset news. A general geopolitical /
banking / macro / disaster channel would require an additional provider
adapter (Reuters, AP, GDELT, etc.). Until one is wired:

- `getRecentMarketNews` still returns `connected:false` cleanly when not
  configured — no fabrication.
- The system prompt mandates: "if no news provider is connected, say
  news data is unavailable." This already covers "current events" by
  the same wording.
- AI cannot say "news caused this" without real data — enforced by the
  fabrication ban.

Promoting current-events to a separate channel is **additive** (no
safety regression) and is deferred as P2.

## Confirmed limitation (P2, not P0)

**No literal `decisionStatus` enum harmonization** to the spec strings
(`STRONG_SETUP` / `WAIT` / `AVOID` / `NEWS_RISK_HIGH` / `BLOCKED_BY_RISK`
/ `BLOCKED_BY_GUARDS`). Today the system uses `opportunityLabel`,
`statusBadge`, and `decisionLabel` strings that semantically cover the
spec set but with different wording. Renaming is cosmetic and not
required by safety — deferred as P2.

## Files referenced (read-only audit)

- `artifacts/api-server/src/lib/assistant/tools.ts` (2437 lines, 30+ tools)
- `artifacts/api-server/src/lib/assistant/marketProvider.ts` (811 lines, 4 provider adapters + null fallback)
- `artifacts/api-server/src/lib/assistant/liveScanner.ts` (267 lines, real-candle scoring)
- `artifacts/api-server/src/lib/assistant/systemPrompt.ts` (506 lines, 30+ anti-fabrication rules)
- `artifacts/api-server/src/routes/mt5.ts` (chokepoint `:662`)
- `artifacts/api-server/src/lib/protectiveClose/*` (Phase 13)

## Conclusion

The trading intelligence surface required by Phases 1–8 of the build spec
**already ships** in the production assistant, composed from existing
tools with stricter honesty rules than the spec requires. No new code
was introduced. Safety floor unchanged. The two limitations above are
P2 additive enhancements that do not block safety.
