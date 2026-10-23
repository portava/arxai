# ARX AI API Server — Broken/Stub Code Audit

Auditor sweep of `artifacts/api-server/src` (912 files) and `lib/` for BROKEN, STUB, and DEBT code.
All paths below are relative to `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai/` unless absolute. Every claim is grounded in read code, file:line cited.

**Spec conflict noted up front:** the binding spec (`/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md`, header: "Core: Python 3.12, PostgreSQL") targets Python; the actual codebase is TypeScript/Express. All findings are evaluated against the TypeScript equivalents. Two spec constraints used as yardsticks throughout: "There is no silent fallback from live to demo, paper, mock, or simulated execution" and "Market data is provenance-bound" (spec §1, hard constraints).

---

## Classification key

- **BROKEN** — does not work as shipped (wrong behavior, 404s, data corruption).
- **STUB** — pretends / placeholder / fabricated data presented as real.
- **DEBT** — works but fragile, stale, dead, or misleading.

---

## A. BROKEN

### A1. `POST /api/mt5-webhook` TRADE_CLOSE closes an **arbitrary** open trade (any user's)
- **File:** `artifacts/api-server/src/routes/trades.ts:343-346`
- **Evidence:** on a `TRADE_CLOSE` event the handler does:
  ```ts
  const trades = await db.select().from(tradesTable).where(eq(tradesTable.status, "OPEN")).limit(1);
  if (trades[0]) { ... db.update(tradesTable).set(updateSet).where(eq(tradesTable.id, trades[0].id)); }
  ```
  No match on `ticket`, `symbol`, or `userId` — it grabs the **first OPEN row in the whole table** and marks it closed (defaulting to `CLOSED_LOSS` when profit is missing, trades.ts:361-372). Any webhook close event can corrupt a random user's trade history.
- **Compounding auth problem:** the endpoint is gated by a **local copy of the legacy server-wide token check** (`routes/trades.ts:35-47`: `const expected = process.env["MT5_BRIDGE_TOKEN"]`). `docs/SAFETY_NOTES.md:17-19` and `routes/mt5.ts:295-307` claim "the legacy server-wide `MT5_BRIDGE_TOKEN` env value is **rejected** everywhere" — this endpoint contradicts that: if the env var is set, one shared secret authorizes cross-user writes to `trades`. `TRADE_OPEN` (trades.ts:318-330) inserts rows with **no `userId`** and `mode: "LIVE"`, `confidence: 90` hardcoded.
- **Classification:** BROKEN (data corruption) + safety-doc drift.
- **Repair:** match close events by broker `ticket` (persist ticket on open); attribute rows via per-user bridge auth (`bridgeAuthPerUserOnly`, routes/mt5.ts:220) or retire the endpoint entirely (the EA no longer uses it); make SAFETY_NOTES true by deleting the env-token auth path here.

### A2. Double `/api` mount — user-readiness and opportunity-radar routers are unreachable; dashboard card permanently errors
- **Files:** `artifacts/api-server/src/routes/index.ts:428` (`router.use("/api", userReadinessRouter)`) and `:432` (`router.use("/api", opportunityRadarRouter)`), combined with `artifacts/api-server/src/app.ts:152` (`app.use("/api", router)`).
- **Evidence:** the app mounts the aggregate router at `/api`, and these two sub-routers are mounted **again** under `/api`, so their handlers (`routes/userReadiness.ts:59` `GET /readiness/me`, `:70` `/readiness/me/blockers`, `:92` `/onboarding/me/progress`, `:127` `/onboarding/me/accept-disclosure`, `:166` `/onboarding/me/account-mode`, `:188-249` admin readiness approve/revoke-live; `routes/opportunityRadar.ts:30-112` `/opportunities/*`, `/watchlist/intelligence`) only answer at `/api/api/...`. No other router defines these paths (verified by grep across `routes/`).
- **Frontend impact:** `artifacts/trading-dashboard/src/components/readiness/TradingSetupReadinessCard.tsx:39` fetches `/api/readiness/me` and throws on `!r.ok`; the card is rendered on the main dashboard (`artifacts/trading-dashboard/src/pages/dashboard.tsx:216`), so it always shows "Couldn't load readiness right now."
- **Classification:** BROKEN (unreachable routes + visible UI failure).
- **Repair:** change both mounts to `router.use(userReadinessRouter)` / `router.use(opportunityRadarRouter)` (matching every other router in the file), or strip the `/api` prefix from the mount. One-line fixes; re-run the FE dashboard to confirm.

### A3. Settings → Risk parameters panel reads and writes a nonexistent endpoint (silent save failure)
- **Files:** `artifacts/trading-dashboard/src/pages/settings.tsx:376` (GET `/api/risk-settings`), `:386` (PUT `/api/risk-settings`); same pattern in `artifacts/trading-dashboard/src/pages/admin/settings.tsx:251,260`.
- **Evidence:** the server's canonical route is `GET /api/risk/settings` (`artifacts/api-server/src/routes/risk.ts:73`; generated client agrees — `lib/api-client-react/src/generated/api.ts:4914` returns `/api/risk/settings`). There is **no** `/api/risk-settings` route and **no PUT** handler for risk settings anywhere in `routes/` (the per-user surface is `GET/POST/PATCH /api/me/risk-settings`, `routes/meRiskGovernor.ts:81-100`). The FE pages bypass the generated hooks with raw `fetch` to the wrong path: the GET 404s (query data stays undefined, panel renders defaults), and the PUT 404s with an HTML body so `.then(r => r.json())` rejects — the mutation fails silently (no `onError` handler) and the user's risk-parameter edits are never persisted.
- **Classification:** BROKEN (frontend contract; silent data-loss on save).
- **Repair:** use the generated `getRiskSettings` hook for reads and wire writes to `PATCH /api/me/risk-settings` (or add the missing PUT to `routes/risk.ts` if a global-settings write is intended); add `r.ok` checks to both fetches.

### A4. MT5 setup checklist instructs operators to configure a dead env var; legacy auth middleware is dead code
- **Files:** `artifacts/api-server/src/routes/mt5.ts:809` (`const tokenConfigured = !!process.env["MT5_BRIDGE_TOKEN"]`), `:829-834` (checklist item: "Bridge token configured in Replit Secrets … Add MT5_BRIDGE_TOKEN in Replit Secrets."), `:836` ("Broker placement layer not implemented; all commands forced to BLOCKED.").
- **Evidence:** every EA-facing endpoint uses `bridgeAuthPerUserOnly` (routes/mt5.ts:311, 902, 980, 1237, 1303, 1711, 1823, 1948, 2073, 2196, 2276, 2319) which **hard-denies** the system env token (routes/mt5.ts:233-236). The GET `/api/mt5/setup-checklist` still reports `MT5_BRIDGE_TOKEN` as a required setup step, sending operators to configure a value that has no effect on bridge auth (its only remaining effect is enabling the A1 webhook above — which is worse). The full legacy middleware `requireBridgeToken` (routes/mt5.ts:136-171) is defined and never used — dead code.
- **Classification:** BROKEN guidance (operator-facing) + DEBT (dead middleware).
- **Repair:** replace the checklist item with "per-user bridge token issued from MT5 Setup (`POST /api/me/mt5-connections`)" and delete `requireBridgeToken` from mt5.ts; also update `:836` wording (see D2 — the sentinel is stale relative to Phase B).

---

## B. STUB (pretends / placeholder presented as real)

### B1. `POST /api/execute-trade` reports "LIVE trade executed" without any broker dispatch
- **File:** `artifacts/api-server/src/routes/trades.ts:97-297`.
- **Evidence:** after passing tradeGate, broker-health, and confirmation-claim checks, the handler **only inserts a DB row** (`db.insert(tradesTable).values({ ... status: "OPEN", mode: gate.decisionMode === "LIVE" ? "LIVE" : "DEMO" })`, trades.ts:254-266) and responds `"${gate.decisionMode} trade executed"` (trades.ts:286-291). There is no MT5 command, no live-command-pipeline call, no broker I/O of any kind in this file. `docs/SAFETY_NOTES.md:64` admits it: "Currently returns mock execution; replace with real bridge in production." A user reaching LIVE decision-mode gets a success message and an OPEN "LIVE" trade row that no broker ever saw — the exact "silent fallback from live to … simulated execution" the spec forbids (spec §1 hard constraints).
- **Classification:** STUB presented as real (the real Phase B path is `lib/live/liveCommandPipeline.ts` via the instant-trade router; this legacy entry point fabricates success).
- **Repair:** either route LIVE decisions into the Phase B pipeline (`routes/instantTrade.ts` seam) or make the endpoint refuse LIVE mode with an explicit `NOT_A_BROKER_PATH` error; at minimum change the success message to say "recorded (no broker order placed)". `pages/emergency.tsx` still references this endpoint (SAFETY_NOTES:154).

### B2. Demo macro-data intelligence backends served as real (the SAFETY_NOTES §6 soft-spot list, enumerated exactly)
`docs/SAFETY_NOTES.md:156` admits: "Multiple 'intelligence' backends (`forexIntelligence.ts`, `indicesIntelligence.ts`, default `marketBrain` candle source) currently use hardcoded macro tables + synthetic candles. They are wired end-to-end but their *content* is demo data." Verified, and the list is actually longer:

1. **`GET /api/forex/intelligence`** — `routes/intelligence.ts:7-9` → `lib/forexIntelligence.ts`. Hardcoded macro table (`CURRENCY_MACRO`, forexIntelligence.ts:36-46, "Mock macro data" comment), hardcoded base strengths with `Math.random()` jitter ("Small demo randomization (±3 points)", :63-64), and **risk sentiment simulated from the UTC hour + a coin flip** (:68-75). The JSON payload carries **no demo/simulated marker**.
2. **`GET /api/indices/intelligence`** — `routes/intelligence.ts:11-13` → `lib/indicesIntelligence.ts`. "Mock macro context" (:33): random VIX (`14 + Math.random()*8`, :35), `dollarStrength = "Strong" // Mock` (:43), random 10Y yield around 4.45 (:45), and hardcoded index levels (`INDEX_META`, :118-125: US30 39200, SPX500 5230, …) served as `currentLevel` with ±0.2% random jitter (:137). No demo marker in the payload.
3. **`GET /api/synthetic/analysis`** — `lib/indicesIntelligence.ts:170-176`: fully canned V75/V25 ATR/trend/risk stats.
4. **`POST /api/brain/analyze` default candle source** — `routes/brain.ts:23` calls `analyzeMarket(symbol, undefined, …)` → `brain/marketBrain.ts:142` `candles ?? generateSyntheticCandles(symbol, 250)`. Entry/SL/TP and confidence are computed from synthetic candles and returned **without any `dataSource` field** (contrast the honest sibling `lib/aiBrain.ts:48` which tags every result `dataSource: "SIMULATOR"`).
5. **`brain/macro/macroEngine.ts:85-93`** — "Global macro context (mock)": constants `bondYield10Y = 4.45`, `vixEstimate = 15.2`, `fedBias: "Neutral"`, `dollarStrength: "Strong"` feed `/api/brain/analyze`'s `macroDetails`.
6. **`brain/news/newsRiskEngine.ts:23-49`** — a hardcoded weekly `NEWS_SCHEDULE` (day-of-week/hour patterns for "FOMC Rate Decision", "US CPI", one literally named "Fed Chair Speech (simulated)") is served through `/api/brain/analyze` `newsDetails.nextEvent` as if it were event detection. The real calendar stack exists separately (`lib/news/calendar/*` with TradingEconomics/FRED providers) and is honest — the brain engine never uses it.
- **Classification:** STUB presented as real (items 1, 2, 4, 6 have no simulated marker in their payloads).
- **Repair:** short-term, stamp every response from these modules with `dataSource: "DEMO_MACRO"` / `simulated: true` and surface it in the UI (the `pages/stocks-center.tsx` mock banner covers only one page per SAFETY_NOTES:156). Long-term, back them with `lib/news/calendar/*` and the unified `marketDataRouter` the way `lib/marketScanner.ts` already is.

### B3. `brokerReadOnly` connector defaults to a fake-positive "demo" provider
- **File:** `artifacts/api-server/src/lib/brokerReadOnly/service.ts:100-121, 140, 156`.
- **Evidence:** with `BROKER_PROVIDER` unset the provider defaults to `"demo"` (:140) which returns `connected: true`, a fabricated account (balance 10000, equity 10245.50), fake V75/V100 quotes, and `dataQuality: { status: "GOOD" }`. Served by `routes/brokerReadOnly.ts:44-85`. The only honesty signal is the `provider: "demo"` string. `lib/aaci/snapshotService.ts:128-135` explicitly refuses to trust it for exactly this reason ("consuming that as a 'live' account would surface a fabricated balance and a fake 'connected' bridge").
- **Classification:** STUB (fake-positive `connected:true` + `GOOD` quality on fabricated data).
- **Repair:** make the demo provider report `connected: false` or `dataQuality.warnings: ["DEMO PROVIDER — fabricated figures"]`, and default `BROKER_PROVIDER` to the honest `mt5` stub (service.ts:123-126) which reports `MISSING`.

### B4. Alert delivery hooks are silent no-ops
- **File:** `artifacts/api-server/src/lib/alerts/alertManager.ts:164-166` (fired) and `:229-231` (empty bodies).
- **Evidence:** `createAlert` fires `void sendEmailAlert(...)`, `void sendSMSAlert(...)`, `void sendPushNotification(...)`; all three are `async (_alert) => {}` — "Placeholder delivery hooks (no-ops) — reserved for email / SMS / push" (:228). Every alert appears delivered from the caller's perspective; nothing leaves the box.
- **Classification:** STUB.
- **Repair:** wire to the real notification service (`lib/notificationService.ts`) or delete the calls so nobody assumes external delivery exists.

### B5. `alphaVantageProvider` returns mock data even with a key, while `isConnected()` reports true
- **File:** `artifacts/api-server/src/lib/data/providers/alphaVantageProvider.ts:11-25`.
- **Evidence:** `getCandles`/`getQuote` return `mockProvider` output unconditionally ("Real network call placeholder — disabled…", :13-15) but `isConnected()` returns `!!ALPHA_VANTAGE_API_KEY` (:23-25) — the fake-positive pattern the honest twelveData shim was rewritten to avoid (`lib/data/providers/twelveDataProvider.ts:4-23`). Mitigation: **no live importer remains** — the unified router (`lib/data/marketDataRouter.ts:9-14`) bypassed it, and real Alpha Vantage candle fetches live in `lib/assistant/marketProvider.ts:789` (which honestly returns empty candles + a note, :798).
- **Classification:** STUB, currently dead code.
- **Repair:** delete the file (or make `isConnected()` return false like the twelveData shim) so it can never be re-wired as a "connected" provider.

### B6. `realMarketDataProvider` cannot work against any actual vendor
- **File:** `artifacts/api-server/src/lib/marketData/realProvider.ts:62-64`.
- **Evidence:** "Generic GET — concrete vendor mapping is intentionally not implemented here." It hits `${MARKET_DATA_BASE_URL}/quote?symbol=…` — a URL shape no real vendor (Polygon/OANDA/Deriv) serves — so configuring the env vars yields a fetch error and `lib/marketData/marketDataService.ts:84-95` silently falls back to the synthetic provider (logged at warn, result flagged `usedFallback`).
- **Classification:** STUB (safe scaffolding by design, but "Build DD real provider" configured with real credentials will never return real data).
- **Repair:** implement at least one concrete vendor mapping or rename/log so operators know configuration cannot activate real data.

### B7. `newsSentimentEngine` — deterministic mock sentiment (dead)
- **File:** `artifacts/api-server/src/lib/news/sentiment/newsSentimentEngine.ts:10-19`. "Placeholder. Returns deterministic mock sentiment" — score derived from the symbol's character codes. Labeled `source: "mock"`; grep shows **no importers**.
- **Classification:** STUB, dead code. **Repair:** delete or wire to the real sentiment path in `lib/assistant/marketProvider.ts`.

### B8. Deriv broker kind silently degrades to MockBrokerProvider (spec P0 venue)
- **File:** `artifacts/api-server/src/lib/broker/registry.ts:19-23` — `case "deriv": // No DerivProvider yet; fall back to mock`.
- **Evidence:** the spec ranks Deriv **P0** ("Best fit for ARX's initial four-symbol universe", spec §2 row 1). Selecting `BROKER_PROVIDER=deriv` yields `MockBrokerProvider`. Mitigation: the mock is rigorously honest (`lib/broker/mockProvider.ts:12-26`: `connected:false`, "All values … synthetic"), and the read-side Deriv market-data provider does exist (`lib/data/providers/derivProvider.ts`, gated by `DERIV_APP_ID`).
- **Classification:** STUB vs spec (execution adapter missing); honest at runtime.
- **Repair:** track as the spec's Deriv adapter work item; until then, make `selectBrokerKind` log a warning that "deriv" is not implemented rather than silently substituting mock.

### B9. Honest-by-design placement stubs (inventory — NOT bugs, listed to separate them from B1)
These always-reject stubs are deliberate, documented, and honest at the API level:
- `lib/liveTrading/guard.ts:85-105` — `placeLiveOrderGuarded` runs every check, then **always** appends/returns `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` (used by `routes/broker.ts:270-290`, which tells the caller "Order rejected as expected").
- `lib/selfTrade/selfTradeOrchestrator.ts:73, 124` — `ready` always false, `EXECUTION_NOT_IMPLEMENTED` sentinel.
- `lib/mt5/demoVerificationGate.ts:341` — "Broker dispatch is NOT implemented in this build … This is intentional (sub-phase 1+2)."
- `lib/adminTrading/orderGuard.ts:191` — gate keyed on `BROKER_PLACEMENT_LAYER_ENABLED` (enabled per May 2026 sign-off, `routes/meLive.ts:975-988` shows LIVE/DEMO hard-denied at the backup layer and routed to Phase B / demo queue instead).
The real live path is `lib/live/liveCommandPipeline.ts` (18-gate). No repair needed; see D2 for the stale-sentinel drift these create on reporting surfaces.

---

## C. Bridge-v2 contract gaps (task-specified check)

### C1. The "MISSING" endpoints exist — the contract doc is stale
- **Claim:** `mt5-bridge/ARX_AI_Bridge_v2_CONTRACT.md:331-332` marks `GET /api/bridge/v2/config` and `GET /api/bridge/v2/commands` "**MISSING — backend task**" (echoed in `mt5-bridge/ARX_AI_Bridge_v2_Beta_Kernel.mq5:506,536`).
- **Reality:** both are implemented and mounted:
  - `routes/bridgeV2.ts:92` `GET /bridge/v2/config` and `:118` `GET /bridge/v2/commands`, both behind `bridgeAuthPerUserOnly`;
  - service layer `lib/bridgeV2/egress.ts:47` (`loadBridgeV2ConfigForEa`, executionAllowed = stored flag AND server master switch) and `:137` (`listBridgeV2CommandsForEa`, pure read-projection of `SENT_TO_MT5_LIVE` rows);
  - mounted `routes/index.ts:202`; allowlisted for bridge auth `lib/auth/globalGate.ts:99-100`.
- **Contract compatibility verified:** the kernel parses `executionAllowed` with `JsonStr(resp,"executionAllowed") == "true"` (Beta_Kernel.mq5:520) and the server emits it as the string `"true"/"false"` (bridgeV2.ts:99-104) — compatible. The optional `commandWhitelist` field from the contract (CONTRACT.md:279) is not emitted; the kernel then keeps its hardcoded whitelist — safe.
- **Genuine remaining gaps (DEBT):**
  1. **No state-flip on poll / no result loop** — `lib/bridgeV2/egress.ts:135-136` and `routes/bridgeV2.ts:117`: commands stay `SENT_TO_MT5_LIVE` after being served; re-polls re-serve them and only the EA's idempotency cache prevents double-execution. "Deferred to the live-cycle task."
  2. **Lifecycle mapping partial** — CONTRACT.md:333: "only 3 mapped today — backend task."
- **Classification:** DEBT (stale contract doc — should be flipped to EXISTS; deferred state-flip is an accepted risk resting entirely on EA-side idempotency).
- **Repair:** update CONTRACT.md §6; implement the server-side state flip (`SENT_TO_MT5_LIVE → POLLED_BY_EA`) so exactly-once does not depend on a single client-side cache.

---

## D. DEBT

### D1. `GET /api/risk/audit` computes from a hardcoded $1000 balance
- **File:** `artifacts/api-server/src/routes/risk.ts:162-164` — "Use a placeholder account balance (1000 USD) — in production this comes from MT5 sync"; `const accountBalance = 1000;`. Position-size and loss-limit figures in the audit response are derived from a fake balance with no marker. **Repair:** read the per-user synced balance (`mt5_connection` account snapshot) or return `accountBalanceSource: "PLACEHOLDER_1000"`.

### D2. Stale `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` sentinel on reporting surfaces
- Phase B live dispatch **exists** and the master switch can be ON (`docs/SAFETY_NOTES.md:7-13`; `routes/adminLiveGatesDiagnostic.ts:181-182` reports the switch state), yet several read surfaces still hardcode the sentinel as current truth: `lib/assistant/tools.ts:786` (`placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED" as const` + tool description at `:1664` "placementLayer is always … today"), `routes/mt5.ts:698, 836, 867, 1478`, `routes/system.ts:130`. `lib/assistant/derivedEnvelope.ts:101` documents the drift ("this intentionally no longer cites BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED") but the tools payload still ships it. Fail-safe direction (understates capability) but makes Ruby/status surfaces lie about the platform's actual state. **Repair:** derive `placementLayer` from `resolveLiveBrokerExecutionEnabledAsync()` like `lib/bridgeV2/egress.ts:58` does.

### D3. Silent fail-open catches in the live dispatch preflight
- `lib/live/liveCommandPipeline.ts:736-738` (SL-typo/wrong-side guard: "Quote unavailable; defer…") and `:790-793` (broker-rule guard resolver: "Resolver failure must never block…") swallow errors **without logging**, silently disabling those advisory guards when the quote/spec path breaks. The 18-gate chain still runs, so this is fail-open only for advisory checks. Also bare `catch {}` in `lib/readiness/runner.ts:100,180`. **Repair:** add `logger.warn` in each catch so a dead quote provider is observable.

### D4. Legacy in-memory simulator surfaces still mounted alongside the real stack
- `routes/intelligence.ts`, `routes/brain.ts` (see B2), `routes/oms.ts` (in-memory OMS; `lib/oms.ts:445-459` `brokerReconStatus` returns `syncStatus: "DEFERRED"` — honest), `routes/marketDataLayer.ts` (SIMULATOR-tagged envelopes; seeded fake "FOMC Statement" / "Non-Farm Payrolls (placeholder)" news events, `lib/marketDataLayer.ts:176-198`, `source: "SIMULATED"`, served with `dataSource: "SIMULATOR"` at routes/marketDataLayer.ts:74 — honest but admin-only labeling). These predate the honest unified router (`lib/data/marketDataRouter.ts`) and remain reachable. **Repair:** retire or clearly namespace (`/api/sim/*`) the legacy Build-TT surfaces.

### D5. Frontend endpoints that 404 by design (tolerated)
- `artifacts/trading-dashboard/src/pages/testing-control-center.tsx:56` (`/api/onboarding/state`) and `:89` (`/api/ai-mentor/state`) — neither exists (server has `/api/onboarding/status`, routes/onboarding.ts:28, and `/api/mentor/*`, routes/aiMentor.ts:279-349). Both callers explicitly treat 404 as acceptable, so no user-visible failure — but the self-test suite is asserting against paths that were never implemented. **Repair:** point them at `/api/onboarding/status` and `/api/mentor/sessions/latest`.

### D6. `SESSION_SECRET` dev fallback + integrity-key placeholder mode
- `artifacts/api-server/src/app.ts:34` — cookie parser falls back to `"dev-fallback-secret-do-not-use-in-prod"` when `SESSION_SECRET` is unset. `lib/security/commandIntegrity.ts:95-104` separately drops the live-command HMAC chain into "CREATED (payload-hash-only) placeholder mode" without a secret. In an env with no SESSION_SECRET, sessions are signed with a public constant while command integrity silently downgrades. **Repair:** fail startup in production when `SESSION_SECRET` is missing (wire into `lib/startup/envChecklist.ts`).

### D7. PDF report format not implemented (honest)
- `lib/reportBuilder.ts:6` — "PDF is not implemented; HTML is the safe fallback." `REPORT_FORMATS` (:24) only offers json/csv/html, so nothing pretends. DEBT only if the UI advertises PDF.

### D8. Chart truth-score placeholder sub-metrics (honest, documented)
- `lib/data/chart/chartTruthScore.ts:115-116` (render_accuracy / scale_quality default 50, "Phase 2 placeholder") and `:351` (Interaction Stability). Explicitly excluded from worst-penalty selection (:365). Honest.

### D9. Timeframe-agreement "computing" placeholder (honest)
- `lib/data/chart/engines/timeframeAgreement.ts:9-10, 174-180` — first read returns an honest "computing" placeholder and kicks off a throttled refresh. By design.

---

## E. Marker-sweep coverage note

The grep sweep (`NOT_IMPLEMENTED|not implemented|TODO|FIXME|HACK|XXX|placeholder|coming soon|temporarily|stub`) over `artifacts/api-server/src` produced 177 non-test hits; all were triaged. The bulk fall into three benign families: (1) the intentional placement-stub sentinel family (B9/D2), (2) honest degraded-state copy ("temporarily unavailable" in `lib/marketScanner.ts:787,995`, `lib/assistant/tools.ts:2300-2369`, `routes/meChartSmartLayers.ts:262-271`, etc. — all fail-closed, none fabricate data), and (3) `routes/auth.ts:113,406` where "XXX" is just the `ARX-XXXX-XXXX-XXXX` key format. `lib/assistant/parseTradeCommand.ts:347` refuses unimplemented command types with an explicit message (honest). No unconditional-throw functions were found outside `realProvider.fetch`'s guarded not-configured throw (B6); no route imports a nonexistent module (all 244 route files resolve — a missing one would fail the TS build).

## F. Frontend 404 sweep method note

544 distinct `/api/...` literals in `artifacts/trading-dashboard/src` were extracted and matched against 1526 server route registrations (including the `/paper`, `/paper/demo-execution`, and `/me/investor` mount prefixes). After manual verification of all 122 raw mismatches (most were template-literal extraction artifacts), the surviving true 404s are exactly: A2 (`/api/readiness/me`), A3 (`/api/risk-settings` GET+PUT), and D5 (`/api/onboarding/state`, `/api/ai-mentor/state`, tolerated).

---

## Priority repair order

1. **A1** — mt5-webhook arbitrary-close + legacy shared-token auth (data corruption, safety-doc contradiction).
2. **B1** — execute-trade fake "LIVE trade executed" (spec: no silent fallback to simulated execution).
3. **A2** — one-line mount fix restores readiness + opportunity APIs and the dashboard card.
4. **A3** — risk-settings silent save failure.
5. **B2** — stamp demo macro backends as simulated (or retire `routes/intelligence.ts` + brain macro/news engines).
6. **B3/B4** — brokerReadOnly fake-positive; alert delivery no-ops.
7. **C1** — flip the bridge-v2 contract doc to EXISTS; implement command state-flip on poll.
8. **A4/D2** — retire the MT5_BRIDGE_TOKEN checklist guidance and the stale placement sentinel on reporting surfaces.
