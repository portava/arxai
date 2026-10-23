# ARX AI — Market-Data / API Inventory Audit

**Status:** DISCOVERY / REPORT ONLY. No code, providers, env keys, or feed
architecture were changed to produce this. Every path below was verified against
the live codebase (file paths are concrete) and, where possible, the running
environment.

**Scope:** every API, provider, feed, bridge, env key, service, endpoint, hook,
and UI surface involved in ARX market data, candles, quotes, scanner results,
Ruby analysis, live execution, account totals, and open trades.

---

## 0. One-paragraph answer

ARX has **one** unified candle/quote router (`lib/data/marketDataRouter.ts`) that
every analysis surface funnels through, and **one** broker-truth path
(MT5 bridge → `arx_live_*` tables) that every execution and account-total surface
funnels through. The two are deliberately separated: **no external price feed can
ever create a fill, move a balance, or override an execution price.** What looks
like "many feeds" is really one router with a priority chain per asset class. The
EURUSD screenshot ("assistant_real:polygon / stale / not AI-usable") is the system
behaving **correctly**: the reserved MT5-broker candle slot is not active yet
(EA only heartbeats), so the router fell through to the third-party assistant chain,
TwelveData returned nothing usable for 1-minute forex, Polygon's free tier served a
delayed bar, the freshness rule correctly flagged it stale, and Ruby was correctly
blocked from "AI-confirmed" analysis. The real cleanup opportunities are: (a) the
**scanner's simulator fallback** for technicals (honestly tagged, analysis-only,
but still synthetic), and (b) several **legacy `aiBrain`/`marketSimulator`
analysis endpoints** that predate the router and are now redundant.

---

## 1. APIs / providers found in code

| Provider | Adapter file(s) | Returns | Asset classes | Transport |
| --- | --- | --- | --- | --- |
| **MT5 broker** (reserved) | `lib/data/mt5Provider.ts`, `…/symbolDirectory.ts` | candles, quotes (designed) | all | EA push (heartbeat only today) |
| **Deriv** | `…/lib/marketData/derivProvider.ts`, `derivWsClient.ts` | candles, ticks | synthetics (V10–V100, BOOM/CRASH/STEP/JUMP) | **WebSocket** (server-side) |
| **TwelveData** | `…/lib/assistant/marketProvider.ts` (+ `lib/data/twelveDataProvider.ts` shim) | candles, quotes | forex, crypto, stocks | REST poll |
| **Polygon** ("Massive" rebrand) | `…/lib/assistant/marketProvider.ts` | candles (D1 + `/prev` only on free tier), quotes, news | forex, stocks | REST poll |
| **Alpha Vantage** | `…/lib/assistant/alphaVantageProvider.ts` | quote / news / overview (**no candles**) | forex, stocks | REST poll |
| **Finnhub** | `…/lib/assistant/marketProvider.ts` | quotes, news (candles partial) | forex, crypto, stocks | REST poll |
| **NewsAPI.org** | `…/lib/assistant/newsProvider.ts` | geopolitical headlines | macro | REST poll |
| **Economic calendar** | `…/lib/marketData/economicCalendarProvider.ts` | events | macro | **honest seam — returns `connected:false`, empty** |
| **Market simulator** | `…/lib/marketSimulator.ts` | synthetic OHLC | all (analysis only) | in-memory |

`assistant_real` is **not** a third-party API — it is the router's internal slot
ID for the composite chain `[TwelveData → Polygon → AlphaVantage]` defined in
`marketProvider.ts`. The UI source label `assistant_real:polygon` means "the
assistant composite slot, won by its Polygon adapter." There is **no**
`MASSIVE_API_KEY` / `ASSISTANT_REAL` env var — "Massive" is just Polygon's rebrand.

---

## 2. Environment variables (names + status only — no values printed)

| Env var | In code | Runtime use | Required/Optional | Status in THIS env |
| --- | --- | --- | --- | --- |
| `TWELVEDATA_API_KEY` | yes | `marketProvider.ts`, provider health | required for TwelveData | **configured** |
| `POLYGON_API_KEY` | yes | `marketProvider.ts`, provider health | optional (fallback) | **configured** |
| `DERIV_APP_ID` | yes | `derivWsClient.ts`, `derivProvider.ts` | required for Deriv | **configured** |
| `DERIV_API_TOKEN` | yes | `derivWsClient.ts` | optional (auth features) | **configured** |
| `DERIV_API_MODE` / `DERIV_WS_URL` / `DERIV_ACCOUNT_ID` | yes | `derivWsClient.ts` | optional | unset (defaults used) |
| `FINNHUB_API_KEY` | yes | `marketProvider.ts` | optional (hybrid quotes/news) | **missing** |
| `ALPHA_VANTAGE_API_KEY` | yes | `alphaVantageProvider.ts` | optional (tertiary) | **missing** |
| `NEWSAPI_API_KEY` | yes | `newsProvider.ts` | optional (news only) | **missing** |
| `NEWS_PROVIDER` | yes | `newsProvider.ts` | optional (`real` vs honest-empty) | unset → honest-empty |
| `MARKET_DATA_MODE` | yes | `marketDataService.ts` | optional (`read_only`) | unset |
| `MT5_BRIDGE_TOKEN` (server-wide) | referenced | **rejected everywhere by design** | must NOT be set | not set (correct) |
| `ARX_LIVE_BROKER_EXECUTION_ENABLED` | yes | Phase B gate #1 | optional | `"true"` (intentional, do not reset) |

**Net effect of the missing keys:** the assistant composite chain is effectively
`[TwelveData → Polygon]` (AlphaVantage has no candle support and no key; Finnhub
has no key). News real-provider is off → honest-empty. Economic calendar is a
not-yet-connected seam. None of these gaps can affect execution — they only reduce
analysis coverage and force honest empty/stale states.

---

## 3. What is actually feeding each surface right now

| Surface | Endpoint / hook | Provider actually used | Fallback | UI source label | Freshness / stale rule | Ruby? | Can affect trades? | Truth type |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Main chart** (ARXNativeChart) | `GET /api/chart/candles` → `chartDataService.ts` → `routeCandles` | mt5_broker (reserved→skip) → deriv (synthetics) / assistant_real (forex/metals/idx/crypto/stocks) | next provider in chain | winning provider, e.g. `assistant_real:polygon` | clean ≤1 trailing interval; delayed =2; **stale ≥3** | clean only | **no** | analysis / live-feed display |
| **Scanner chart** (ScannerChartPanel) | `GET /api/chart/candles` (shared dedup cache) | same router | same | same | same | clean only | **no** | analysis |
| **Scanner results** (rows) | `GET /api/market-scanner/opportunities` → `marketScanner.ts` | **router-first** (`routeCandles`) per row; **simulator fallback** when real feed missing | simulator (tagged) | per-row `dataSource`: `LIVE_FEED` / `AWAITING_FEED` / `HISTORY_READY_AWAITING_LIVE_TICK` / **`SIMULATOR`** | per-row tag; sim rows say "based on simulated data, not a live feed" | yes (reads rows) | **no** | analysis-only (honestly tagged) |
| **Ruby chart read** | `POST /api/me/assistant/read-chart` → `chartStructure.ts` (deterministic, no LLM) over `/api/chart/candles` | router | — | carries `paper_only` envelope; `aiUsable` from feedStatus | clean ⇒ VERIFIED, else honest gated read | n/a | **no** (read-only) | analysis-only |
| **Ruby trade recommendation** | scanner/`aiBrain` advisory cards | router (scanner) / simulator (legacy aiBrain card) | — | advisory | advisory | yes | **no** (advisory) | analysis-only |
| **Ruby live trade command** | `executeInstantTrade` (`source:ruby_text/ruby_voice`) → `instantTrade.ts` → `liveCommandPipeline.ts` | **MT5 broker bridge** | none | — | 16-gate + heartbeat ≤15s | n/a | **YES** | **broker-truth** |
| **Dashboard account totals** | `GET /api/me/dashboard/intelligence`, `liveAccountSnapshot.ts` | MT5 heartbeat (`mt5_connection`) + `arx_live_positions` | — | `MT5_LIVE_BRIDGE` / `MT5_DEMO_BRIDGE` | fresh ≤30s, stale ≤120s, else missing | reads | **no** | **broker-truth** |
| **Open Trades panel** | `GET /api/me/positions/all` | `arx_live_positions` (+ demo), per-user scoped; floating P/L via fresh router quote | — | bridge | position freshness | reads | **no** | **broker-truth** |
| **Admin live account totals** | `GET /api/admin/live/master-summary` | master MT5 bridge balance/equity | — | master pool | heartbeat | n/a | **gating** | **broker-truth** |
| **Allocation / headroom** | `GET /api/admin/allocations`, `user_slot_allocation` | DB allocation − reserved risk − floating P/L | — | DB | snapshot | n/a | **gating** | broker-truth (DB) |
| **Symbol search / directory** | `symbolRegistry.ts` (FE) / `symbolNormalizer.ts` + `symbolDirectory.ts` (BE, `arx_symbol_specs`) | static catalog + broker resolve | — | — | — | yes | indirectly (resolves broker symbol) | config/directory |
| **News** | `GET /api/news/*` → `newsProvider.ts` | NewsAPI (if keyed) else honest-empty | — | provider/connected flag | provider freshness | yes (advisory) | **no** | analysis-only |
| **Economic calendar** | `GET /api/news/calendar` → `economicCalendarProvider.ts` | **not connected** (honest empty) | — | `connected:false` | n/a | advisory | **no** | analysis-only |
| **Backtesting / historical** | `GET /api/backtest-runs` → `strategyEngine.ts` | client-uploaded CSV candles, or seeded deterministic synthetic | — | explicit | — | no | **no** | analysis-only |
| **WebSocket / SSE market stream (UI)** | none | — | — | — | — | — | — | UI uses HTTP polling only; Deriv WS is server-side behind the router |

---

## 4. Real source of truth per data type

| Data type | Current actual source | Expected correct source | Safe for live? | Analysis-only? | Known gaps |
| --- | --- | --- | --- | --- | --- |
| Live bid/ask | assistant_real / deriv quote (mt5 reserved) | mt5_broker quote | No (not execution price) | Yes | mt5 quote push inactive (EA v1.27) |
| Spread | derived from quote / broker spec | broker spec | No for sizing precision | Yes | per-symbol contract model is a $1000/lot proxy |
| Candles | `routeCandles` chain | mt5_broker → real fallback | display only | Yes | mt5 candle push inactive; free-tier intraday gaps |
| Ticks | Deriv WS (synthetics only) | mt5 / broker | No | Yes | no broker tick stream yet |
| Broker tradability | `brokerSymbolSpec.ts` / `symbolTradability.ts` (broker-reported) | same | **Yes** | — | synthetics need symbol in user's Market Watch |
| Open positions | `arx_live_positions` (EA-synced) | same | **Yes** | — | requires absence-reconcile guard for ghosts |
| Pending orders | `arx_live_commands` | same | **Yes** | — | — |
| Fills / rejections | `arx_live_commands` (real ticket + retcode) | same | **Yes** | — | close fill price absent (EA limitation) |
| Balance / equity / margin / free margin | `mt5_connection` heartbeat | same | **Yes** | — | stale if heartbeat ages out |
| Open P/L | `liveAccountSnapshot.ts` (positions × fresh quote) | same | **Yes** (with reconciliation flag) | — | flags "under verification" if Σ vs equity−balance > $1 |
| Scanner technicals | router candles **or simulator fallback** | router candles | analysis-only | **Yes** | simulator fallback still computes indicators (tagged) |
| Ruby market analysis | router candles (deterministic) | router candles | analysis-only | **Yes** | gated to clean feed |
| News | NewsAPI or honest-empty | a connected real provider | analysis-only | **Yes** | no key in this env |
| Economic calendar | not connected (empty) | a connected calendar API | analysis-only | **Yes** | seam only |
| Historical backtest | CSV / seeded synthetic | persisted real candles | analysis-only | **Yes** | no candle/tick persistence layer exists |

---

## 5. The EURUSD 1m screenshot, explained

> Polygon · Fallback feed · `assistant_real:polygon` · stale · last candle 2m ago ·
> last tick missing · AI usable: not confirmed · newest bar trails by 3 intervals.

- **Which endpoint returned this?** `GET /api/chart/candles` (`routes/chart.ts` →
  `chartDataService.ts` `getChartCandles`/`buildChartFeed`). The legacy
  `/api/data/candles` returns a bare array with **no** feedStatus — this rich
  status block can only come from `/api/chart/candles`.
- **Which adapter produced it?** The **Polygon** adapter inside the `assistant_real`
  composite chain (`marketProvider.ts`). `r.source = "polygon"` is appended to the
  slot ID → `assistant_real:polygon`.
- **Why wasn't MT5 used for broker candles?** `mt5Provider.isConnected()` returns
  `false` — EA v1.27 only heartbeats and never pushes ticks/candles, so its
  `lastUpdate` stays 0. The router's reserved top `mt5_broker` slot fails fast with
  `MT5_BROKER_FEED_NOT_ACTIVE` and falls through. **Correct, by design.**
- **Was an MT5 quote available?** No — same reason. The bridge pushes account /
  positions / heartbeat only, not market quotes.
- **Was MT5 candle history unavailable?** Yes — never pushed; nothing to serve.
- **Did fallback work correctly?** Yes. Chain order for forex is
  `mt5_broker → assistant_real`. Inside assistant_real the order is
  `TwelveData → Polygon → AlphaVantage`. TwelveData returned nothing usable for
  1-minute forex (free-tier intraday limit / empty), AlphaVantage has no candle
  support and no key, so **Polygon won** — exactly the documented fall-through.
- **Is Polygon truly stale, or is the freshness math wrong?** Truly stale, and the
  math is right. On Polygon's **free tier only D1 candles and `/prev` quotes** are
  usable for forex; intraday is delayed. So the newest bar legitimately trails
  "now" by ≥3 one-minute intervals. `STALE_TRAILING_INTERVALS = 3` (hardcoded in
  `chartDataService.ts`) → `quality:"stale"` → message "newest bar trails current
  bar by N intervals." Not a calculation bug.
- **Is the chart frozen intentionally?** Yes. On a non-clean/non-LIVE feed the
  chart suppresses the live-price affordance (no live "Last" line update) — an
  intentional honesty behavior, not a hang.
- **Is Ruby correctly blocked from AI-confirmed analysis?** Yes. `aiUsable` is
  `true` **only** when `quality === "clean"`. Stale ⇒ `aiUsable:false` ⇒ the UI
  "AI usable: not confirmed", and Ruby's read-chart degrades to an honest gated
  read instead of a VERIFIED one. Correct.

**Note on the label "Polygon" + "Fallback feed":** these are accurate. Polygon is
itself the *fallback inside the fallback* (assistant chain), reached because the
broker slot is inactive and TwelveData came back empty.

---

## 6. Per-provider activation matrix

| Provider | Code exists | Env key set (this env) | Reachable here | Chart | Scanner | Ruby | Execution | Safe as **execution** truth | Current health |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MT5 broker | yes | bridge token per-user | heartbeat only | reserved (skip) | reserved | reserved | **YES (orders)** | **YES** (execution price at dispatch) | live heartbeat, **no quote/candle push** |
| Deriv | yes | yes | yes (WS) | synthetics | synthetics | synthetics | no | No | active for synthetics |
| TwelveData | yes | yes | yes | yes | yes | yes | no | No | free-tier intraday gaps |
| Polygon | yes | yes | yes | yes (fallback) | yes | yes | no | No | free tier = D1/`prev` only → often DELAYED |
| Alpha Vantage | yes | **no** | n/a | quote/news only (no candles) | no | no | no | No | inactive (no key) |
| Finnhub | yes | **no** | n/a | hybrid quotes/news | no | no | no | No | inactive (no key) |
| NewsAPI | yes | **no** | n/a | n/a | advisory | advisory | no | No | honest-empty |
| Economic calendar | seam | n/a | n/a | n/a | advisory | advisory | no | No | not connected (empty) |
| Market simulator | yes | n/a | yes | no | **fallback (tagged)** | legacy advisory | no | **No (never)** | in-memory |

Only **MT5 broker** is ever execution truth, and only for orders/fills/account —
never for the chart price feed today.

---

## 7. Duplicate / conflicting feed systems

There is **one** authoritative candle/quote path (`marketDataRouter.routeCandles`)
and **one** broker-truth path. But several **legacy, pre-router analysis systems**
still exist and are the main source of confusion:

1. **Two candle endpoints.** `/api/chart/candles` (rich, normalized, carries
   `feedStatus`) vs legacy `/api/data/candles` (bare array, no status). Both call
   the same router, so no truth conflict, but two contracts mean drift risk. The
   Native chart, Scanner chart, Ruby read, and PositionMiniChart now standardize on
   `/api/chart/candles`; `/api/data/candles` lingers.
2. **Scanner simulator fallback.** `marketScanner.ts` is router-first but falls back
   to `marketSimulator.ts` for technicals when a real feed is missing. It is
   **honestly tagged** per row (`dataSource:"SIMULATOR"`) and synthetics are never
   given simulator OHLC — but it is still synthetic data driving displayed
   indicator values.
3. **Legacy `aiBrain` / `marketDataLayer` / `oms` / `autopilot` / `shadowMode`**
   all import `marketSimulator` directly. These predate the router. Several legacy
   `scanner.ts` sub-routes hard-tag `dataSource:"SIMULATOR"` (lines ~73, 123, 133,
   142, 152, 192). They are analysis/advisory only and cannot reach execution.
4. **Stale thresholds live in several places** with different semantics (not a bug,
   but worth knowing): `chartDataService.STALE_TRAILING_INTERVALS = 3` (bar-gap,
   drives UI), `candleTruthEngine.TRUTH_STALE_TRAILING_INTERVALS = 3` (internal
   audit), `mt5Provider.CANDLE_TTL_MS = 5min` (wall-clock, provider liveness),
   `marketProvider.CANDLE_TTL_MS = 60s` (cache) / `STALE_AFTER_MS = 5min`
   (liveness). On a 1m chart the UI flags stale after 3 minutes while the provider
   may still call itself "fresh" for 5 — a definitional mismatch to be aware of.

**No mismatch reaches money:** dashboard/open-trades/allocation read broker truth;
charts/scanner/Ruby read the router; execution re-prices at the broker.

---

## 8. Can external feeds become live-trade truth? (safety verification)

| Check | Result |
| --- | --- |
| External provider price can update balance/equity/open P/L | **No** — totals come only from `mt5_connection` heartbeat + `arx_live_positions`; quotes are used solely to *display* floating P/L, behind a reconciliation flag |
| External candles can create live fills | **No** — fills exist only as `arx_live_commands` rows produced by the EA after the 16-gate dispatch |
| External quote can override MT5 execution price | **No** — execution uses the broker's price at OrderSend; the router price never enters the dispatch |
| Ruby trade commands use broker bridge only | **Yes** — `executeInstantTrade` → `liveCommandPipeline` → 16-gate; no second path |
| Manual trades use broker bridge only | **Yes** — same router |
| Scanner trade buttons use broker bridge only | **Yes** — same router; PAPER renders no buttons |
| Simulator data can reach execution | **No** — analysis-only, always tagged |

No safety violations found in the data→execution boundary.

---

## 9. Final audit report

- **APIs/providers found:** MT5 broker (reserved), Deriv, TwelveData, Polygon
  ("Massive"), Alpha Vantage, Finnhub, NewsAPI, economic-calendar seam, market
  simulator.
- **Actually active in this env:** MT5 bridge (heartbeat/account/positions),
  Deriv (synthetics WS), TwelveData (primary forex/crypto/stocks), Polygon
  (forex/stocks fallback, free-tier delayed).
- **Configured but unused/limited:** Polygon (active but intraday-limited),
  `/api/data/candles` (legacy duplicate endpoint), simulator (analysis fallback).
- **Missing env keys:** `FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY`,
  `NEWSAPI_API_KEY` (+ economic calendar not connected). `MT5_BRIDGE_TOKEN`
  server-wide is intentionally absent (rejected by design).
- **EURUSD chart feed path:** `/api/chart/candles` → router forex chain
  `mt5_broker (inactive→skip) → assistant_real[TwelveData empty → Polygon won]`
  → Polygon delayed bar → trails ≥3 intervals → `stale` → `aiUsable:false`. Working
  as designed.
- **Scanner feed path:** `/api/market-scanner/opportunities` → `marketScanner.ts`
  router-first per row; honest `SIMULATOR` fallback tag when no real feed.
- **Ruby feed path:** read/analysis via deterministic `chartStructure.ts` over the
  router (gated to clean); execution via `executeInstantTrade` → 16-gate bridge.
- **Live execution feed path:** MT5 broker bridge only (`arx_live_commands` /
  `arx_live_positions`), 16-gate Phase B.
- **Dashboard / open-trades path:** MT5 heartbeat + `arx_live_positions`
  (broker-truth, per-user scoped).
- **Feed mismatches:** dual candle endpoints; multi-location stale thresholds with
  different units; scanner sim-fallback vs router.
- **Dead / duplicated feed code:** legacy `marketSimulator` consumers
  (`aiBrain.ts`, `marketDataLayer.ts`, `oms.ts`, `autopilot.ts`, `shadowMode.ts`)
  and legacy `SIMULATOR`-tagged `scanner.ts` sub-routes; `twelveDataProvider.ts`
  shim in `lib/data` is an honest stub (real calls live in `marketProvider.ts`);
  AlphaVantage candle path is a permanent honest-empty.
- **Safety risks:** none at the data→execution boundary. Lower-severity items:
  (1) scanner technicals can be computed over simulator candles (tagged, but a
  user skimming may miss the tag); (2) chart price feed is third-party and delayed
  until the MT5 candle push lands — fine for analysis, not for precise entries;
  (3) stale-threshold definitions diverge across files.
- **Recommended provider hierarchy** (once MT5 quotes push):
  `mt5_broker → deriv (synthetics) → assistant_real[TwelveData → Polygon →
  (Finnhub/AlphaVantage if keyed)]` for analysis; **broker-only** for execution and
  account truth. This is already the encoded chain — it just needs MT5 quote/candle
  push (EA v1.28+) to light up the top slot.
- **Minimal next fix:** add `TWELVEDATA`-tier headroom or a second intraday-capable
  forex key so the 1m chart stops falling to Polygon-delayed (or accept the honest
  stale state). No architecture change required.
- **Larger architecture fix:** (a) collapse `/api/data/candles` consumers onto the
  `/api/chart/candles` truth contract and retire the bare endpoint; (b) centralize
  the stale-threshold constants into one shared module; (c) gate or retire the
  legacy `marketSimulator`/`aiBrain` analysis surfaces behind the router; (d) wire
  the MT5 candle/quote push (EA v1.28) to activate `mt5_broker` as the primary
  chart feed with zero router changes.

---

## 10. Pass criterion

> "What APIs are listed in ARX, what APIs are actually connected, and what is truly
> feeding each part of the app right now?"

- **Listed (code exists):** §1 — 9 providers/seams.
- **Actually connected (this env):** MT5 bridge (heartbeat/account/positions),
  Deriv WS (synthetics), TwelveData (primary), Polygon (delayed fallback). Finnhub,
  AlphaVantage, NewsAPI, economic calendar = **not** connected (no keys / seam).
- **Truly feeding each surface right now:** §3 + §5 — charts/scanner/Ruby read the
  unified router (today landing on TwelveData→Polygon for forex, Deriv for
  synthetics); dashboard/open-trades/allocation/admin totals read **broker truth**
  (MT5 bridge + `arx_live_*`); execution is **broker-only** behind the 16-gate
  pipeline; news/calendar are honest-empty; backtests use uploaded/synthetic data.

**Discovery complete. No code, providers, env keys, or feed architecture were
changed.**
