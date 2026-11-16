# Deriv Audit — Spec §17 / Phase 2 / §10 Runtime Discovery vs. Existing Code

Auditor scope: existing Deriv code end to end — WS client, provider/config, symbol definitions (hardcoded vs runtime `active_symbols`), account/auth model, execution paths, synthetic universe handling, the `syntheticLiveFloor` safety contract, and Deriv-related CI tests. All paths are relative to the snapshot root:
`/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai`

Binding spec: `/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md` (cited as "spec"). Vision doc and encyclopedia cited where relevant.

**Spec-language conflict noted up front:** the spec declares "Core: Python 3.12, PostgreSQL" (spec:5) and a Python package layout (§5, spec:255–322). The codebase is a TypeScript pnpm monorepo (`artifacts/api-server`, `artifacts/trading-dashboard`, `lib/domain`, `lib/markets`, `lib/db`, `scripts`). Per instructions this audit evaluates the TypeScript equivalents; every spec requirement below is mapped onto TS modules, not `arx/brokers/...` Python files.

---

## 1. Current-state map

### 1.1 WebSocket client — `artifacts/api-server/src/lib/data/providers/derivWsClient.ts`

A lazy singleton (`getDerivWsClient()`, derivWsClient.ts:486–490) connecting to `wss://ws.derivws.com/websockets/v3?app_id=<id>` (derivWsClient.ts:20). It is **market-data only**. The complete set of Deriv API messages it can send:

| Message | Where | Purpose |
|---|---|---|
| `authorize` | derivWsClient.ts:155 | PAT auth after socket open; result only tracked for diagnostics |
| `active_symbols` (brief/basic) | derivWsClient.ts:244 (probe), :428 (warm-up) | **count only** — payload discarded |
| `ticks_history` (style: candles) | derivWsClient.ts:403–410 | historical OHLC, max 5000/request, optional `end` cursor |
| `ticks` + `subscribe:1` | derivWsClient.ts:456 | live tick stream per symbol |
| `ping` | derivWsClient.ts:302 | JSON keepalive every 30s |

There is **no** `buy`, `sell`, `proposal`, `proposal_open_contract`, `portfolio`, `contracts_for`, `transaction`, `balance`, or `forget` message anywhere in the client or the repo's API server (grep across `artifacts/api-server/src` returns zero trading-message hits; only prose matches for "authorize"). Note the header comment claims "tick subscription (forget on unsubscribe)" (derivWsClient.ts:6) but no `forget` call exists anywhere in the file — subscriptions are never released; they only die with the socket (`handleClose` clears local sets, derivWsClient.ts:306–318).

Mechanics that are solid and reusable:

- `req_id` correlation with 8s timeout (derivWsClient.ts:337–355), exponential reconnect backoff 1s→30s (derivWsClient.ts:320–330), bounded last-tick cache per symbol (derivWsClient.ts:56, 364–371).
- Eager warm-up on every (re)connect: `active_symbols` count + tick subscription for a persistent set seeded with `["R_25","R_75","1HZ25V","1HZ75V","BOOM1000","CRASH1000"]` (derivWsClient.ts:441); every symbol subscribed on demand is added to the persistent set so reconnects resubscribe (derivWsClient.ts:468–470).
- Secret hygiene: `configured()` reports booleans only (derivWsClient.ts:77–80); masked getters (derivWsClient.ts:273–284); error strings redact the app id (derivWsClient.ts:179, 183).

Auth/mode model:

- `detectMode()` (derivWsClient.ts:109–120): `DERIV_API_MODE` override, else heuristic — alphanumeric `DERIV_APP_ID` + token ⇒ "new", numeric app id ⇒ "legacy".
- In "new" mode the configured `DERIV_APP_ID` is **not used for the WS handshake at all**; the client connects with a public bootstrap app id `1089` (overridable via `DERIV_WS_LEGACY_APP_ID`) and authorizes with the PAT (derivWsClient.ts:199–205).
- `authorize` success/failure is recorded (`authorized`, `lastAuthorizeError`, derivWsClient.ts:155–169) but the authorize **response payload is discarded** — no `loginid`, no `is_virtual`, no currency, no landing company is captured. Warm-up runs regardless of authorize outcome because public synthetic data needs no auth (derivWsClient.ts:160–173).

### 1.2 Provider — `artifacts/api-server/src/lib/data/providers/derivProvider.ts`

- **Hardcoded 22-symbol map** `DERIV_SYNTHETIC_SYMBOLS` (derivProvider.ts:27–50): ARX label → Deriv WS id (e.g. `V75`→`R_75`, `V75_1S`→`1HZ75V`, `V25_1S`→`1HZ25V`, `V50_1S`→`1HZ50V`).
- Tolerant label resolution `resolveDerivSymbol` (derivProvider.ts:109–121); timeframe→granularity map (derivProvider.ts:128–144).
- Global feed status with readiness state machine `UNCONFIGURED | CONNECTING | AUTH_FAILED | CONNECTED_AWAITING_FEED | HISTORY_READY_AWAITING_LIVE_TICK | LIVE_FEED` (derivProvider.ts:171–189).
- **Per-symbol** feed status `getDerivSymbolFeedStatus` (derivProvider.ts:263–309): LIVE_FEED is gated on THIS symbol's own cached tick, never a sibling's — this is the Task #542 honesty fix, and it is the seam the live floor and all UI badges share.
- Candle/tick fetchers returning fail-closed envelopes, never fabricating data (derivProvider.ts:323–348, 356–373).

### 1.3 Keep-alive, boot, routes

- `derivKeepAlive.ts`: every 20s (concurrency 4, per-symbol 15s cooldown) it re-subscribes ticks and pulls 3 one-minute candles for **all 22 mapped symbols** (derivKeepAlive.ts:6–10, 28–41) — well beyond the four-symbol initial universe.
- Server boot eagerly starts the WS + keep-alive, non-blocking, gated on `DERIV_APP_ID` (artifacts/api-server/src/index.ts:173–187).
- User-facing routes (session-gated): `/market-data/deriv/status|symbols|ticks|candles` (artifacts/api-server/src/routes/marketDataDeriv.ts:24–61).
- Admin routes: `/admin/deriv-status` (+`/check`, `/probe`) with masked credentials, sanitized errors, blocker hints and setup instructions (artifacts/api-server/src/routes/adminDerivStatus.ts:39–96, 99–112, 117–134). Admin dashboard page exists (`artifacts/trading-dashboard/src/pages/admin/deriv-health.tsx`).

### 1.4 Where Deriv symbols are defined — hardcoded, in FIVE places

All Deriv ids are compile-time literals. The spec's §10 requirement — "discover the runtime symbol IDs through `active_symbols`; do not hard-code guessed IDs" (spec:751–757) — is unmet: the only two `active_symbols` calls throw away everything except `arr.length` (derivWsClient.ts:428–431 and :244–246).

1. `artifacts/api-server/src/lib/data/providers/derivProvider.ts:27–50` (22 symbols — the map actually used for WS data).
2. `lib/markets/src/universe.ts:318–360` (24 synthetics inside the ARX_TOP_250).
3. `lib/domain/src/market/arxFocusMarkets.ts:99+` (focus registry; `mt5Aliases` carry Deriv ids, e.g. arxFocusMarkets.ts:107, :118).
4. `artifacts/api-server/src/brain/symbols/symbolRegistry.ts:69–71` (`brokerSymbol: "R_75"`, `"1HZ75V"`, `"1HZ25V"`).
5. `artifacts/trading-dashboard/src/lib/symbolRegistry.ts` (frontend copy; deriv provider gating at :39, :97, :163).

**Concrete drift already exists between maps:** `derivProvider.ts:39` maps `BOOM500 → "BOOM500"` and `derivProvider.ts:42` maps `CRASH500 → "CRASH500"`, while `lib/markets/src/universe.ts:337` uses `"BOOM500N"` and `universe.ts:340` uses `"CRASH500N"` for the same markets. At most one set matches the venue; the other is a guessed id — precisely the failure mode spec §10 and the encyclopedia ("Symbol identifiers cannot be safely hard-coded", encyclopedia.md:2767; "The initial Deriv universe still requires runtime verification" — open gap, encyclopedia.md:2843) warn about. Nothing at runtime would catch it, because discovery results are never compared to any map.

Also: `arxFocusMarkets.ts:4` says the registry locks "exactly these 43 markets" while `arxFocusMarkets.ts:98` says "The 36 approved markets" — stale internal count.

### 1.5 The four-symbol initial universe

Vision doc: "Prove the complete loop in a contained initial universe: Volatility 25 1s, Volatility 75, Volatility 75 1s, and Volatility 50 1s" (vision.md:243). All four exist in every map (`V25_1S`/`1HZ25V`, `V75`/`R_75`, `V75_1S`/`1HZ75V`, `V50_1S`/`1HZ50V` — derivProvider.ts:31, 34, 35, 36), but **no config, flag, or registry isolates them as the Phase 2 universe**. The focus registry ships 36+ markets, the scanner universe 22 synthetics, and the keep-alive touches all 22. Two of the four (`1HZ50V` — V50_1S) are not even in the eager warm-up default set (derivWsClient.ts:441 has `1HZ25V`/`1HZ75V` but not `1HZ50V`; `R_75` covers V75).

### 1.6 Account / auth model — what exists

- Env-secret, single-owner, app-level: `DERIV_APP_ID`, `DERIV_API_TOKEN`, `DERIV_API_MODE`, `DERIV_WS_URL`, `DERIV_WS_LEGACY_APP_ID`. This matches the spec's "Personal-only deployment" allowance (spec §8:711–712).
- `DERIV_ACCOUNT_ID` is only ever presence-checked (derivWsClient.ts:286–288, adminDerivStatus.ts:48–49) — it selects nothing.
- `DERIV_ENVIRONMENT` ("demo"/"real") is declared in the broker-secrets catalog (artifacts/api-server/src/lib/broker/secrets.ts:26) and used nowhere else — there is **no demo/real distinction** anywhere in the Deriv path. On Deriv, demo vs real is a property of the account the token belongs to; the code never learns which it has because the authorize payload (`is_virtual`) is discarded (derivWsClient.ts:155–159).
- No per-user connections, no `broker_connections`/`broker_accounts`/`broker_instruments` tables (grep for `broker_connections|BrokerAdapter|broker_registry` across the repo: zero code hits), no credential vault, no OAuth.

### 1.7 Execution paths — Deriv has none; everything is MT5

- The generic broker seam `artifacts/api-server/src/lib/broker/` knows three kinds — `mt5 | deriv | mock` (secrets.ts:6–11) — but the registry maps `deriv` to **MockBrokerProvider** with the comment "No DerivProvider yet; fall back to mock with a clear note. … Deriv is left for a future session" (registry.ts:19–23). So `BROKER_PROVIDER=deriv` silently yields a mock provider (the mock self-identifies `simulated=true` in `.status()`, mockProvider.ts:22–23, but selection itself does not refuse). Spec §21 requires an explicit `NOT_IMPLEMENTED`/`ONBOARDING_REQUIRED` state for unimplemented brokers (spec:1244), and §1 bans silent fallback to mock/simulated execution (spec:24).
- Real execution is the MT5 EA bridge command queue (`arx_live_commands` + per-user/master EA polling; demo execution EA `mt5-bridge/ReplitMT5BridgeEA_DemoExec_v130.mq5` with double-arm inputs, DemoExec_v130.mq5:46–50). Synthetic-index execution is designed to route through a **Deriv MT5** account as CFD positions: `providerRoutingMap.ts:95–108` declares for asset class `synthetic` — `executionSource: "mt5_broker (per-user EA bridge)"`, data by Deriv id, execution by broker Market-Watch name resolved "only at the live boundary" (providerRoutingMap.ts:103–105).
- "Is the connected broker Deriv?" is decided by regex on the MT5 connection's broker name: `/deriv/i.test(mc[0]?.brokerName ?? "")` (liveCommandPipeline.ts:587 and again at :1494–1497).
- The dispatch chokepoint's own gate snapshot lists `"BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"` among block reasons (liveCommandPipeline.ts:1525) — the codebase itself records that no broker placement layer exists on this path.
- Conclusion: **spec §17's Deriv rules are untouched.** No separate REST setup vs WS trading split (spec:1037), no short-lived authenticated WS setup flow (spec:1038; an invented OTP endpoint was previously removed — derivWsClient.ts:291–295), no options/multipliers/accumulators modeling distinct from MT5 CFD positions (spec:1040), no account/instrument-specific commission handling (spec:1041).

### 1.8 `syntheticLiveFloor` safety contract — the strongest existing asset

`lib/domain/src/safety-contracts/syntheticLiveFloor.ts` (pure, no IO):

- Verdicts: `NOT_ENGAGED | ALLOWED | SYNTHETIC_FEED_NOT_LIVE_CONFIRMED | SYMBOL_NOT_LIVE_TRADABLE` (syntheticLiveFloor.ts:21–35).
- `ALLOWED` requires ALL of: owner-unrestricted profile, connected master broker is Deriv, broker truth does not block the symbol, and the per-symbol feed verdict is `LIVE` (syntheticLiveFloor.ts:59–77). Everyone else hits a permanent data-only floor.
- Consumed at BOTH live chokepoints so preflight and dispatch cannot drift: `createLiveDraft` preflight (liveCommandPipeline.ts:598–615, with brokerIsDeriv/brokerTruth/feedVerdict inputs built at :569–596) and `dispatchLiveCommand` re-check (liveCommandPipeline.ts:1507–1533).
- Feed verdict pipeline: `resolveSymbolFeedVerdictForSymbol` (symbolFeedVerdictForSymbol.ts:37–60) → `resolveSymbolFeedVerdict` (symbolFeedVerdict.ts:4–14), with the Deriv WS tick required only when Deriv is the winning provider (Task #776, symbolFeedVerdictForSymbol.ts:49–58); `brokerConfirmedFeed.ts:1–30` composes the same core for readiness surfaces.
- Broker truth blocks: `tradeAllowed === false || visible === false || tradeMode DISABLED/CLOSEONLY` from `getBrokerSymbolSpec` (liveCommandPipeline.ts:590–595; artifacts/api-server/src/lib/mt5/brokerSymbolSpec.ts:54).

This floor is a **tightening-only** contract for MT5-routed synthetics. It is NOT a Deriv-API execution gate — it presumes MT5 `OrderSend` is the final authority (syntheticLiveFloor.ts:16–17). A native Deriv adapter will need its own equivalent (and can reuse the same feed-verdict seam).

### 1.9 Deriv-related tests and CI wiring

Run in `pnpm run ci` (root package.json:15):

- `test:synthetic-live-floor-unit` → `scripts/src/syntheticLiveFloorUnitTest.ts` — DB-free; drives the real `getDerivSymbolFeedStatus` seam and the real floor contract; per-symbol CASE 8 iterates the entire `DERIV_SYNTHETIC_SYMBOLS` list so any new symbol is auto-covered or fails loudly (syntheticLiveFloorUnitTest.ts:1–29, 46–60).
- `test:fast-unit` (api-server package.json:111) includes `derivSymbolFeedStatus.test.ts` — 9 tests locking per-symbol honesty: sibling tick never promotes, global clock never promotes, stale tick never live, maxAgeMs honored, unknown symbol never live, unconfigured honest (derivSymbolFeedStatus.test.ts:58–132); plus the `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`-is-TECHNICAL vs `SYMBOL_NOT_LIVE_TRADABLE`-is-BROKER classification (:134–150). Also registered standalone as `test:deriv-symbol-feed` (api-server package.json:26).
- `ci:guards` (`scripts/src/ci/run-all.ts:47,110`) includes `check-synthetic-floor-prod-default-deny.ts` — locks the two refusals (QA_ALLOW_DB_MUTATION, QA_ALLOW_PROD_SMOKE) in the live-fire harness, comment-stripping the source so prose can't fake the guard (check-synthetic-floor-prod-default-deny.ts:1–50).
- `test:synthetic-stop-loss-tripwire`, `test:scalp-flame-synthetic-endpoint`, `test:broker-synthetic-feed` also touch synthetic paths (root package.json:15).

Manual/live QA (not in CI; DB/live-WS required): `test:deriv-warmup` (`qaDerivWarmup.ts` — asserts warm-up state machine against the live WS, never touches `arx_live_commands`, qaDerivWarmup.ts:1–26), `test:deriv-warmup-ui-verify`, `test:deriv-scanner-feed` (`qaDerivScannerFeed.ts:1–19`), `syntheticLiveFloorQa.ts` (live-fire, default-deny; scripts/package.json:62–64, 188–190).

**Coverage hole:** no test anywhere validates the hardcoded Deriv ids against `active_symbols` (can't — the payload is discarded), and no test cross-checks the five symbol maps against each other (which is why the BOOM500/BOOM500N drift survives).

---

## 2. Exact gap list to reach spec Phase 2 (Deriv demo execution)

Spec Phase 2 (spec:1176–1178): initial four-instrument runtime discovery; deterministic risk kernel integration; execution state machine/idempotency/events; demo orders, fills, exits and reconciliation; replay/shadow/mutation testing.

| # | Gap | Spec | Evidence of absence |
|---|---|---|---|
| G1 | **Runtime symbol discovery**: `active_symbols` payload parsed, retained, and used to resolve/verify the four initial ids; hardcoded maps verified against discovery; mismatch ⇒ refuse, not guess | §10:751–757, §17:1039, §9:737 | derivWsClient.ts:428–431 and :244–246 keep only `arr.length`; five literal maps (§1.4) |
| G2 | **Authenticated account identity**: capture authorize payload (loginid, `is_virtual`, currency, landing company, scopes); hard-require `is_virtual === true` for any Phase 2 execution; surface account identity in admin status | §17:1037–1038, §3.2:212–217, §9 | authorize response discarded (derivWsClient.ts:155–159); DERIV_ACCOUNT_ID presence-only (derivWsClient.ts:286–288); DERIV_ENVIRONMENT dead (secrets.ts:26) |
| G3 | **Deriv-native execution client**: `proposal` → `buy` (multipliers and/or rise-fall options), `sell`/close, `proposal_open_contract` stream, `portfolio`/`profit_table` reads — modeled as **contracts**, explicitly separate from MT5 CFD positions | §17:1040, Phase 2 | zero trading messages in repo (§1.7); registry.ts:19–23 mock fallback; liveCommandPipeline.ts:1525 `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` |
| G4 | **Adapter seam**: a `DerivBrokerProvider` implementing `lib/broker/types.ts` (TS equivalent of spec §6 `BrokerAdapter`), replacing the silent mock fallback with explicit `NOT_IMPLEMENTED` until certified | §6:424–439, §21:1244 | registry.ts:19–23 |
| G5 | **Instrument metadata discovery**: contract types available per symbol (`contracts_for`), min/max stake, multiplier ranges, precision — persisted with raw discovery evidence (TS equivalent of `broker_instruments`) | §10:749, §7:577–595 | no `contracts_for` call; no instruments table (grep §1.6) |
| G6 | **Idempotency/state machine for Deriv orders**: immutable intent → AUTHORIZED → SUBMITTING → ACKNOWLEDGED/UNKNOWN with `req_id`+passthrough echo as the client-order-id analogue; timeout ⇒ UNKNOWN, never resubmit | §12:865–885, §13 | existing arx_live_commands pipeline is MT5-EA-shaped (liveCommandPipeline.ts:1536+ master-bridge routing); no Deriv leg |
| G7 | **Deriv reconciliation**: `portfolio`/`profit_table`/`transaction` vs ARX state; mismatch ⇒ freeze new entries | §14:938–954 | reconcile modules are MT5-only (`brokerAbsenceReconcile.ts`, `check-reconciled-ghost-exposure.ts`) |
| G8 | **Four-symbol universe as explicit config**: a single Phase 2 allowlist (V25_1S, V50_1S, V75, V75_1S) gating discovery, subscription, and demo execution scope | Phase 2:1177, vision.md:243 | no such config (§1.5); keep-alive touches all 22 (derivKeepAlive.ts:28–41) |
| G9 | **Provenance binding**: ticks/candles carry source identity (broker, account, environment, delayed/snapshot flags); no silent mixing of MT5-bridge candles and Deriv-WS candles in one series | §10.1:771–807 | router returns a `provider` string only (marketDataRouter.ts:165–168, 309–342); `historySourceChain: ["mt5_broker","deriv"]` mixes two feeds for one synthetic series (providerRoutingMap.ts:100) with no account/environment identity |
| G10 | **Certification suite** for the Deriv adapter (auth expiry, unsupported-order rejection pre-network, cancel race, disconnect-before-ack ⇒ UNKNOWN, demo/live endpoint separation, rate-limit backoff without duplicates, red-fail mutation tests) | §16:1010–1032 | none exists |
| G11 | **Subscription lifecycle**: implement `forget`/`forget_all` so the client can honor a narrowed universe (currently subscriptions are add-only until socket death) | §16 stale/reconnect handling | derivWsClient.ts:6 claims forget; none implemented |

**Contract-type modeling note (spec §17:1040):** today "a synthetic trade" in ARX means an MT5 **CFD position** (volume/lots, SL/TP prices, netting per MT5) executed by EA `OrderSend`. Deriv-native demo execution means **contracts** (a multiplier contract has stake, multiplier, optional deal-cancellation; an option has stake/duration/barrier; both have a contract_id lifecycle, not a position ticket). These must be separate types end-to-end — risk sizing (`stake` is max loss for options; multiplier loss is stake-bounded), exposure math, and reconciliation all differ from lots-based CFD logic. Reusing `arx_live_commands` rows shaped around volume/SL/TP for Deriv contracts without a distinct contract model would violate the spec's "Model options/multipliers/accumulators separately from MT5 CFD positions."

---

## 3. Collisions and duplication risks

1. **Five parallel hardcoded symbol maps** (§1.4) with live drift: `BOOM500`/`CRASH500` (derivProvider.ts:39,42) vs `BOOM500N`/`CRASH500N` (universe.ts:337,340). Any Phase 2 discovery layer must become the single source and the other maps must be verified against it (or generated from it), or the drift count will grow.
2. **`lib/broker` seam vs live pipeline**: two unrelated "broker" abstractions exist — `lib/broker/registry.ts` (mock/mt5/deriv kinds, `BROKER_PROVIDER` env) and the mt5Connection/master-bridge model the live pipeline actually uses (liveCommandPipeline.ts:583–587). A Deriv adapter must pick one seam (recommend `lib/broker/types.ts`) and explicitly bridge or retire the other, else there will be two competing "which broker is connected?" answers. The current brokerIsDeriv regex on `mt5ConnectionTable.brokerName` (liveCommandPipeline.ts:587) is a third, informal answer.
3. **Silent mock fallback for `BROKER_PROVIDER=deriv`** (registry.ts:19–23) collides with spec §1 "no silent fallback … to mock" (spec:24) and §21 explicit-NOT_IMPLEMENTED (spec:1244). Low practical risk today (nothing execution-critical reads this registry for synthetics) but it is exactly the placeholder-adapter pattern the spec bans.
4. **"New mode" connects on public app id 1089, not the configured app id** (derivWsClient.ts:199–205). Fine for public market data; a trading build must submit orders under the owner's own registered app id and markup rules — this bootstrap shortcut cannot carry into the execution path. Admin setup copy also asserts app-id/token shapes ("alphanumeric app ID", "starts with pat_", adminDerivStatus.ts:88–94) that are heuristics, not venue guarantees (`detectMode` would misroute a numeric app id + token setup into legacy mode, derivWsClient.ts:116–118).
5. **Keep-alive vs four-symbol scope**: derivKeepAlive.ts:28–41 pins all 22 symbols every cycle; with no `forget` (G11) a narrowed Phase 2 universe cannot actually narrow the stream.
6. **Docs drift**: arxFocusMarkets.ts:4 ("43 markets") vs :98 ("36 approved markets"); derivWsClient.ts:6 ("forget on unsubscribe") vs no forget; adminDerivStatus.ts:49 references OTP account routing that was removed (derivWsClient.ts:291–295).
7. **Spec-vs-codebase language**: Python §5 layout vs TS monorepo (see preamble). Also spec §7 schema (broker_connections etc.) does not exist in `lib/db` — Phase 0/1 foundations are unbuilt; Phase 2 work must not invent a parallel one-off Deriv schema that later collides with the §7 canonical model.

---

## 4. Smallest dependency-ordered TS slices to Phase 2

Each slice is independently shippable, default-off, and tightening-only.

- **S1 — Discovery retention** (`artifacts/api-server/src/lib/data/providers/derivDiscovery.ts`): parse and retain the full `active_symbols` payload (symbol, display_name, market, submarket, pip, exchange_is_open) in the WS client instead of `arr.length` (change derivWsClient.ts:428–431); expose `getDiscoveredSymbol(derivId)` and `verifyKnownSymbols(DERIV_SYNTHETIC_SYMBOLS)`; admin endpoint reports the diff. No behavior change to any consumer.
- **S2 — Symbol-map consistency guard** (`scripts/src/ci/check-deriv-symbol-map-consistency.ts`): static cross-check of the five maps (§1.4). **Fails red today** on BOOM500/CRASH500 — proving the guard works, then fix the wrong side after verifying against S1 discovery output on the real account.
- **S3 — Account identity**: capture the authorize response (loginid, `is_virtual`, currency, landing_company, scopes) into the client state; surface in `/admin/deriv-status`; add `derivAccountIsVirtual()` used by later slices. Depends on nothing but S0-level edits to derivWsClient.ts:155–159.
- **S4 — Four-symbol Phase 2 universe config** (`lib/domain/src/market/derivPhase2Universe.ts`): the explicit allowlist `["V25_1S","V50_1S","V75","V75_1S"]`, consumed by warm-up defaults (derivWsClient.ts:441), keep-alive (derivKeepAlive.ts:28), and every later execution slice. Add `forget` support (G11) so narrowing is real.
- **S5 — Contract capability discovery**: `contracts_for` per Phase 2 symbol; persist min/max stake, multiplier ranges, durations with raw evidence (TS `broker_instruments` equivalent in `lib/db`). Depends on S1, S3.
- **S6 — `derivTradeClient.ts` (demo-only)**: `proposal` → `buy` for multipliers, `sell`, `proposal_open_contract` subscription; distinct `DerivContractIntent`/`DerivContractState` types (never MT5 volume/SL/TP shapes); gated on (a) new env flag `ARX_DERIV_DEMO_EXECUTION_ENABLED` default-false, (b) `is_virtual === true` (S3), (c) the four-symbol allowlist (S4), (d) discovery-verified id (S1); `passthrough`+`req_id` echo as idempotency key; timeout ⇒ UNKNOWN, no resubmit. Depends on S1, S3, S4, S5.
- **S7 — Adapter + registry honesty**: `DerivBrokerProvider` implementing `lib/broker/types.ts` over S6, and replace the mock fallback (registry.ts:19–23) with an explicit `NOT_IMPLEMENTED`-status provider until S6 certifies. Reconcile the two broker seams (collision #2).
- **S8 — Deriv reconciliation**: `portfolio` + `profit_table` poll vs local contract state; mismatch ⇒ freeze new Deriv entries (reuse the freeze semantics the MT5 path already has). Depends on S6.
- **S9 — Risk-kernel + floor integration**: route Deriv contract intents through the existing gate order (kill switches → allowlist → per-symbol feed verdict via the SAME `getDerivSymbolFeedStatus` seam → stake caps), adding a contract-aware analogue of `evaluateSyntheticLiveFloor` in `lib/domain/src/safety-contracts/`. Depends on S6; reuses §1.8 assets.

---

## 5. Red-fail tests (each must fail before its slice lands, pass after)

1. **Discovery verification red-fail**: stub the WS `active_symbols` response with `R_75` renamed → `verifyKnownSymbols` must return a mismatch and the provider must refuse candles for the unverified id (asserts G1; guards against silent guessed-id routing). Fails today: discovery keeps only a count (derivWsClient.ts:428–431).
2. **Map-consistency guard**: S2 cross-check — fails red on today's BOOM500/CRASH500 drift (derivProvider.ts:39,42 vs universe.ts:337,340).
3. **Virtual-account gate**: authorize stub with `is_virtual:false` (or missing) ⇒ `derivTradeClient` refuses `buy` with `DERIV_REAL_ACCOUNT_BLOCKED` before any network send. Fails today: no such check exists (derivWsClient.ts:155–159 discards the payload).
4. **Default-off execution flag**: with `ARX_DERIV_DEMO_EXECUTION_ENABLED` unset, any `buy` attempt returns a blocked envelope and sends nothing — mirror of `check-live-broker-execution-defaults.ts` (scripts/src/ci/check-live-broker-execution-defaults.ts:1–25) for the Deriv path.
5. **Universe containment**: `buy` for any symbol outside the four-symbol allowlist (e.g. `BOOM1000`) is refused pre-network even though the symbol is subscribed for data.
6. **Disconnect-before-ack ⇒ UNKNOWN**: kill the fake transport between `buy` send and response ⇒ state must be UNKNOWN + reconciliation enqueued, and a retry with the same idempotency key must NOT produce a second `buy` frame (spec §12:883, §16:1023).
7. **No CFD/contract type bleed**: type-level + runtime test that a `DerivContractIntent` cannot be constructed from an MT5 command row (no volume/lots field accepted; stake required) — pins spec §17:1040 separation.
8. **Mock-fallback removal**: `BROKER_PROVIDER=deriv` must yield a provider whose `.status()` reports `NOT_IMPLEMENTED` (until certification), never `simulated=true` mock. Fails today (registry.ts:19–23).
9. **Forget honors narrowing**: after S4/G11, narrowing the universe must emit `forget` for dropped streams; assert the subscription set shrinks (fails today — no forget exists).
10. **Existing floor regressions stay wired**: keep `test:synthetic-live-floor-unit`, `test:fast-unit` (deriv per-symbol honesty) and `check-synthetic-floor-prod-default-deny` green and in `pnpm run ci` (root package.json:15; run-all.ts:110) — the Deriv-native path must consume the same per-symbol seam (memory note `.agents/memory/deriv-per-symbol-feed-verdict.md` documents why).

---

## 6. What is genuinely good and must be preserved

- Fail-closed, never-fabricate data envelopes everywhere (derivWsClient.ts:11–16; derivProvider.ts:11–15, 344–347).
- Secret hygiene discipline across client, provider, routes (derivWsClient.ts:273–284; adminDerivStatus.ts:29–37; marketDataDeriv.ts:3–5).
- The per-symbol feed-honesty seam and its test lock (derivProvider.ts:263–309; derivSymbolFeedStatus.test.ts) — this is exactly the "market-data freshness and source quality" check the spec's risk kernel wants (spec §11:844) and should be the liveness input for Deriv-native execution.
- The pure, dual-chokepoint `syntheticLiveFloor` contract pattern (syntheticLiveFloor.ts; liveCommandPipeline.ts:598, 1507) — the right template for every new Deriv gate.
- The CI-guard culture (run-all.ts; comment-stripped source guards) — extend it, don't bypass it.
