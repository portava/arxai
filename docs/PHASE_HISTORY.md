# ARX AI — Phase History (Archive)

Completed phase notes moved out of `replit.md` for readability. **Nothing here
has been deleted or rewritten** — these are the original phase blocks copied
verbatim, in chronological order. The current active phase lives in
[`../replit.md`](../replit.md).

Each block records the changes shipped, files touched, verification suites
run, and the safety invariants re-asserted at the end of that phase. The
later phases supersede the earlier ones, but the historical record is kept
intact so any past decision can be audited.

---

## ARX AI Live Assistant (Phase 13)

The in-app help widget was upgraded from a menu-driven knowledge browser to
a live, natural assistant.

- Backend: `artifacts/api-server/src/routes/meAssistant.ts` (SSE streaming
  text + voice) + `artifacts/api-server/src/lib/assistant/{tools.ts,
  systemPrompt.ts, marketProvider.ts, featureMap.ts}`. 15 user-scoped tools.
  All persistence in `arx_assistant_conversations`, `arx_assistant_messages`,
  `arx_assistant_tool_calls` (FK to `users.id`, scoped on every query).
- Frontend: `artifacts/trading-dashboard/src/components/help/ArxAssistantLivePanel.tsx`
  replaces the old `FloatingHelpWidget` mount in `AppLayout.tsx`. Live token
  streaming via fetch + ReadableStream. Voice mode uses `useVoiceStream`
  (gpt-audio speech-to-speech) — mic only after explicit user permission.
- Provider: OpenAI through Replit AI Integrations (no local API key needed).
  Replit's proxy does not currently support WebRTC Realtime; the assistant
  uses gpt-audio speech-to-speech as a degraded voice mode. To upgrade to
  true Realtime later, swap to your own `OPENAI_API_KEY` and a Realtime
  WebRTC client in `lib/integrations-openai-ai-react`.
- Market data: pluggable adapter in `lib/assistant/marketProvider.ts`. Until
  one of `FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `POLYGON_API_KEY`, or
  `NEWSAPI_API_KEY` is set, market tools return `connected:false` and the
  assistant says "live market data is not connected" — never fabricates.
- Safety: every response carries `{safetyMode:"paper_only", liveLocked:true,
  readOnlyMode:true, allowOrderExecution:false}`. The assistant cannot place
  trades, modify connections, or read another user's data. Secrets
  (`MT5_BRIDGE_TOKEN`, `apiKeyHash`, `SESSION_SECRET`, raw bridge tokens)
  are never returned by any tool. 11/11 CI guards green.

## Phase 22O — Live Market Data for the Scanner

The assistant's market scanner is now wired to **real OHLC candles** instead
of the simulator. Provider routing is hybrid and deterministic:

- **TwelveData** (`TWELVEDATA_API_KEY`) — primary candle source for the live
  scanner. Real M1..D1 OHLC across forex/crypto/stocks. Free tier: 800/day,
  8/min. **Required for `getMarketScannerOpportunities` to return anything.**
- **Finnhub** (`FINNHUB_API_KEY`) — when also set, takes over quotes + news
  (its free tier supports company-news; TwelveData's free tier does not).
  Free-tier candle endpoints are 403 and not used.
- Polygon / AlphaVantage — adapters exist but stubbed (no live candles).
- **MT5** is *not* a candle source. Audit confirmed zero candle/OHLC
  capability (no schema, endpoint, Zod body, or broker method). It will
  become the primary source only when an EA pushes OHLC into a new
  `mt5_candles` table; until then the scanner does not depend on MT5 at all.

Files:
- `artifacts/api-server/src/lib/assistant/marketProvider.ts` — `Candle` /
  `CandleResult` types, `MarketProvider.getCandles()`, real
  `twelveDataProvider`, `hybridTwelveDataFinnhub` composer, `withCandleCache`
  wrapper (60s TTL + in-flight Promise dedupe — keeps a full scan under the
  TwelveData free-tier budget even when called repeatedly).
- `artifacts/api-server/src/lib/assistant/liveScanner.ts` — deterministic
  scoring of REAL candles into ranked candidates with bias / trend /
  volatility / spread / confidence / RR / badge / label. Uses M15 + H1.
  **Skips silently when a provider returns no/insufficient candles —
  never substitutes simulator data.**
- `artifacts/api-server/src/lib/assistant/tools.ts` —
  `getMarketScannerOpportunities` is async; returns real candidates tagged
  with `dataSource = <provider>` when `liveDataConnected && features.candles`,
  otherwise returns `opportunities: []` with an honest `safetyNote`.

Verified end-to-end via the assistant SSE endpoint: returns real GBPUSD M15
(bear, conf 80) and EURUSD H1 (bear, conf 79) tagged "from 30 real candles",
with valid entry/SL/TP. 11/11 CI guards green; safety envelope unchanged
(`paper_only`, `liveLocked:true`, `readOnlyMode:true`); no secrets exposed.

## Phase 28-MT5-VPS-fix — Unified per-user bridge token contract

The MT5 EA and backend now use **one** token model end-to-end. All EA-facing
endpoints (`/api/mt5/heartbeat`, `/api/mt5/sync-account`,
`/api/mt5/sync-positions`, `/api/mt5/commands`, `/api/mt5/command-result`,
`/api/mt5/execution-result`, `/api/mt5/sync-positions-per-user`) are guarded by
`bridgeAuthPerUserOnly` in `artifacts/api-server/src/routes/mt5.ts`. The system
`MT5_BRIDGE_TOKEN` env value is **rejected** on every EA endpoint — only
per-user tokens issued from the ARX MT5 Setup page (`POST
/api/me/mt5-connections`) are accepted. Server stores SHA-256 hashes only;
raw tokens are shown exactly once at creation and never re-served.

EA package (`mt5-bridge/ReplitMT5BridgeEA.mq5`, v1.22; mirrored in
`mt5-bridge-export/`): single `BridgeToken` input now labeled "Paste the
per-user bridge token from ARX MT5 Setup". 401 explanation and init Alert
updated to point at per-user regeneration. MT5 Setup page card + reveal
dialog read "Per-user bridge token — paste into MT5 EA Inputs → BridgeToken"
with warning "Do not screenshot or share this token." Bridge package docs
(README_SETUP, SECURITY_NOTES, TROUBLESHOOTING, BRIDGE_TESTING_CHECKLIST)
synced to describe the per-user model and the new
`SYSTEM_TOKEN_ON_PERSONAL_ENDPOINT` rejection reason.

Verified by `scripts/src/mt5BridgeTokenContractTest.ts` (13/13 PASS):
heartbeat + commands both accept valid per-user token, both reject invalid,
revoked, and the system `MT5_BRIDGE_TOKEN` env value; `/api/mt5/bridge-diagnostics`
never returns token values; safety envelope intact (`liveLocked=true`,
`liveExecutionEnabled=false`, `brokerPlacementImplemented=false`,
`readOnlyGuardActive=true`). Typecheck and 12/12 CI guards green.

## Phase 28-MT5-OPS — Bridge Operations Hardening + Paper Beta Gate

Adds operational visibility, duplicate-EA detection, broker-snapshot
freshness, and a single READY/NOT-READY gate for paper beta testing.

- `artifacts/api-server/src/routes/mt5.ts` — `bridgeDiag` now tracks
  `lastBrokerSnapshotAt`, `brokerSnapshotStatus`, and a bounded
  `recentAccepted[]` ring (5-min window, 25-item cap). `detectDuplicateEa()`
  flags ≥2 distinct IPs/accounts within 5 min (observation only, never
  unlocks anything). Heartbeat success block emits `DUPLICATE_EA_SUSPECTED`
  audit when detected. `GET /api/mt5/bridge-diagnostics` extended with
  `brokerSnapshotStatus`, `lastBrokerSnapshotAt`, `brokerSnapshotFresh`,
  `duplicateEaSuspected`, `duplicateEaReason`, `distinctAcceptedIpsLast5m`,
  `distinctAcceptedAccountsLast5m`, `commandExecutionAllowed:false`.
- `GET /api/mt5/bridge-ops-monitor` (NEW) — operations rollup served by
  pure in-process builder `buildBridgeOpsRollup(role)`. Operator-only
  identifiers (`lastAcceptedRemoteIp`, `lastAcceptedAccount`) are
  REDACTED for non-OWNER/ADMIN requesters. Audits
  `BRIDGE_OPS_MONITOR_VIEWED` on every read and `BRIDGE_HEARTBEAT_STALE`
  when the heartbeat is older than the freshness threshold.
- `GET /api/me/paper-beta-readiness` (NEW,
  `artifacts/api-server/src/routes/mePaperBetaReadiness.ts`) — the gate.
  `requireUser`. Calls `buildBridgeOpsRollup()` **in-process** (no
  internal HTTP fetch — SSRF/cookie-forwarding via attacker-influenced
  Host headers is impossible). Runs 7 checks:
  1. **bridge_read_only_stable** (PASS/WARN/FAIL) — decoupled from the
     legacy `MT5_BRIDGE_TOKEN` env presence; trusts heartbeat freshness
     + `commandExecutionAllowed === false`. Duplicate-EA = WARN, not
     FAIL.
  2. **safety_envelope_intact** (PASS/FAIL) — runtime envelope assert.
  3. **command_queue_force_blocked** (PASS/FAIL) — per-user
     `mt5_commands` scan; any PENDING / DELIVERED / claimed / sent /
     executed is a FAIL.
  4. **per_user_isolation** (INFO) — architectural invariant verified
     by 12/12 CI guards at build time.
  5. **paper_flow_available** (INFO) — endpoint registration verified
     by CI router guard.
  6. **no_secret_leakage** (PASS/FAIL) — runtime regex sniff of the
     rollup we will return against env-secret values, raw `arx_*` token
     shapes, and `apiKeyHash` hex strings.
  7. **live_execution_blocked** (PASS/FAIL) — runtime assertion that
     `allowOrderExecution`, `allowModification`, `allowClose`,
     `commandExecutionAllowed`, `brokerPlacementImplemented` are all
     false.
  Records `PAPER_BETA_GATE_RUN` + `PAPER_BETA_GATE_PASSED/FAILED` audits.
  Returns `{status, headline, blockers, checks, bridgeSummary,
  safetyEnvelope, alertLanguage}`. Only FAIL blocks readiness.

Verified Phase 28-MT5-OPS end-to-end against the live connected VPS
(account 106929717, IP 194.156.229.238):
- Typecheck across all 4 workspace packages: green.
- 12/12 CI guards: green.
- 13/13 token contract tests: green.
- 4 forbidden command endpoints (`queue-command`, `close`, `modify`,
  `close-all`): all return 403 NOT_ARMED_FOR_LIVE.
- `queue-command` persists REJECTED with `NOT_ARMED_FOR_LIVE`.
- Per-user isolation holds (user B sees 0 of user A's paper trades).
- Bridge-ops-monitor served with `requesterScope` field; non-OWNER/ADMIN
  prod sessions see `lastAcceptedRemoteIp:"REDACTED"` and
  `lastAcceptedAccount:"REDACTED"`.
- Paper-beta-readiness returns READY with 5 PASS + 2 INFO + 0 FAIL.
- AI assistant answered "is my bridge connected", "can you place a
  trade", "is there a duplicate EA", "am I ready for paper beta" with
  honest "not connected / cannot place / readiness false" answers and
  `liveLocked:true readOnlyMode:true allowOrderExecution:false` envelope
  on every reply.
- Secret leak scan on all three new surfaces: NONE.

Hard safety invariants preserved: live execution remains locked, no MT5
command was sent, no auto-close, no shared routing, no token value ever
returned by any endpoint, simulator data never substituted for missing
real market data, per-user token contract unchanged.

## Phase 28-MT5-DEMO-FOUNDATION — Demo execution gate (read-only foundation)

Adds the **safest possible foundation** for future MT5 demo execution. This
phase builds ONLY the gate and contracts; it does NOT implement
OrderSend/Modify/Close, does NOT arm execution, and does NOT weaken any
existing live-locked invariant. Live=BLOCKED, shared MT5 routing=BLOCKED,
auto-close=ALERT_ONLY, MT5 commands=force-BLOCKED remain unchanged.

- `lib/domain/src/safety-contracts/executionMode.ts` (NEW) — 4-state
  enum `ExecutionMode = PAPER | MT5_DEMO_READ_ONLY | MT5_DEMO_EXECUTION |
  LIVE_LOCKED`. Constant `EXECUTION_PATHS_BUILT = false` for this phase.
  `canArmExecution()` always returns `false` while paths are not built.
  `buildSafetyGateSnapshot()` returns the canonical envelope used by the
  gate response. Exposed via `@workspace/domain/safety-contracts/executionMode`.
- `artifacts/api-server/src/lib/mt5/demoVerificationGate.ts` (NEW) —
  `runDemoVerificationGate({userId, duplicateEaProbe})` runs 7 checks and
  returns `{status: VERIFIED_DEMO | NOT_READY, headline, blockers, checks,
  evidence, safetyGateSnapshot, canArmExecution:false, canArmExecutionReason,
  executionMode:"PAPER"}`. The checks are:
  1. **user_owns_bridge** — per-user `mt5_connection` row exists (PASS/FAIL).
  2. **account_type_explicit_demo** — EA-reported `accountType ∈ {demo,contest}`
     (PASS) or anything else (FAIL). Server **never infers demo from
     server_name alone**.
  3. **supporting_evidence_server_name** — informational only (INFO/PASS),
     not used for arming.
  4. **no_duplicate_ea** — uses bridge-ops duplicate probe (PASS/WARN).
  5. **safety_envelope_intact** — runtime assertion that liveLocked=true,
     allowOrderExecution=false, readOnlyMode=true (PASS/FAIL).
  6. **execution_paths_built** — always INFO and always reports `false` in
     this build.
- `artifacts/api-server/src/routes/meDemoExecutionReadiness.ts` (NEW) —
  `GET /api/me/demo-execution-readiness` (`requireUser`). Calls the gate
  **in-process** (no internal HTTP fetch — same SSRF-safe pattern used by
  `/api/me/paper-beta-readiness`). Records `DEMO_VERIFICATION_GATE_RUN` +
  `DEMO_VERIFICATION_GATE_PASSED/FAILED` audit events. Returns the gate
  result verbatim — no tokens, hashes, IPs, account numbers, or env secrets.
- `artifacts/api-server/src/routes/mt5.ts` — accountType parser now accepts
  `"contest"` in addition to `"demo"` and `"live"`; `getDuplicateEaProbe()`
  exported for in-process consumption by the gate.
- EA package `mt5-bridge/ReplitMT5BridgeEA.mq5` + `mt5-bridge-export/` bumped
  to **v1.25**: heartbeat now sends an explicit `accountType` field derived
  from `ACCOUNT_TRADE_MODE` (`demo` | `contest` | `live` | `unknown`) plus
  `eaVersion`. If `ACCOUNT_TRADE_MODE` cannot be read, the EA reports
  `"unknown"` and the gate fails the explicit-demo check. The EA does NOT
  send OrderSend/Modify/Close in this build.
- `artifacts/trading-dashboard/src/pages/mt5-setup.tsx` — new
  **Demo Execution Readiness** card polls `/api/me/demo-execution-readiness`
  every 10s. Read-only — no Arm button. Card explicitly displays
  `executionPathsBuilt=false` and `canArmExecution=false`.

Verified end-to-end:
- Typecheck (4 packages): green.
- 12/12 CI guards: green.
- 13/13 token contract: green (unchanged).
- 11/11 demo verification gate (`scripts/src/demoVerificationGateTest.ts`,
  `pnpm --filter @workspace/scripts run test:demo-verify`): T1 anonymous→401,
  T2 authed-no-bridge→`NOT_READY` with `NO_BRIDGE_CONNECTION` +
  `ACCOUNT_TYPE_NOT_REPORTED`, T3 response shape, T4 `canArmExecution===false`,
  T5 no secret leakage, T6 envelope intact, T7 gate ran, T8 (×4) all forbidden
  command endpoints (`queue-command`, `close`, `modify`, `close-all`) still
  return 403 `NOT_ARMED_FOR_LIVE`.
- Live VPS observation (account 106929717, server MetaQuotes-Demo, current
  EA v<1.25 still attached, DB `account_type='unknown'`): gate would return
  `NOT_READY` with `ACCOUNT_TYPE_NOT_REPORTED` even though `server_name`
  matches a demo pattern — demonstrating the gate refuses to infer demo
  from server_name alone. After the operator redeploys EA v1.25 on the
  VPS, the heartbeat will report `accountType=demo` and only then the
  explicit-demo check will PASS.

Hard safety invariants preserved (re-verified after this phase):
`liveLocked=true`, `allowOrderExecution=false`, `commandExecutionAllowed=false`,
`brokerPlacementImplemented=false`, `executionPathsBuilt=false`,
`autoCloseMode=ALERT_ONLY`, `sharedMt5RoutingBlocked=true`. Legacy
`MT5_BRIDGE_TOKEN` env value still rejected on every EA endpoint. Per-user
isolation unchanged. No new token, hash, IP, account number, or env secret
is ever returned by the new endpoint.

## Phase 28-MT5-DEMO-ARMING — Per-user demo arming state machine + command queue (sub-phases 1+2)

Adds the **structural foundation** for per-user demo trade execution: an
explicit arming state machine and a per-user demo command queue with full
lifecycle transitions. This phase **wires the queue, not the consumer**.
Live trading remains BLOCKED. Shared MT5 routing remains BLOCKED. Auto-close
remains ALERT_ONLY. EA OrderSend / Modify / Close code does **not** exist
yet — that is sub-phase 3 (EA v1.26). The system **cannot** dispatch any
command to MT5 in this build under any code path.

- `lib/domain/src/safety-contracts/executionMode.ts` — split
  `EXECUTION_PATHS_BUILT` into two flags: `DEMO_ARMING_BUILT=true` and
  `BROKER_DISPATCH_BUILT=false`. New types: `DemoCommandType`
  (`PLACE_MARKET_ORDER` | `MODIFY_ORDER` | `CLOSE_POSITION` |
  `CLOSE_ALL_DEMO`), `DemoCommandStatus` (`DEMO_DRAFT` | `DEMO_APPROVED` |
  `SENT_TO_MT5_DEMO` | `MT5_DEMO_FILLED` | `MT5_DEMO_REJECTED` |
  `DEMO_CANCELLED` | `DEMO_FAILED`), and the explicit transition table
  `DEMO_COMMAND_TRANSITIONS` enforced by `isValidDemoCommandTransition()`.
  `canDispatchToMt5()` always returns `{allowed:false, reason:
  "BROKER_DISPATCH_NOT_BUILT"}` regardless of arming state — this is the
  inviolable structural guard for this phase. `canArmExecution()` now
  returns `{allowed:true}` only when the verification gate returns
  `VERIFIED_DEMO`. `buildSafetyGateSnapshot()` accepts a `userArmed`
  parameter so the envelope reflects per-user state without weakening
  `liveLocked`.
- `lib/db/src/schema/mt5DemoExecution.ts` (NEW) — two tables pushed to
  Postgres:
  - `mt5_user_execution_mode` (unique per user) — current arming state,
    `armedAt`, `disarmedAt`, `disarmedReason`, `lastTransitionActor`.
  - `mt5_demo_commands` — queue rows with `commandType`, `status`,
    `payload` (jsonb), `transitions` (jsonb log), `draftedAt`,
    `approvedAt`, `cancelledAt`, `failureReason`. Indexed by
    `(userId, status)`.
- `artifacts/api-server/src/lib/mt5/demoArmingService.ts` (NEW) —
  `armDemoExecution()` calls the verification gate in-process and refuses
  with `DEMO_NOT_VERIFIED` (with the gate's blockers concatenated) when
  the user is not VERIFIED_DEMO. `disarmDemoExecution()`,
  `getCurrentArmState()`, `isArmedForDemo()`. Every transition records a
  `DEMO_EXECUTION_ARMED` / `DEMO_EXECUTION_DISARMED` /
  `DEMO_EXECUTION_ARM_DENIED` audit event with `actorIp` and
  `actorUserAgent`.
- `artifacts/api-server/src/lib/mt5/demoCommandQueue.ts` (NEW) — pure
  lifecycle: `createDraftCommand()` refuses if user is not armed
  (`NOT_ARMED_FOR_DEMO_EXECUTION`), `confirmDraft()` transitions
  `DEMO_DRAFT → DEMO_APPROVED`, `cancelDraft()` transitions to
  `DEMO_CANCELLED`. `dispatchApprovedCommand()` exists for symmetry but
  unconditionally returns `{ok:false, reason:
  "BROKER_DISPATCH_NOT_BUILT"}` and never writes `SENT_TO_MT5_DEMO`.
  Audits `DEMO_COMMAND_DRAFTED` / `DEMO_COMMAND_APPROVED` /
  `DEMO_COMMAND_CANCELLED`.
- `artifacts/api-server/src/routes/meDemoExecution.ts` (NEW) — `requireUser`-
  guarded `GET /api/me/demo-execution/status`, `POST .../arm`, `POST .../disarm`.
- `artifacts/api-server/src/routes/meDemoCommands.ts` (NEW) — `requireUser`-
  guarded `GET /api/me/demo-commands`, `POST /api/me/demo-commands` (draft),
  `POST /api/me/demo-commands/:id/confirm`, `POST /api/me/demo-commands/:id/cancel`,
  `GET /api/me/demo-commands/:id`. Every response carries
  `canDispatchToMt5:false` + `canDispatchToMt5Reason`.
- `artifacts/api-server/src/lib/mt5/demoVerificationGate.ts` — extended to
  expose `demoArmingBuilt:true`, `brokerDispatchBuilt:false`,
  `canDispatchToMt5Allowed:false`, `canArmExecutionAllowed`, plus a new
  `broker_dispatch_built` INFO check that always reports `false`.
- `artifacts/trading-dashboard/src/pages/mt5-setup.tsx` — new
  **Demo Execution Control** card directly under the existing
  Readiness card. Polls `/api/me/demo-execution/status` every 10s. Arm
  button enabled only when `canArmExecution===true`. Disarm always
  available when armed. The card explicitly displays
  `canDispatchToMt5: false` with the refusal reason and the dispatch
  refusal text, plus a persistent amber warning that no MT5 command can
  be sent in this build.

Verified Phase 28-MT5-DEMO-ARMING:
- Typecheck (4 packages): green.
- 12/12 CI guards: green (unchanged).
- 11/11 demo verification gate (`test:demo-verify`): green; new
  `demo_arming_built` + `broker_dispatch_built` checks reported correctly;
  4 forbidden MT5 live endpoints still 403 NOT_ARMED_FOR_LIVE.
- 18/18 demo arming integration test
  (`pnpm --filter @workspace/scripts run test:demo-arming`): all 5 new
  endpoints reject anonymous, status returns `MT5_DEMO_READ_ONLY` for a
  no-bridge user, arm refused with `DEMO_NOT_VERIFIED — NO_BRIDGE_CONNECTION;
  ACCOUNT_TYPE_NOT_REPORTED`, draft refused with
  `NOT_ARMED_FOR_DEMO_EXECUTION`, all 4 forbidden live endpoints still
  return 403, `canDispatchToMt5===false` on every response, no secret
  leakage, safety envelope intact (`liveLocked=true brokerDispatchBuilt=false
  sharedMt5RoutingBlocked=true autoCloseMode=ALERT_ONLY`), per-user
  isolation holds (new user B sees 0 commands).

Hard safety invariants preserved (re-verified after this phase):
`liveLocked=true`, `allowOrderExecution=false`, `commandExecutionAllowed=false`,
`brokerPlacementImplemented=false`, `brokerDispatchBuilt=false`,
`canDispatchToMt5Allowed=false`, `autoCloseMode=ALERT_ONLY`,
`sharedMt5RoutingBlocked=true`. Legacy `MT5_BRIDGE_TOKEN` still rejected on
every EA endpoint. Per-user isolation unchanged. No new token, hash, IP,
account number, or env-secret value is returned by any new endpoint.
**No row in `mt5_demo_commands` can transition to `SENT_TO_MT5_DEMO` in
this build** — `dispatchApprovedCommand()` refuses unconditionally and
the EA has no demo OrderSend code.

Next: sub-phase 3 — EA v1.26 demo OrderSend consumer that polls
`/api/me/demo-commands?status=DEMO_APPROVED` for *its own* per-user
account, executes only when `ACCOUNT_TRADE_MODE` reports DEMO at send
time, and writes back a fill or rejection. **(Completed in sub-phase 3B;
see current `replit.md` for the active sub-phase 3D notes.)**

---

## Phase 28-MT5-DEMO-ARMING — sub-phase 3D + EA v1.26 clarity patch

**EA v1.26 clarity patch (May 2026)** — EA source files
(`mt5-bridge/ReplitMT5BridgeEA.mq5` and the mirrored
`mt5-bridge-export/ReplitMT5BridgeEA.mq5`):

- Removed stale `v1.21 JSON_BODY_FIX` init banner and stale
  "This v1 EA still refuses execution" warning. Init now prints a single
  structured snapshot: `ReplitUrl present`, `BridgeToken length` (value
  never printed), `AccountType`, `AccountInfo trade mode`, `ReadOnlyMode`,
  `EnableDemoExecution`, legacy `AllowOrderExecution`, `EA version=1.26`.
- OnInit emits one of two accurate `Alert()` messages:
  `v1.26 ready for DEMO execution` when all four gates pass
  (ACCOUNT_TRADE_MODE_DEMO + ReadOnlyMode=false + EnableDemoExecution=true
  + token length ≥8), or a single multi-line `v1.26 will NOT execute demo
  orders until ALL of: …` listing every failing input.
- Heartbeat JSON now includes `readOnlyMode`, `enableDemoExecution`, and
  `allowOrderExecution` booleans. Server reads them in
  `routes/mt5.ts` heartbeat handler and stores them under
  `mt5_connection.capabilities.eaInputs` (no schema migration). The
  existing `read_only_mode` column is mirrored from
  `eaInputs.readOnlyMode`. **Live safety flags
  (`allow_order_execution`, `live_locked`) are NEVER mutated from
  heartbeat input.**
- Demo Bridge Debug endpoint (`GET /api/me/demo-bridge-debug`) now:
  - Returns `bridge.eaInputs.{readOnlyMode, enableDemoExecution,
    reportedAt}` from the EA heartbeat capabilities sidecar.
  - Returns `allBridgeConnections[]` listing every non-revoked bridge row
    for the user, with `isActive`, `heartbeatAgeSeconds`, `tokenLast4`.
  - Returns `sameAccountStaleBridgeCount` so the UI can warn about
    leftover registrations for the same MT5 account.
  - Runs `expireStaleSentCommands({olderThanMs: 120_000})` on every read,
    transitioning `SENT_TO_MT5_DEMO` rows older than 2 minutes →
    `FAILED` with reason `EXPIRED_DEMO_NO_EA_PICKUP_2MIN`. Audited per
    row as `DEMO_COMMAND_CANCELLED`. Returned as `staleExpiredCommandIds`.
- New helper `expireStaleSentCommands()` lives in
  `artifacts/api-server/src/lib/mt5/demoCommandQueue.ts`. Only acts on
  `SENT_TO_MT5_DEMO → FAILED` (already in the transition table).

Safety unchanged: `liveLocked=true`, `allowOrderExecution=false`,
`commandExecutionAllowed=false`, `brokerPlacementImplemented=false`,
`sharedMt5RoutingBlocked=true`, `autoCloseMode=ALERT_ONLY`.
Build: typecheck green; `pnpm run ci:guards` 12/12; `test:demo-verify`
13/13; `test:demo-arming` 18/18.

---

## Phase 28-MT5-DEMO-ARMING — sub-phase 3D (live)

End-to-end per-user demo bridge execution flow. Live trading remains
locked; this phase only exercises the demo path.

**What's wired**

- **Active demo bridge selector** — `createDraftCommand()` and the dispatch
  consumer both use `evaluatePerUserDispatchGate()` to pick the *active*
  bridge: heartbeat fresh (≤15s), `accountType=demo`, `eaVersion≥1.26`,
  not revoked. If no active bridge, draft creation refuses cleanly with
  `NO_ACTIVE_DEMO_BRIDGE:<reasons>` and no row is written.
- **Atomic rebind at SENT_TO_MT5_DEMO** — `consumeApprovedCommand()`
  rewrites `bridge_connection_id` to the gate's current active bridge id
  at the moment of dispatch, so EA reconnects (new `mt5_connection` row)
  do not orphan in-flight commands.
- **Orphan cleanup** — `cancelOrphanedSentCommands()` transitions
  `DRAFT/USER_CONFIRMATION_REQUIRED/DEMO_APPROVED` → `BLOCKED` and
  `SENT_TO_MT5_DEMO` → `FAILED` (both legal per `DEMO_COMMAND_TRANSITIONS`)
  when their bound bridge id ≠ current active. Surfaced via
  `POST /api/me/demo-commands/cancel-orphaned`.
- **Demo Bridge Debug card** — polls `GET /api/me/demo-bridge-debug`
  every few seconds. Reports `pickupable`, `orphaned`, `earlyOrphaned`,
  `totalOrphanedAnyState`, last DEMO_POLL_SERVED, last terminal outcome
  using canonical statuses (`REJECTED`, `FILLED_DEMO`, `FAILED`, `BLOCKED`).
- **Structured dispatch log** — every `SENT_TO_MT5_DEMO` write emits a
  pino line with `commandId`, `userId`, `commandType`,
  `previousBridgeConnectionId`, `assignedBridgeConnectionId`,
  `activeBridgeConnectionId`, `bridgeRebound`, `pickupable`, `orphaned`,
  `accountTypeReported`, `heartbeatAgeSeconds`, `reportedEaVersion`.
- **EA v1.26** — heartbeat reports `accountType` from
  `ACCOUNT_TRADE_MODE`, plus `eaVersion`. Polls
  `/api/mt5/demo-commands-poll` for its own per-user account, executes
  only when `ACCOUNT_TRADE_MODE = DEMO`, writes back a fill or REJECTED
  reason (`REJECTED_READ_ONLY_MODE_ACTIVE`,
  `REJECTED_DEMO_EXECUTION_DISABLED`, broker retcodes, etc.).

**What is NOT wired (intentional)**

- Live `OrderSend/Modify/Close` from server to MT5. Routed through the
  hard `canDispatchToMt5()` chokepoint; `LIVE_LOCKED` is permanent.
  (Superseded by Phase B — see active `replit.md`.)
- Shared MT5 routing. Every command is per-user-bound.
- Server-side EnableDemoExecution / ReadOnlyMode reporting. The EA does
  not currently send these toggle states in heartbeat — the server only
  learns about them indirectly via the EA's REJECTED reason code. This
  is acceptable because the EA is the authority on its own input state.
  (Superseded by EA v1.26 clarity patch above.)

### Current build status (sub-phase 3D)

- Typecheck (all 4 workspace packages): green
- `pnpm run ci:guards` — **12/12 PASS**
- `test:demo-verify` — **13/13 PASS**
- `test:demo-arming` — **18/18 PASS**
- `mt5BridgeTokenContractTest` — **13/13 PASS**
- End-to-end demo dispatch (script `scripts/src/runDemoOrderEndToEnd.ts`)
  against live VPS account 106929717 (bridge id 231, EA v1.26,
  `accountType=demo`):
  - draft → DEMO_APPROVED → SENT_TO_MT5_DEMO → REJECTED in 2–4s
  - bound to active bridge 231 (pickupable=true, orphaned=false)
  - broker reason: `REJECTED_READ_ONLY_MODE_ACTIVE` — EA-side input
    `ReadOnlyMode=true` still active; flip to `false` in MT5 EA Inputs
    to test a fill round-trip

### Active QA checklist (sub-phase 3D)

1. Bridge connectivity — heartbeat age ≤15s, `accountType=demo`,
   `ea_version=1.26`, exactly one EA attached per account
2. Per-user isolation — user B never sees user A's `mt5_demo_commands`,
   `mt5_connection`, or audit events
3. Forbidden live endpoints — `queue-command`, `close`, `modify`,
   `close-all` all return **403 NOT_ARMED_FOR_LIVE**
4. Safety envelope on every demo response — `liveLocked=true`,
   `allowOrderExecution=false`, `readOnlyMode=true`,
   `sharedMt5RoutingBlocked=true`, `autoCloseMode="ALERT_ONLY"`
5. No secret leak on any new endpoint — regex sniff against env values,
   `arx_*` token shapes, `apiKeyHash` hex
6. Demo dispatch happy path — fresh command bound to current active
   bridge, `pickupable=1 orphaned=0`, EA pulls within 2–4s, result
   recorded with canonical status (`FILLED_DEMO` / `REJECTED` / `FAILED`)
7. Demo dispatch refusal — no active bridge or stale heartbeat ⇒
   `NO_ACTIVE_DEMO_BRIDGE:<reasons>`, no row inserted

### Known issues / blockers (sub-phase 3D)

- **EA does not report `EnableDemoExecution` / `ReadOnlyMode` in
  heartbeat.** Server cannot pre-validate these toggles before dispatch
  — it only learns about them via the REJECTED reason. (Resolved in EA
  v1.26 clarity patch above.)
- **User 4 has 3 historical `mt5_connection` rows** (184, 224, 231) for
  the same account, none revoked. The fixed selector correctly picks
  231 (active). Stale rows are harmless but cluttered — consider a
  periodic revoke-on-replace sweep.

---

## MT5 Bridge Integration (pre-Phase-B notes)

Historical note from when the production code path was demo-only. Live
broker execution is now handled by Phase B (see active `replit.md`).
Kept for audit trail.

1. `POST /api/mt5-webhook` accepts trade open/close events from an EA or Python bridge
2. `POST /api/execute-trade` is the entry point for sending orders to MT5
3. Replace mock execution in `trades.ts` with your bridge HTTP client
4. Flip `BROKER_DISPATCH_BUILT` and `LIVE_LOCKED` only after the safety
   review, CI guards, and per-user dispatch gate are extended to the
   live path. **Do not relax `liveLocked` outside that review.**
