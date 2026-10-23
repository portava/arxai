# ARX Native Chart — Level 0: Existing-System Audit

**Status:** DISCOVERY / REPORT ONLY — this document changes no product code. It is
the gate for Level 1 (candle data truth contract). Every path below was verified
against the live codebase; file paths and endpoints are concrete, not illustrative.

**Bottom line:** ARX already has two distinct charting stacks — a third-party
**TradingView embed** (visualisation only) and a **native lightweight-charts v5**
surface (`ScannerChartPanel` + `PositionMiniChart`) that already renders real ARX
candle data and already routes trade actions through the full 16-gate live
pipeline. A "native chart" build does **not** start from zero: it should grow out
of the existing `ScannerChartPanel` pattern and the existing `/api/data/candles`
contract, and must leave the TradingView embed and the live-execution path
untouched.

---

## 1. Current chart files (and where each mounts)

| Component | File | Tech | Mounts on |
| --- | --- | --- | --- |
| **TradingViewLiveChart** | `artifacts/trading-dashboard/src/components/charts/TradingViewLiveChart.tsx` | Third-party TradingView `tv.js` widget (iframe-style embed) | `pages/live-chart.tsx`, `pages/live-ai-assist.tsx`, `pages/live-ai-auto-test.tsx`, `pages/live-manual.tsx` |
| **ChartTradeEntry** | `artifacts/trading-dashboard/src/components/charts/ChartTradeEntry.tsx` | Trade-ticket side panel next to the TV embed | `pages/live-chart.tsx` |
| **ScannerChartPanel** | `artifacts/trading-dashboard/src/components/scanner/ScannerChartPanel.tsx` | **Native** lightweight-charts v5 (candlesticks + draggable Entry/SL/TP draft lines + position/pending overlays + gated chart trade actions) | `pages/market-scanner.tsx` (priority #1 surface) |
| **PositionMiniChart** | `artifacts/trading-dashboard/src/components/positions/PositionMiniChart.tsx` | **Native** lightweight-charts v5 (view-only mini OHLC + entry/SL/TP/current price lines + entry marker) | `components/positions/PositionSideCard.tsx`, also imported by `ScannerChartPanel.tsx` |
| **RubyChartRead** | `artifacts/trading-dashboard/src/components/scanner/RubyChartRead.tsx` | Read-only "Ruby reads this chart" panel (no canvas; calls the assistant) | inside `ScannerChartPanel.tsx` |

**Symbol / timeframe controls**

- Native surfaces and the TV embed share a single symbol bus:
  `artifacts/trading-dashboard/src/lib/use-chart-symbol.ts` (`useChartSymbol`,
  `setChartSymbol`, `bareSymbol`). Key `highroll.chartSymbol`, default `FX:EURUSD`,
  propagated via a `window` CustomEvent so every panel repaints in one tick.
- Canonical symbol catalog + resolver:
  `artifacts/trading-dashboard/src/lib/symbolRegistry.ts` (`searchSymbols`,
  `resolveSymbol`, `SYMBOL_REGISTRY`). This is the source of truth for which
  markets a user can search/click/focus/trade (forex, metals, indices, crypto,
  stocks, Deriv synthetics V10–V100 + BOOM/CRASH/STEP/JUMP).
- `ScannerChartPanel` timeframes: `1m,5m,15m,1h,4h,1d` (persisted in
  `localStorage` key `scanner.chart.timeframe`, default `15m`).
- TV embed intervals: `1,5,15,60,240,D`; its own fixed 9-symbol `SYMBOLS` list;
  `allow_symbol_change:false` so in-widget search can't desync the page.

**Existing overlays / theme / known constraints**

- `ScannerChartPanel`: candlesticks, draggable draft Entry/SL/TP lines, per-user
  position + pending-order price lines, incremental `IPriceLine` redraw without
  recreating the chart (`chartEpoch`), fixed height 360px.
- `PositionMiniChart`: four price lines + one entry marker via
  `createSeriesMarkers` (v5 plugin), scroll/scale disabled, `ResizeObserver` for
  width.
- Theme: native charts hard-code dark zinc/emerald/rose palette; the TV embed
  reads `document.documentElement.classList.contains("dark")` and exposes a theme
  toggle.
- **Mobile:** native charts set width from `clientWidth` with a `ResizeObserver`
  but use a **fixed pixel height** (360 / 220). There is no touch-drag handling
  for the draft lines (pointer events only), and no responsive height — this is
  the main known mobile gap to address in a later level.
- lightweight-charts is pinned at `^5.2.0` (see
  `artifacts/trading-dashboard/package.json`). v5 removed the v4
  `addCandlestickSeries()` / series-level marker methods — both native components
  already use the v5 `addSeries(CandlestickSeries, …)` + `createSeriesMarkers`
  API. **Do not** reintroduce v4 calls.

---

## 2. Current candle data source

Single public endpoint, no auth required for candles:

```
GET /api/data/candles?symbol=<sym>&timeframe=<tf>&limit=<n>
```

Request path (verified):

1. `artifacts/api-server/src/routes/data.ts` — validates with
   `GetMarketCandlesQueryParams` (Zod), defaults `timeframe="1m"`, `limit=100`.
2. → `getMarketData(symbol, timeframe, limit)` in
   `artifacts/api-server/src/lib/data/dataManager.ts` (legacy delegate).
3. → `routeCandles(symbol, timeframe, limit)` in
   `lib/data/marketDataRouter.ts` (the unified router). Classifies the symbol into
   an `AssetClass`, looks up the provider chain, iterates providers until one
   returns non-empty data.

Sibling endpoints in the same router: `GET /api/data/quote` (→ `getLatestQuote`)
and `GET /api/data/providers/status` (→ `getProviderStatus`).

**Candle response shape** (normalised by the router): array of
`{ time, open, high, low, close, volume }`. `time` is an **ISO-8601 string** in
the API JSON (providers' Unix-seconds epochs are converted via
`new Date(epoch*1000).toISOString()`); OHLC + volume are numbers; synthetic volume
is often 0.

> **Frontend caveat for Level 1:** `ScannerChartPanel` already tolerates both a
> bare array and a `{candles:[…]}` envelope, and coerces `time` from either a
> number or a parseable date string, then converts to **Unix seconds** for
> lightweight-charts (`Math.floor(c.time/1000)`). Any new "candle truth contract"
> must keep this shape stable or update both native consumers in lockstep.

**Honesty rule (already enforced):** when no provider returns data the endpoint
returns an empty list — the UI shows an honest empty state. Candles are **never**
fabricated and **never** substituted with simulator/paper/master-account data.

---

## 3. Current TradingView dependency

- `TradingViewLiveChart.tsx` loads the official script
  `https://s3.tradingview.com/tv.js` (id `tradingview-tv-js`) once, then mounts
  `new window.TradingView.widget({…})` into a div. On script failure it surfaces a
  retry button (no silent failure).
- It is a **visualisation/reference widget only** — it does **not** use ARX
  candle data, does **not** imply an MT5 connection, and has **no** order path
  (orders on `live-chart.tsx` go through the separate `ChartTradeEntry` ticket).
- Config highlights: `autosize`, `allow_symbol_change:false` (forces symbol
  changes through the React selector + shared bus), default studies
  `MASimple` + `RSI`, theme follows the app.
- **External dependency / risk:** it requires `s3.tradingview.com` reachability
  and TradingView's own data coverage; it is third-party and not under ARX
  control.

**Decision recorded:** TradingView **stays** as a fallback / reference chart. The
ARX Native Chart is additive — it does not replace or remove the TV embed or any
of the four pages that mount it.

---

## 4. Current live-execution path (UNTOUCHABLE)

Every trade action from a chart already funnels through the Global Instant Trade
Router and the 16-gate Phase B pipeline. A native chart MUST reuse this verbatim
and MUST NOT introduce any new or frontend-only trade path.

- **Frontend router:** `executeInstantTrade` in
  `artifacts/trading-dashboard/src/lib/instantTradeRouter.ts`
  (`source:"chart"`). `ScannerChartPanel` uses it for place / close / partial
  close / break-even / reverse; reverse is explicitly a two independently-gated
  legs sequence (no atomic REVERSE command). Pending-order cancel uses the
  per-user `DELETE /api/me/pending-order-draft/:id` (the router has no
  cancel-pending action).
- **Backend route:** `artifacts/api-server/src/routes/instantTrade.ts` →
  handler `executeInstant` in `artifacts/api-server/src/lib/live/instantTrade.ts`.
  Accepted actions: `BUY, SELL, CLOSE, CLOSE_ALL, MODIFY_SL_TP`. **Live-only:**
  it rejects `accountMode:"demo"` with `UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE`
  and rejects legacy `paper` at the route level. Demo execution uses the separate
  `/api/mt5/demo-*` path.
- **16-gate evaluator:** `evaluateLivePhaseBDispatchGate` in
  `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` (gates 1–16:
  master switch, armed, approved, global-live, kill switch, live account type,
  heartbeat ≤15s, EA ≥1.27, EnableLiveExecution, ReadOnlyMode, terminal
  connected, algo-trading allowed, symbol allowlist, lot ≤ max, daily loss cap,
  stop-loss/TP/disclosure). ANY single FAIL → `LIVE_BLOCKED:<reason>`; the legacy
  sentinel `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is appended while the master
  switch is off.
- **MT5 bridge transport:** EA polls `/api/mt5/live-commands-poll`
  (`arx_live_commands`) and reports via `/api/mt5/live-command-result`; demo uses
  `/api/mt5/commands` + `/api/mt5/command-result`. All EA endpoints are guarded by
  `bridgeAuthPerUserOnly`; the server-wide `MT5_BRIDGE_TOKEN` is rejected. Live
  dispatch pipeline: `lib/live/liveCommandPipeline.ts`.
- **Live positions / status:** table `arx_live_positions`; user reads via
  `GET /api/me/positions/all` (live+demo, per-user scoped) and
  `GET /api/me/live/command-status/:id` (honest terminal outcome — the UI only
  prints "executed" on `LIVE_FILLED` with a real broker ticket, or `LIVE_CLOSED`).
- **Permission / mode gates:** `loadAndEvaluateUserMasterLiveAccessGate`
  (`artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.ts`); unified
  resolver `GET /api/me/account-mode`
  (`artifacts/api-server/src/routes/meUnifiedMode.ts`); precedence in
  `artifacts/api-server/src/lib/computeAccountModePrecedence.ts` (armed → forced
  `LIVE_SHARED`, blocks surfaced, never silent demo fallback).

**Rule for all chart levels:** the native chart may *render* state and *invoke*
`executeInstantTrade`; it may **never** dispatch to the bridge, mutate
`arx_live_commands`/`arx_live_positions`, or evaluate/relax any gate itself.
PAPER mode renders no trade buttons.

---

## 5. Current scanner / Ruby / agent integration points (for read-only overlay)

All intelligence outputs a future chart could overlay are already produced
server-side and exposed via API. None of them is a trade path.

- **Market Scanner** — `artifacts/api-server/src/lib/marketScanner.ts`, routes
  `artifacts/api-server/src/routes/scanner.ts`:
  - `GET /api/market-scanner/opportunities` — `ScannerOpportunity[]`:
    `bias`, `recommendedAction`, `setupType`, `confidenceScore`, `riskScore`,
    `entrySniperScore`, `opportunity.score`, `entry/stopLoss/takeProfit`,
    `historicalContext`, `newsContext`, `finalRead`, plus embedded
    `agentAdvisory` + `agentGovernance`.
  - `GET /api/market-scanner/status`, `GET /api/market-scanner/universes`,
    `POST /api/market-scanner/scan` (admin).
- **Ruby (read-only assistant)** — logic
  `artifacts/api-server/src/lib/assistant/chartStructure.ts` (deterministic, no
  LLM), routes `artifacts/api-server/src/routes/meAssistant.ts`:
  - `POST /api/me/assistant/read-chart` → `chartRead` (`bias`, `confidence`,
    `why`, `supportZone`, `resistanceZone`, `buyCondition`, `sellCondition`,
    `invalidation`, `cautions`, `dataQuality`). Already wired into the native
    chart via `RubyChartRead.tsx`.
  - `POST /api/me/assistant/explain-signal` → `setupReason`;
    `GET /api/me/assistant/briefing` → desk briefing.
  - Ruby is **read-only** — it cannot place/modify/close trades or read another
    user's data. Each response carries a per-user safety envelope built by
    `buildPerUserEnvelope` (from `lib/adminTrading/safetyEnvelope.ts`'s
    `getEnvelope`) with `readOnlyMode:true` added; the envelope's
    `liveLocked`/`allowOrderExecution` fail-closed defaults remain enforced.
- **Agent governance / ecosystem** —
  `artifacts/api-server/src/lib/agentEcosystem/advisoryInfluence.ts` +
  `governance.ts`. Advisory (`adjustedScore`, `netDelta`) and governance
  (`governanceScore ≤ advisory`, `outcome`) are **embedded** in scanner / scalp /
  explain-signal responses — there is **no** separate raw advisory endpoint. A
  chart overlay must read them from those existing payloads.
- **Scalp engine** — `artifacts/api-server/src/lib/scalp/scalpEngine.ts`
  (+ `scalpService.ts`), routes `artifacts/api-server/src/routes/meScalp.ts`:
  `POST /api/me/scalp/focus`, `POST /api/me/scalp/rank`,
  `GET /api/me/scalp/journal` → `ScalpResult` (entryZone, TP quick/main/stretch,
  stopLoss, suggestedLot, qualityScore, flame stage/freshness).

---

## 6. WebSocket vs polling status

- **Backend providers:**
  - **Deriv** (synthetics) — **WebSocket** (`derivWsClient.ts`,
    `wss://ws.derivws.com/websockets/v3`; `ticks_history` style `candles` for
    history, `subscribe:1` for live). This is the only live-streaming provider.
  - **TwelveData**, **Polygon** — **REST polling**
    (`artifacts/api-server/src/lib/assistant/marketProvider.ts`).
  - **AlphaVantage** — real adapter (`alphaVantageProvider` in
    `marketProvider.ts`) for **quote / news / overview** only; **candle support
    is not implemented** in this adapter (returns empty with an honest note), so
    it never serves chart candles.
  - `mt5_broker` slot — reserved, **not active** (see §7).
- **Frontend (HTTP polling only — no WebSocket on any chart surface):**
  - `ScannerChartPanel` fetches candles on `symbol/timeframe/reload` change; polls
    per-user positions + pending orders every **10s** with a `visibilitychange`
    pause.
  - `market-scanner.tsx` polls status + opportunities every **5s** with a
    hidden-tab pause.
  - The TV embed manages its own live feed internally.
  - `trackLiveOutcome` in `ScannerChartPanel` short-polls
    `/api/me/live/command-status/:id` (~0.7→2.5s backoff, 15s deadline) after a
    live dispatch.

> The browser never opens the Deriv socket directly; the WS is a server-side
> implementation detail behind `/api/data/candles`. A future "live updating"
> native chart should decide explicitly between (a) tighter HTTP polling of
> `/api/data/candles` and (b) a new server push channel — that is a Level-1+
> design decision, not something that exists today.

---

## 7. Candle / tick history status

- **No persistence.** There are no `candle`, `ohlc`, or `tick` tables in
  `lib/db/src/schema/`. `marketDataRouter.ts` keeps only a brief **in-memory**
  cache (TTL ~15–60s, "no DB writes"); provider singletons cache briefly too.
- Every candle request is fetched **live** through the provider chain. History
  depth is whatever the upstream provider returns for the requested `limit`
  (default 100, ScannerChartPanel requests 200). On Polygon's free tier only
  **D1 candles** and `/prev` quotes are usable for forex; intraday returns
  insufficient data upstream (honest empty, never fabricated).
- **Implication:** any native-chart feature needing replay, backfill, or
  persistent history (e.g. server-side indicators over long windows) has **no
  storage layer to build on today** — that is a gap a later level must design
  deliberately, not assume.

---

## 8. Risks before building

1. **Live-path entanglement.** `ScannerChartPanel` already places real gated
   orders. Any refactor risks touching the trade path. *Mitigation:* keep all
   trade calls going through `executeInstantTrade` unchanged; never inline a gate.
2. **Candle contract drift.** Two native consumers parse `/api/data/candles`
   independently (array-or-envelope, ms-or-ISO time). Changing the shape without
   updating both breaks a chart silently. *Mitigation:* the Level-1 truth contract
   must be the single typed source for both.
3. **lightweight-charts v5 API.** v4 methods were removed and throw at runtime
   only once real data loads. *Mitigation:* never cast charting calls; mirror the
   proven `addSeries(CandlestickSeries,…)` + `createSeriesMarkers` pattern.
4. **No history/persistence.** Features assuming stored candles/ticks have no
   backing store (see §7).
5. **Mobile gaps.** Fixed-height canvases and pointer-only drag (see §1).
6. **Provider variability.** Free-tier rate limits, empty intraday, synthetic-only
   via Deriv WS. *Mitigation:* honest empty states — never fabricate.
7. **Symbol normalization split.** Frontend `symbolRegistry.ts` vs backend
   `symbolNormalizer.ts` + Deriv `resolveDerivSymbol` (V75→R_75, V75_1S→1HZ75V).
   A native chart must pass canonical symbols and let the backend resolve broker
   symbols.
8. **Per-user isolation.** Overlays must use per-user endpoints
   (`/api/me/*`) only — never master/global data.

---

## 9. Safest insertion point for the new chart

**Grow the native chart from `ScannerChartPanel.tsx`, consuming the existing
`GET /api/data/candles` contract and the shared `useChartSymbol` bus, on the
Scanner page (priority #1 surface).** Rationale:

- It already proves the full loop: real candles → lightweight-charts v5 render →
  per-user overlays → gated trade actions via `executeInstantTrade` → honest live
  outcome polling → read-only Ruby read.
- It already reads the canonical symbol bus and registry, so it stays in sync with
  Focus / Symbols / scalp picks for free.
- Building here means **adding to a proven, already-safe surface** rather than
  inventing a parallel data/trade path.
- The TradingView embed and its four pages stay exactly as-is (fallback/reference).
- Level 1 should formalise the candle **truth contract** (typed, single source)
  that this surface and `PositionMiniChart` both consume — without changing the
  endpoint's behavior.

A brand-new standalone chart page is **not** recommended for early levels: it would
duplicate the symbol bus, overlay, and trade wiring and increase the risk of a
divergent (and less safe) trade path.

---

## 10. Explicit "do not touch" list

These surfaces must NOT be modified, bypassed, or weakened by any ARX Native Chart
work. (Cross-reference: `docs/SAFETY_NOTES.md`, `docs/ARCHITECTURE_MAP.md`, and the
non-negotiable invariants in `replit.md`.)

- **Live execution path** — `artifacts/api-server/src/routes/instantTrade.ts`,
  `artifacts/api-server/src/lib/live/instantTrade.ts`,
  `lib/live/liveCommandPipeline.ts`, and the legacy
  `lib/liveTrading/placeLiveOrderGuarded()` chokepoint.
- **16-gate evaluator** —
  `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` and everything under
  `lib/domain/src/safety-contracts/` (incl. `executionMode.ts`).
- **MT5 bridge routes** — `artifacts/api-server/src/routes/mt5.ts`,
  `mt5Live.ts`, `meLive.ts`, the `bridgeAuthPerUserOnly` guard, and tables
  `arx_live_commands` / `arx_live_positions` / `mt5_demo_commands`.
- **Mode & access resolvers** — `meUnifiedMode.ts`,
  `computeAccountModePrecedence.ts`, `userMasterLiveAccessGate.ts`.
- **TradingView embed** — `TradingViewLiveChart.tsx` and its pages
  (`live-chart`, `live-ai-assist`, `live-ai-auto-test`, `live-manual`). Stays as
  fallback/reference.
- **Ruby read-only contract** — `chartStructure.ts`, `meAssistant.ts`; never add a
  trade capability or cross-user read.
- **Candle honesty** — `marketDataRouter.ts` / `dataManager.ts`: never fabricate
  candles, never substitute simulator/paper/master data, keep the honest empty
  state.
- **Frontend instant router** — `lib/instantTradeRouter.ts`: the only sanctioned
  chart trade entry; no new frontend-only trade path.
- **Per-user isolation** — every overlay read stays on `/api/me/*` scoped
  endpoints.

> A native chart may **render** any of the above's outputs and **call**
> `executeInstantTrade`. It may not reimplement, relax, or route around any of
> them.

---

## 11. Chart-engine adapter (Task #373 — Smart Chart Shell)

The ARX Native Chart's imperative rendering engine has been extracted behind a
swappable **chart-engine adapter** so the renderer can be replaced without the
Shell (or any consumer) touching engine-specific code. This is a structural
refactor only — **no visual or behavioral change** to the Native chart.

### 11.1 New files

- `artifacts/trading-dashboard/src/lib/chart-engine/types.ts` — the
  `ChartEngineAdapter` contract plus `ChartEngineCandle` (Unix-seconds OHLC),
  `ChartEngineFeedState` (the live-price-affordance verdict),
  `ChartEngineInitOptions`, and the `ChartEngineCapabilities` descriptor.
  Overlays are typed as the EXISTING `ChartOverlay[]` model — the adapter
  consumes the same read-only overlay shape every surface already uses.
- `artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.ts`
  — `LightweightChartsAdapter`, the single owner of the imperative
  lightweight-charts v5 engine: `createChart` → `addSeries(CandlestickSeries)`
  (never the removed v4 `addCandlestickSeries`/`setMarkers`, never a cast),
  `setData` + the live-price affordance (last-value label + dashed "Last" line),
  the smart initial visible range (150 desktop / 80 mobile), overlay
  price-lines/zones + direction markers via `createSeriesMarkers`,
  `priceToCoordinate`, `resetScale`, the `ResizeObserver`, and the 16ms crosshair
  throttle.
- `artifacts/trading-dashboard/src/lib/chart-engine/index.ts` —
  `createChartEngineAdapter()` factory, `CHART_ENGINE_DESCRIPTORS`,
  `DEFAULT_CHART_ENGINE_ID` (`"lightweight-charts"`). The
  `"tradingview-advanced"` descriptor is registered `available: false`; the
  factory throws for it (see
  [`TRADINGVIEW_ADVANCED_CHARTS_LICENSING.md`](./TRADINGVIEW_ADVANCED_CHARTS_LICENSING.md)).

### 11.2 How ARXNativeChart drives the adapter

`ARXNativeChart.tsx` keeps ALL of its React state, props, badges, banners, mirror
layer, safe mode, OHLC banner, P/L bubbles, feed-status UI, fallback toggle, and
context callbacks. Only the imperative engine work moved out. The five engine
refs (`chartRef`/`seriesRef`/`priceLineRef`/`overlayLinesRef`/`markersApiRef` +
the crosshair/didFit handles) collapsed to a single `adapterRef`, and the engine
effects now call the adapter:

| Effect (deps) | Adapter call |
| --- | --- |
| build, `[resolvedSymbol, timeframe, effectiveHeight]` | `init()` + `destroy()` on cleanup, then bump `chartEpoch` |
| data, `[engineCandles, isLivePriceAffordance, chartEpoch]` | `setFeedState()` + `setCandles()` |
| overlays, `[overlays, candles, chartEpoch]` | `setOverlays(overlays, latestBarTime)` |
| P/L bubbles (RAF loop) | `priceToCoordinate()` |
| reset-scale button | `resetScale()` |

`engineCandles` is a memo that normalizes the contract candles (ISO `openTime` →
Unix seconds, finite OHLC) into `ChartEngineCandle[]`. The Native chart STILL
rebuilds the engine on a symbol/timeframe/height change (preserving zoom across
polls and preventing overlay bleed across instruments) and STILL suppresses the
live-price affordance on a non-LIVE feed.

### 11.3 Smart Chart Shell (`live-chart.tsx`)

The Live Chart page is now the Shell parent controller. It owns the symbol
(shared bus), the **timeframe (controlled** — passed into the Native renderer,
which reports user changes back via `onTimeframeChange`), the chart context +
intelligence snapshot, the read-only position + AI overlays, and **role gating**:
the single `ChartTradeEntry` surface is hidden for view-only (investor) roles and
while identity resolves (fail-safe), with placement still routed through the gated
instant-trade router. The TradingView reference stays a labeled toggle, and the
active engine label is surfaced from `CHART_ENGINE_DESCRIPTORS`.

---

## 12. ScannerChartPanel migration map (priority #1 — UNCHANGED in this task)

`components/scanner/ScannerChartPanel.tsx` is the **priority #1** chart surface
and is intentionally **NOT modified** by Task #373. It was audited only to record
how it would adopt the adapter in a later pass. It currently owns its own
inline lightweight-charts engine (same v5 API family as the Native chart did).

**Migration map (future work, not done here):**

| ScannerChartPanel concern | Adapter method it maps to |
| --- | --- |
| `createChart` + `addSeries(CandlestickSeries)` | `init()` |
| candle `setData` + live-price affordance | `setCandles()` + `setFeedState()` |
| signal/level overlays (lines/zones/markers) | `setOverlays(ChartOverlay[], latestBarTime)` |
| reset / fit visible range | `resetScale()` |
| any DOM coordinate overlay | `priceToCoordinate()` |
| `ResizeObserver` / crosshair throttle | owned inside the adapter |

**Why deferred:** ScannerChartPanel is the most-used, highest-risk chart and is
tightly coupled to the scanner's symbol bus, Broad/Focus scan, and chart trade
actions. Migrating it must be its own scoped task with its own verification so the
priority #1 surface is never destabilized. Any future migration must reuse the
SAME `ChartOverlay` model and route all trade actions through `executeInstantTrade`
exactly as it does today — the adapter changes how it *renders*, never how it
*trades*.
