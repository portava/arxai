# Market-Data / Symbol-Normalization / Provenance Audit (Spec §10, §2; Encyclopedia fn 3–9)

**Auditor scope:** symbol normalization, provenance-bound market data, candle construction hierarchy, entitlements (spec §10), Deriv P0 focus (§2), encyclopedia functions 3–9, mapped against the existing TypeScript codebase.

**Codebase root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai`
(paths below are relative to this root; `api` = `artifacts/api-server/src`)

**Binding spec:** `/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md`

---

## 0. Spec-vs-codebase baseline conflicts

| Spec says | Codebase reality | Verdict |
|---|---|---|
| "Core: Python 3.12, PostgreSQL" (spec header, §5 package layout `arx/market/…`) | Codebase is TypeScript (pnpm monorepo, Express api-server, Drizzle/Postgres). No Python market layer exists. | Evaluate against TS equivalents. The §5 module layout maps: `market/symbols.py` → `lib/markets/*` + `api/lib/mt5/symbolDirectory.ts`; `market/normalization.py` → `api/lib/data/normalizers/symbolNormalizer.ts` + `api/lib/data/chart/candleNormalization.ts`; Market Gateway → `api/lib/data/marketDataRouter.ts`. |
| `MarketDataProvenance` dataclass on every tick and candle (§10.1, lines 773–801) | The wire candle type is `Candle { time, open, high, low, close, volume? }` — no provenance fields at all (`api/lib/data/types.ts:1-8`). Provenance exists only as (a) a per-*result* provider label and (b) columns on the durable `broker_candles` table. | Partial; see §3 below. |
| Storage key `(broker_account_id, broker_instrument_id, timeframe, opened_at)` (§10.1 line 805) | Durable store `broker_candles` is keyed `(bridge_connection_id, broker_symbol, timeframe, open_time_utc)` (`lib/db/src/schema/brokerCandles.ts:98-103`) — a faithful TS equivalent. But the **read-path projection** `market_candles` is keyed `(symbol, timeframe, source, barTime)` with **no account/bridge dimension** (`lib/db/src/schema/marketCandles.ts:50-55`). | Split verdict — the system of record complies, the serving layer does not. |

---

## 1. Reuse map — what already exists for §10 / §2 / encyclopedia 3–9

### 1.1 Encyclopedia function → existing module

| Fn | Encyclopedia function | Existing code | State |
|---|---|---|---|
| 3 | Runtime Symbol Discovery | **MT5:** EA `ENUMERATE_SYMBOLS` → `arx_symbol_specs` upsert (`api/routes/mt5.ts:1960-2008`), read/resolve via `api/lib/mt5/symbolDirectory.ts:192` (`listSymbolsForUser`) and `:403` (`resolveBrokerSymbol` — exact broker string, ambiguity → candidates, unknown → `SYMBOL_NOT_FOUND`, never a silent default). **Deriv:** `active_symbols` is fetched but only its **count** is cached for diagnostics (`api/lib/data/providers/derivWsClient.ts:426-435`). | MT5: substantially built. Deriv: **gap** — discovery result is discarded (see §4.3). |
| 4 | Canonical Symbol Registry | `lib/markets/src/universe.ts` (ARX Top 250, `providerSymbols`/`brokerAliases` per market), `resolve.ts:87-125` (gated free-text resolution, ambiguity surfaced, "never guessed"), `visibility.ts:21-33` (`intersectProviderSymbols` — provider discovery ∩ approved list only). | Exists and is well designed, **but the data layer does not use it** (see §4.1) and at least five parallel symbol registries exist (see §4.2). |
| 5 | Broker-Native Candle Service | `api/lib/data/brokerCandleStore.ts` (durable bridge-scoped store, closed-bar finalization `:441-484`, conflicting-final-bar rejection `:471-479`, backfill state machine `:275-299`), `mt5History.ts` (deep CopyRates backfill), `candleHistoryService.ts` (paginated one-source-per-page reads `:215-241`), ingest routes `api/routes/mt5.ts:2073` (v1 sync), `:2276` (history), `:2319` (canonical batch ingest). | Substantially built for MT5. Honest-refusal posture (stale-push guard, no fabricated bars) is genuinely good. |
| 6 | Tick-to-Candle Aggregator | `api/lib/data/chart/formingBarComposer.ts` — synthesizes only the **current forming bar** from live EA BID ticks, display-only, never persisted, never analysis input (`:10-28`). | Partial by design: no full tick→candle construction fallback exists (spec §10.2 rule 2). Acceptable while MT5/Deriv both supply candles; flagged as a known gap for venues without candle endpoints. |
| 7 | Market Data Router | `api/lib/data/marketDataRouter.ts` — per-asset-class provider chains (`:167-175`), honest empty on exhaustion (`:423-433`), per-attempt diagnostics, secret redaction (`:593-599`). Legacy `dataManager.ts` delegates to it. | Exists. **Collision:** its silent cross-venue fallback contradicts §10.1/§10.2.6 for decision surfaces (see §3.3). |
| 8 | Tick Ingest & Immutable Store | **Missing.** Ticks live only in volatile memory: `mt5Provider.quoteStore` (`api/lib/data/providers/mt5Provider.ts:68`), Deriv `lastTickBySymbol` (`derivWsClient.ts:56`), forming-bar store (`formingBarComposer.ts:58`). bridgeV2 persists stream *state* and rejected messages, not accepted ticks. | **Gap** — no append-only tick evidence base (AXIOM foundation) exists. |
| 9 | Data Quality Monitor | `api/lib/data/freshness.ts` (single shared trailing-interval thresholds + `buildFeedStatus` precedence `:233-299`), `symbolFeedVerdict.ts`, `mt5FeedStalenessWatchdog(Core).ts`, `providerHealth.ts` (admin inventory + sanitized self-tests), `ingestRejectionCounter.ts`, session-aware completeness via `chart/sessionProfile.ts`. | Substantially built. HEALTHY/DEGRADED/STALE/UNAVAILABLE maps to clean/delayed/stale/unavailable. Verdicts do block entries — but only through source-blind or synthetic-only gates (see §3.4). |

### 1.2 Spec §2 Deriv P0

- Deriv exists as a **market-data-only** WS client: lazy singleton, app-level `DERIV_APP_ID`/`DERIV_API_TOKEN` env credentials, reconnect/backoff, keepalive, eager warm-up subscribes (`derivWsClient.ts`, `derivKeepAlive.ts`). This matches §8's "personal-only deployment" allowance.
- There is **no Deriv broker adapter** (accounts, balances, contracts, execution). Spec Phase 2 (Deriv demo execution) is unstarted — expected at this stage.
- **Collision:** `api/lib/broker/registry.ts:19-23` — selecting `BROKER_PROVIDER=deriv` silently falls back to `MockBrokerProvider` ("No DerivProvider yet; fall back to mock"). The mock honestly reports `connected:false` (`api/lib/broker/mockProvider.ts:12-27`) but serves synthetic account/symbol/position payloads. Spec §21 requires an explicit `NOT_IMPLEMENTED`/`ONBOARDING_REQUIRED` state, not a mock stand-in.
- The four P0 instruments (V25 1s, V50 1s, V75, V75 1s) are all covered by the hard-coded map `DERIV_SYNTHETIC_SYMBOLS` (`api/lib/data/providers/derivProvider.ts:27-50`) — see §4.3 for the discovery-ruling collision.

---

## 2. Where provenance is ALREADY carried

1. **Durable broker store (system of record) — full provenance.** `broker_candles` rows carry `userId`, `bridgeConnectionId`, `accountNumber`, exact case-sensitive `brokerSymbol`, ARX `symbol`, pinned timeframe enum, `openTimeUtc/closeTimeUtc`, producer `source` (`mt5_ea`), `terminalId`, `isClosedBar`, `brokerServerTime`, `receivedAt`, quality status/reason (`lib/db/src/schema/brokerCandles.ts:51-113`). The schema comment even states the spec's own rule: bridges "may legitimately hold the same broker_symbol + timeframe + open_time bar with slightly different prices … **never collapse across accounts**" (`brokerCandles.ts:28-30`). This is the closest existing artifact to spec §10.1's `MarketDataProvenance` + storage key.
2. **Per-source cache keying.** `market_candles` is keyed by `(symbol, timeframe, source, barTime)`; reads are always single-source, so Deriv-scaled bars and broker-native bars are never mixed **within one series** (`api/lib/data/candleCache.ts:12-16`, `:162-201`; schema `marketCandles.ts:19-26`).
3. **Router result labels.** Every `routeCandles`/`routeQuote` result names `primaryProvider` and the full `attempts[]` log (`marketDataRouter.ts:76-98`, `:401-434`). Sub-provider identity is preserved for third-party wins (`assistant_real:twelve_data`, `:365-368`).
4. **Chart truth layer.** `VerifiedCandle`/`NormalizedChartCandle` carries `sourceMode`, `priceBasis`, time-basis handling per provider (`api/lib/data/chart/candleNormalization.ts:175-222`), mock/dev detection degrades quality to invalid (`chartDataService.ts:310-329`), and `ChartFeedStatus.source` is surfaced to the UI with honest naming (`chartDataService.ts:376-385`).
5. **History pagination provenance.** `getCandleHistory` resolves ONE source per page, echoes it, and continues the same source on back-pages (`api/lib/data/candleHistoryService.ts:54-55`, `:215-241`).
6. **Decision snapshots.** `ChartDecisionSnapshot` records `source` at capture time with an explicit replay-honesty rule (`api/lib/data/chart/chartDecisionSnapshot.ts:75`, `:151-167`).
7. **Broker-confirmed-live predicate exists.** `isBrokerConfirmedLive` explicitly refuses `assistant_real:*` as a live-entry feed source (`api/lib/data/brokerConfirmedFeed.ts:59-84`) — the right concept, wrongly wired (see §3.4).
8. **v1 sync-candles provenance is at least logged.** `brokerSymbol`, `priceBasis`, `eaVersion`, `sentAt` are accepted and logged for audit, though not stored (`api/routes/mt5.ts:2134-2146`).

---

## 3. Where provenance is LOST (the core findings)

### 3.1 CRITICAL — the read path collapses candles across broker accounts/brokers

The spec (§10.1): "ARX must not collapse candles from different brokers into one canonical series."

- **In-memory provider is globally keyed.** `mt5Provider`'s candle store key is `` `${symbol}|${timeframe}` `` — no user, no bridge, no account (`api/lib/data/providers/mt5Provider.ts:58-68`). Both ingest generations write into it:
  - v1 full-window sync: `updateCandlesFromMT5(symbol, candles, timeframe)` **replaces the whole series** (`api/routes/mt5.ts:2158`; provider `:77-84`), authenticated per-user (`bridgeAuthPerUserOnly`) but the user identity is dropped at the write.
  - v2 per-event merge: `bridgeV2/ingest.ts` authenticates `userId + bridgeConnectionId` (`api/lib/bridgeV2/ingest.ts:45`, `:74`) and then calls `mergeCandleFromMT5(symbol, candle, timeframe)` (`:267`) and `updateQuoteFromMT5(symbol, quote)` (`:283`) — identity dropped at the merge boundary.
  - Consequence: two users on **different brokers** both pushing `XAUUSD M5` interleave and overwrite each other's bars in one shared series (last-write-wins per bar time, `mt5Provider.ts:105-125`), which the router then serves to everyone as "the" broker feed.
- **Durable mirror is globally keyed too.** Accepted closed bars are mirrored from the bridge-scoped `broker_candles` into `market_candles` under the single source label `mt5_broker` with no bridge dimension: `upsertCandles(symbol, timeframe, MT5_BROKER_MIRROR_SOURCE, mirrorClosed)` (`api/lib/data/brokerCandleStore.ts:557-561`). `upsertCandles` ON CONFLICT **updates OHLC in place** (`candleCache.ts:130-149`), so bridge B's slightly-different close silently overwrites bridge A's finalized bar in the serving cache — the very "conflicting finalized bar" the durable store explicitly rejects (`brokerCandleStore.ts:471-479`) is accepted one layer up.
- **The router reads the collapsed layer, not the provenance-true one.** `readDurableBrokerCandles` reads `market_candles` filtered only by `(symbol, timeframe, source="mt5_broker")` (`marketDataRouter.ts:217-224`); nothing reads `broker_candles` per user on the serve path (its only reader is admin coverage diagnostics, `brokerCandleStore.ts:725+`).

Today this is masked because the deployment has effectively one master bridge. The moment the multi-broker spec is implemented (multiple bridges/brokers per symbol), this is a live provenance violation with real price consequences (different LPs, spreads, session boundaries).

Same-family issue: `mt5History.ts` ingests deep history with **no user/bridge context at all** (`ingestMt5CandleHistory` takes no ctx; `api/lib/data/mt5History.ts:101-191`) into the same shared `mt5_broker` cache slot.

### 3.2 The `Candle` wire type has no provenance

`api/lib/data/types.ts:1-8` — `Candle {time,o,h,l,c,v?}`. Everything downstream of the router consumes bare candles; the result-envelope label is the only carrier and it is routinely dropped:

- `dataManager.getMarketData()` strips the envelope and returns bare candles to `/api/data`, watchlists, multi-timeframe (`api/lib/data/dataManager.ts:17-36`).
- `executionPreviewService` prices order previews from `routeQuote(symbol)` and computes ATR from `routeCandles` while discarding which provider answered (`api/lib/execution/executionPreviewService.ts:62-84`) — a TwelveData mid-quote can silently become the spread/fill estimate for an MT5-executed order. Spec §10.1: cross-venue data is "prohibited from serving as an invisible execution-price substitute."
- Deriv candles are normalized to bare candles with `volume: 0` (`marketDataRouter.ts:316-323`); broker symbol/epoch identity is dropped.
- Minor honesty wrinkle: `getLatestQuote` returns `{symbol, timestamp: now}` when no quote exists (`dataManager.ts:38-41`) — a price-less quote stamped fresh.

### 3.3 The router silently substitutes venues for the same series

Chains: `synthetic: [mt5_broker, deriv]`, everything else `[mt5_broker, assistant_real]` (`marketDataRouter.ts:167-175`). When the broker slot is stale/insufficient the router **automatically** serves the next venue (`:235-238`, `:262-284`, `:407-421`). Spec §10.2 rule 6 requires: "mark a gap and return WAIT; do not synthesize prices or borrow another venue silently."

- The substitution is *labeled* per result (attempts/primaryProvider) — so it is not maximally silent — but the same logical series ("V75 M1") flips venue between calls with no route-change event, and consumers who dropped the label can't tell. Scanner, brain/timing, signal intelligence, paper execution and Ruby all consume `routeCandles`/`getMarketData` output (consumer list: `api/lib/marketScanner.ts`, `brain/timing/*`, `lib/signalIntelligence/*`, `lib/paperExecution/*`, etc.).
- There is no "decision-grade" mode that truncates the chain to the execution venue and returns WAIT.

### 3.4 `decision market data source == execution broker connection` does NOT hold at the enforcement chokepoint

The default execution rule (§10.1) is enforced only partially, and only for synthetics:

- **Synthetics (partial, name-based):** at both live chokepoints the synthetic floor requires owner-unrestricted + "broker is Deriv" + broker truth + per-symbol LIVE tick (`api/lib/live/liveCommandPipeline.ts:565-617`; shared contract `lib/domain/src/safety-contracts/syntheticLiveFloor.ts:63-81`). But "broker is Deriv" is a **name regex** — `brokerIsDeriv = /deriv/i.test(mc[0]?.brokerName ?? "")` (`liveCommandPipeline.ts:587`) — and the "LIVE tick" comes from the **platform-level Deriv WS app connection** (`DERIV_APP_ID` env), not from the executing account's own feed. The binding is broker-brand-equality, not connection-provenance equality.
- **Non-synthetics (not enforced):** the only per-symbol data gate at dispatch is `evaluateEntryDataSufficiency` (`liveCommandPipeline.ts:560-562`), which is **source-blind**: it derives LIVE from `state.aiUsable && !state.stale` (`api/lib/data/chart/chartSufficiency.ts:33-40`), and `aiUsable` can be earned by an `assistant_real:*` feed because `sourceModeFromProvider` maps `assistant_real:*` → `"live"` (`api/lib/data/chart/candleNormalization.ts:188`). So a fresh TwelveData XAUUSD M1 series can satisfy the live entry gate for an order that executes at the MT5 broker.
- **The correct predicate exists but is describe-only.** `isBrokerConfirmedLive` (broker-grade sources = `{"mt5_broker"}` + Deriv-backed; `brokerConfirmedFeed.ts:64`, `:76-84`) feeds `BROKER_FEED_NOT_CONFIRMED` in the unified readiness decision (`api/lib/live/unifiedLiveReadinessDecision.ts:59-60`, `:160-163`) — but at the dispatch preflight the unified resolver is consumed **"purely to OBSERVE … it NEVER changes the return value"** (`liveCommandPipeline.ts:796-849`). The provenance rule is a UI blocker and a log line, not a gate.

### 3.5 Deriv-as-decision-feed vs MT5-as-execution-venue is the designed-in state

`symbolTradability.ts` documents it: synthetics' data provider is `deriv` (WS), execution provider is `mt5` (`api/lib/data/symbolTradability.ts:46-50`, `:79-93`); `providerRoutingMap.ts:95-108` says the same ("Deriv id (e.g. R_75) for data; broker Market-Watch name … for execution"). Deriv's WS synthetic feed and Deriv's MT5 CFD feed are related but not the same instrument surface (spec §2 note: "API contracts are not identical to MT5 CFDs"). Mitigation exists when the EA actually pushes synthetic bars (mt5_broker slot wins, Task #776 comments in `chartDataService.ts:237-248`), but when it does not, decisions ride the WS feed while orders go to MT5.

---

## 4. Collisions with the spec's canonical_instrument_id model (§10)

### 4.1 Routing is by display symbol — the spec's first prohibition

Spec: "Never route solely by display symbol. Use `canonical_instrument_id -> broker_account_id -> broker_instrument_id -> broker_symbol`."

- The router classifies and routes purely on the display-symbol string via regex/sets (`classifySymbol`, `marketDataRouter.ts:139-161`) and the in-memory store "is keyed by the ARX `symbol` verbatim" (`api/routes/mt5.ts:2137-2139`).
- The canonical registry (`lib/markets`, with per-market `providerSymbols` and `brokerAliases`) is **not consulted anywhere in `api/lib/data/`** — the data layer and the Top-250 registry are parallel worlds.
- The account-scoped hop (`broker_account_id -> broker_symbol`) exists **only at the live-execution boundary** (`resolveBrokerSymbol(userId, requested)`, `api/lib/mt5/symbolDirectory.ts:403`), which is good, but market data never makes that hop — so decision data and execution instrument are matched by string coincidence, not by an identity chain.

### 4.2 Five-plus competing symbol registries (duplication risk)

1. `lib/markets/src/universe.ts` — ARX Top 250 (canonical, ranked, aliases, providerSymbols).
2. `api/brain/symbols/symbolRegistry.ts` — a second hard-coded registry with its own `brokerSymbol` field and trading metadata.
3. `api/lib/data/types.ts:28-45` — legacy `SUPPORTED_SYMBOLS` (with `getMarketType` defaulting anything unknown to `"synthetic"`, `:47-50` — a mis-defaulting foot-gun).
4. `api/lib/data/providers/derivProvider.ts:27-50` — `DERIV_SYNTHETIC_SYMBOLS` map.
5. `api/lib/data/normalizers/symbolNormalizer.ts` — per-provider symbol maps (TwelveData/AlphaVantage/MT5 index suffixes).
6. Router-internal classification sets (`FOREX_PAIRS`/`METALS`/`INDICES`, `marketDataRouter.ts:122-137`).

Any Phase-0 canonical-catalog work must consolidate these or explicitly subordinate them, or the collision report in spec §21(2) will repeat itself.

### 4.3 Deriv runtime discovery ruling is violated in mechanism

Spec §10: "discover the runtime symbol IDs through `active_symbols`; do not hard-code guessed IDs" for the initial four. Current state: IDs are hard-coded (`derivProvider.ts:27-50`; they are *correct* today, e.g. `R_75`, `1HZ75V`), and `active_symbols` is fetched but reduced to a count (`derivWsClient.ts:428-431`: `activeSymbolsCount = arr.length`). Nothing validates the hard-coded map against the discovery payload, and an instrument Deriv removes/renames would fail only at fetch time with a generic error rather than being marked unavailable at discovery.

### 4.4 Entitlements (§10.3) — no recorded model

There is no per-connection/per-instrument record of real-time vs delayed vs snapshot vs unavailable. Freshness is *inferred* (trailing intervals, tick age) — good, and honestly surfaced — but no strategy declares a minimum feed quality, and `is_delayed`/`is_snapshot` provenance flags (§10.1 dataclass) have no equivalent. The nearest artifacts are `MarketDataStatus` in `lib/markets/src/types.ts:50-57` (a display taxonomy) and the freshness verdicts.

### 4.5 Timeframe normalization drift (minor)

Three separate timeframe alias maps exist: router (`marketDataRouter.ts:105-118`), broker store (`brokerCandleStore.ts:104-142` — the only one handling the `"1m"`/`"1M"` case-sensitivity trap), provider (`mt5Provider.ts:34-46`), plus `candleHistoryService.ts:97-110`. The broker store's is authoritative and careful; the others are approximate copies. Consolidation is a small, safe slice.

---

## 5. Candle construction hierarchy (§10.2) scorecard

| Rule | State | Evidence |
|---|---|---|
| 1. Prefer broker completed candles | PASS for MT5 (EA CopyRates ingest; broker slot first in every chain) | `marketDataRouter.ts:167-175`, `brokerCandleStore.ts` |
| 2. Construct candles from same broker's ticks when timeframe missing | PARTIAL — only the current forming bar is composed (display-only); no persisted tick→bar fallback | `formingBarComposer.ts:10-28` |
| 3. Mark in-progress candle `complete=false`; strategies can't mistake it | PASS — `isClosedBar` derivation (`brokerCandleStore.ts:314-322`), forming bars never mirrored to the read path (`:541`), forming tip is opt-in display-only and analysis callers get closed bars (`chartDataService.ts:164-167`, `:269`) |
| 4. Persist broker timestamp, receive timestamp, gaps, reconnect boundaries, delayed flags | PARTIAL — `brokerServerTime`/`receivedAt` persisted (`brokerCandles.ts:86-91`); gaps/reconnect boundaries computed at read time (`candleTruthEngine`) but not persisted; no delayed-data flag |
| 5. On restart, backfill same-broker before resuming | PASS in design — durable store + backfill state machine + `nextBackfillHints` paging (`brokerCandleStore.ts:641-656`); EA-driven, so contingent on the EA honoring hints |
| 6. If same-broker backfill unavailable → gap + WAIT, never borrow another venue silently | **FAIL** for decision surfaces — router auto-falls-through to Deriv/assistant_real (see §3.3) |

---

## 6. Gaps summary

1. **No `MarketDataProvenance` equivalent on ticks/candles** (per-datum). Result-level label only; dropped by key consumers.
2. **Read path collapses accounts** (§3.1) — the single most dangerous latent defect for multi-broker.
3. **No provenance gate at dispatch** for non-synthetics; broker-confirmed-feed check is observational (§3.4).
4. **No decision-grade WAIT semantics** in the router (§3.3, §5 rule 6).
5. **No immutable tick store** (encyclopedia #8) — replay/incident reconstruction for ticks impossible.
6. **Deriv discovery discarded** (§4.3); no per-connection Deriv accounts model (P0 build ahead).
7. **No entitlement records** (§4.4).
8. **Canonical registry unwired** to the data layer + 5-way registry duplication (§4.1–4.2).
9. **`BROKER_PROVIDER=deriv` → mock provider** instead of `NOT_IMPLEMENTED` (§1.2).
10. **Broker-name regex** stands in for connection-provenance binding on the synthetic floor (`liveCommandPipeline.ts:587`).
11. Minor: per-bar SELECT loop in `ingestBrokerCandles` (`brokerCandleStore.ts:444-456`) — up to 5000 sequential row lookups per batch; fine for P0 volumes, a scaling hazard later.

---

## 7. Smallest dependency-ordered TS slices

Each slice is independently shippable, behavior-preserving until its flag/gate flips, and reuses existing modules (spec §21: audit-reuse-first).

**S1 — Series-level provenance object (pure type + plumbing; no behavior change).**
Add `SeriesProvenance { providerId, brokerCode: "mt5"|"deriv"|"third_party", bridgeConnectionId: number|null, userId: number|null, brokerSymbol: string|null, environment: "live"|"demo"|"unknown", receivedAt, isDelayed: boolean|null }` to `api/lib/data/types.ts`; populate it in `tryMt5Candles`/`tryDerivCandles`/`tryAssistantCandles` and surface through `MarketCandlesResult`. Deprecate raw `getMarketData` in favor of an envelope-preserving accessor. (Foundation for S2–S4; mirrors spec §10.1 dataclass at series granularity, which is what the TS architecture actually serves.)

**S2 — Bridge-scoped serving path (fixes §3.1).**
(a) Key `mt5Provider` series by `bridgeConnectionId|symbol|timeframe`; thread the authenticated ctx from `api/routes/mt5.ts:2158`, `bridgeV2/ingest.ts:267,283` (both already have it in scope). (b) Add `bridgeConnectionId` to `market_candles` (nullable, default null for non-broker sources) and include it in the unique key + mirror writes (`brokerCandleStore.ts:557-561`) and `readDurableBrokerCandles` (`marketDataRouter.ts:217-224`), resolving the serving bridge per user (reuse `detectCurrentConnectedBridge` / `resolveEffectiveSymbolOwnerId`, `symbolDirectory.ts:220`). (c) Give `ingestMt5CandleHistory` the same `IngestContext` the batch path already takes.

**S3 — Enforceable provenance gate at dispatch (fixes §3.4).**
Behind a default-OFF flag: in `createLiveDraft` preflight and `dispatchLiveCommand` re-check, require `isBrokerConfirmedLive` (already written, `brokerConfirmedFeed.ts:76-84`) for **every** live entry, not just synthetics — i.e. promote `BROKER_FEED_NOT_CONFIRMED` from the observe-only unified readiness (`liveCommandPipeline.ts:796-849`) into a hard refusal. Smallest diff: one call + one refusal branch next to the existing `entryDataSufficiency` call (`liveCommandPipeline.ts:560-562`).

**S4 — Decision-grade WAIT routing (fixes §3.3 / §10.2.6).**
Add `opts { decisionGrade?: boolean }` to `routeCandles`. When true, truncate the chain to broker-grade sources for the symbol's execution venue and return the existing honest-empty shape (reasons already exist: `MT5_BROKER_HISTORY_STALE` etc., `marketDataRouter.ts:268-283`) instead of falling through. Wire scanner/entry-sufficiency/preview callers to decisionGrade; charts/UI keep the full labeled chain.

**S5 — Deriv runtime discovery persistence (fixes §4.3; P0 prerequisite).**
In `runEagerWarmup`, retain the `active_symbols` payload (symbol, display_name, market, pip, exchange_is_open) keyed by Deriv id; validate `DERIV_SYNTHETIC_SYMBOLS` against it; `resolveDerivSymbol` refuses (SYMBOL_UNAVAILABLE_FROM_DERIV_FEED) mappings absent from the last discovery. Store discovery evidence rows (spec §10 "raw discovery evidence").

**S6 — Registry consolidation (fixes §4.1/§4.2).**
Make `lib/markets` the single canonical catalog: router classification consults `findMarketByStandardSymbol`/`assetClass` first (regex fallback second), `brain/symbols/symbolRegistry.ts` and `types.ts:SUPPORTED_SYMBOLS` re-derive from it. Also fix `getMarketType`'s default-to-synthetic (`types.ts:47-50`).

**S7 — Connection-provenance binding for the synthetic floor.**
Replace `/deriv/i.test(brokerName)` (`liveCommandPipeline.ts:587`) with an explicit per-connection capability flag (e.g. `mt5_connection.supportsDerivSynthetics` set from enumerated symbol specs) — provenance by connection id, not brand-name string.

**S8 — Entitlement + tick-store foundations (later, Phase 1 tail).**
Per (connection, instrument) feed-quality record; append-only tick table fed from `bridgeV2/ingest.ts` TICK branch (it already has userId/bridge/brokerTime in hand at `:271-288`).

---

## 8. Red-fail tests (prove the gates can fail)

Existing relevant tests worth reusing as templates: `api/lib/data/__qa__/mt5BrokerFeed.test.ts` (router slot precedence), `scannerNoFeedHonesty.test.ts`, `scannerStaleFeedDowngrade.test.ts`, `scripts/src/brokerCandleIngestTest.ts`, `syntheticLiveFloorUnitTest.ts` (pre-commit).

1. **Provenance-violation guard (the headline red test).** Fixture: fully-armed owner user; stub the assistant provider so `routeCandles("XAUUSD","M1")` wins via `assistant_real:twelve_data` with fresh bars (aiUsable clean); `mt5Provider` empty. Assert `createLiveDraft` preflight refuses with `BROKER_FEED_NOT_CONFIRMED`. **This test fails RED today** (preflight passes; only a log line fires) — it is the acceptance test for S3. Companion mutation test (spec §16): add `"assistant_real:twelve_data"` to `BROKER_GRADE_CANDLE_SOURCES` (`brokerConfirmedFeed.ts:64`) and assert the suite fails.
2. **Cross-account collapse guard.** Call `ingestBrokerCandles` for bridge A (userId 1) and bridge B (userId 2), same `symbol/timeframe/openTime`, different closes, both `isClosed:true`. Assert: (a) `broker_candles` holds both rows (passes today — `brokerCandles.ts:98-103`); (b) the serving read for user A never returns B's OHLC. **(b) fails RED today** — the mirror upsert overwrites (`brokerCandleStore.ts:557-561` + `candleCache.ts:133-148`). Acceptance test for S2.
3. **WAIT-not-borrow.** Seed a stale `mt5_broker` durable series (trailing ≥ 3 intervals), configure Deriv/assistant stubs healthy; call decision-grade `routeCandles`. Assert `ok:false` with reason `MT5_BROKER_HISTORY_STALE` and **no** deriv/assistant attempt entries. Fails RED until S4 exists (today attempts[] shows fallback).
4. **One-source series integrity (regression, passes today — keep as a tripwire).** Upsert deriv + mt5_broker bars for one symbol/tf; `readCachedCandles` per source must return disjoint series; `getCandleHistory` back-page must stay on the initial page's source (`candleHistoryService.ts:215-241`).
5. **Forming-bar honesty (regression, passes today).** A `bars[]` batch with the newest bar not yet closed → mirrored set excludes it (`brokerCandleStore.ts:541`); a `prev closed + incoming forming` regression is rejected (`:481-484`); conflicting finalized close rejected (`:471-479`). Mutation: flip `resolveIsClosed` to `>=` → closed-bar test must fail.
6. **Deriv discovery guard (for S5).** Discovery payload without `R_75` → `getDerivCandles("V75",…)` must refuse with a discovery-miss reason rather than issuing `ticks_history`. Fails RED today (hard-coded map never consults discovery).
7. **Synthetic floor provenance binding (for S7).** Master connection named "Deriv Ltd-ish Broker XYZ" (regex-matching) but without enumerated synthetic symbol specs → floor must refuse. Fails RED today (name regex is sufficient, `liveCommandPipeline.ts:587`).
8. **Sync-candles user isolation (for S2a).** Two authenticated per-user bridges POST `/api/mt5/sync-candles` for the same symbol/timeframe; assert user-scoped reads diverge. Fails RED today (`mt5.ts:2158` writes a global series).

---

## 9. What to retain unchanged (per spec §1: MT5 bridge retained, audited)

- The ingest honesty stack: stale-push transport guards (`mt5.ts:2095-2117`, `brokerCandleStore.ts:392-400`, `mt5History.ts:108-134`), OHLC validity gates (`candleCache.ts:27-40`), closed-bar finalization and conflict refusal, empty-payload-never-clears semantics.
- The shared freshness module and its single-threshold discipline (`freshness.ts`).
- The chart truth engine + verified-candle quality flags; forming tip's display-only quarantine.
- `lib/markets` visibility choke point (`intersectProviderSymbols`) — it is exactly the §9 "instrument discovered, never guessed" posture and should become load-bearing (S6) rather than being rebuilt.
- The honest-refusal router *reason* taxonomy (`MT5_BROKER_HISTORY_STALE`, `DERIV_NOT_CONFIGURED`, …) — reuse verbatim in decision-grade WAIT results.

---

## Appendix A — file inventory audited

- Spec: `/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md` (§1, §2, §4, §5, §9, §10, §16, §17, §19, §21)
- Encyclopedia fn 3–9: `/private/tmp/…/scratchpad/encyclopedia.md:215-437`
- `lib/markets/src/{types,resolve,visibility,universe,copy,index}.ts`
- `lib/db/src/schema/{brokerCandles,marketCandles}.ts`
- `lib/domain/src/safety-contracts/syntheticLiveFloor.ts`
- `api/lib/data/`: `types.ts`, `dataManager.ts`, `marketDataRouter.ts`, `brokerCandleStore.ts`, `candleCache.ts`, `candleHistoryService.ts`, `mt5History.ts`, `freshness.ts`, `providerRoutingMap.ts`, `providerHealth.ts`, `symbolFeedVerdict.ts`, `symbolFeedVerdictForSymbol.ts`, `symbolTradability.ts`, `brokerConfirmedFeed.ts`, `normalizers/symbolNormalizer.ts`
- `api/lib/data/providers/`: `mt5Provider.ts`, `derivProvider.ts`, `derivWsClient.ts`, `mockProvider.ts`, `alphaVantageProvider.ts`, `twelveDataProvider.ts`
- `api/lib/data/chart/`: `chartDataService.ts`, `candleNormalization.ts`, `candleTruthEngine.ts`, `chartSufficiency.ts`, `chartDecisionSnapshot.ts`, `formingBarComposer.ts`
- `api/lib/live/`: `liveCommandPipeline.ts`, `entryDataSufficiency.ts`, `unifiedLiveReadiness.ts`, `unifiedLiveReadinessDecision.ts`
- `api/lib/mt5/symbolDirectory.ts`, `api/lib/bridgeV2/ingest.ts`, `api/lib/broker/{registry,secrets,mockProvider}.ts`, `api/lib/execution/executionPreviewService.ts`, `api/routes/mt5.ts` (ingest endpoints), `api/brain/symbols/symbolRegistry.ts`
- QA: `api/lib/data/__qa__/mt5BrokerFeed.test.ts`, scanner honesty tests (headers)
