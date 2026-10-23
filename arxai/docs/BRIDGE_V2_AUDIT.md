# ARX Bridge v2 — Phase 1 Current-Bridge Audit

This is the Phase 1 deliverable for Task #371. It maps the **current** (pre-v2)
bridge end-to-end and flags every place that relies on stale snapshots,
polling-as-truth, guessed order state, fake success, missing broker
confirmation, or phantom positions. Bridge v2 is an **upgrade on top of** this
infrastructure — nothing working is removed until its replacement is wired and
tested.

## 1. EA (`mt5-bridge/ARX_AI_Universal_Agent_v150.mq5`)

- **Transport:** WebRequest POST, auth header `X-MT5-Bridge-Token` (per-user
  token; legacy server-wide `MT5_BRIDGE_TOKEN` rejected on personal routes).
- **Messages sent (all polling/interval driven via `OnTimer`, 1s):**
  - `SendHeartbeat()` → `/api/mt5/heartbeat` (identity, balance/equity, eaInputs,
    capabilities, account snapshot).
  - `PushSnapshots()` → `/api/mt5/positions-snapshot`, `/api/mt5/pending-snapshot`.
  - `PostResultStruct()` → `/api/mt5/command-result` (legacy), plus demo/live
    result endpoints.
- **Trade events:** uses **neither** `OnTradeTransaction` nor `OnTrade` for
  backend reporting. Trade truth is *inferred from polled snapshots + command
  results* — the central gap Bridge v2 closes.
- **Idempotency:** ring buffer `seenCmdIds[256]` prevents re-executing a `cmdId`.
- **Sequence:** none. Relies on `createdAtEpoch` age checks (120s expiry).
- **Retry queue:** none persistent — a failed send is reported once.

## 2. Backend ingest endpoints

- `routes/mt5.ts`: `POST /mt5/heartbeat`, `GET /mt5/commands`,
  `POST /mt5/command-result` — all `bridgeAuthPerUserOnly`.
- `routes/mt5DemoBridge.ts`: `GET /mt5/demo-commands-poll`,
  `POST /mt5/demo-command-result`.
- `routes/mt5Live.ts`: `POST /mt5/live-commands-poll`,
  `POST /mt5/live-command-result`, `POST /mt5/positions-snapshot`,
  `POST /mt5/pending-snapshot`.
- **Auth:** `bridgeAuthPerUserOnly` hashes the presented token (SHA-256) and
  matches `mt5_connection.api_key_hash`; rejects the system-wide token.

## 3. Command queue & transport

- Commands drafted in `arx_live_commands` (live) / `mt5_demo_commands` (demo).
- EA polls `/mt5/live-commands-poll`; `pickupNextLiveCommand` claims the row
  (status → `SENT_TO_MT5_LIVE`). Result via `/mt5/live-command-result` →
  `recordLiveCommandResult` → status (`LIVE_FILLED`, …) + `recomputeMasterPool`.
- **Dispatch ≠ fill:** dispatch only sets `SENT_TO_MT5_LIVE`. A fill is real
  only when the EA POSTs a result carrying a broker ticket + retcode.

## 4. Remote config (`ea_remote_config`)

- Fields: `heartbeatPeriodSeconds`, `pollIntervalSeconds`,
  `snapshotPeriodSeconds`, `maxSpreadPoints`, `maxDeviationPoints`,
  `maintenanceMode`, `allowedCommandTypes`, … EA GETs `/api/mt5/remote-config`;
  backend `sanitiseRemoteConfig` before return.

## 5. Account / position / P&L truth

- `lib/live/liveAccountSnapshot.ts::buildLiveAccountSnapshot` is the pure adapter.
  Balance/equity from heartbeat; open P/L summed across `arx_live_positions`
  where `reconcileState` null; floating P/L prefers broker `floating_pl` when
  snapshot age ≤ 120s, else mark-to-market from fresh quotes (`plIsEstimate`).
- **Freshness:** `lastPositionsSnapshotAtMs` ("complete sweep landed" marker,
  stamped even for an empty book).
- **Reconciliation (Task #364):** two-pass row exclusion; equity−balance vs
  summed-PL invariant with `PL_RECONCILIATION_TOLERANCE_USD = 1.0` →
  `exceedsThreshold` surfaces "P/L under verification".

## 6. Reconciler (already dry-run)

- `lib/live/brokerAbsencePolicy.ts` / `brokerAbsenceReconcileRunner.ts`:
  requires 3 consecutive **reliable** absences + min absent age 120s; defaults
  to dry-run (`BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` gates writes). Decisions →
  `admin_action_audit_log` + `position_events`.
- `lib/live/positionFreshness.ts::classifyRow`: a stale `lastSyncedAt` never
  hides a position; a row is dropped only when the last sweep was reliable
  (≤30–90s) AND the row was absent from it.

## 7. Lifecycle states (today)

- `arx_live_commands`: `LIVE_DRAFT → LIVE_CONFIRMATION_REQUIRED → LIVE_APPROVED
  → SENT_TO_MT5_LIVE → LIVE_FILLED`; terminals `LIVE_REJECTED/FAILED/BLOCKED/
  CANCELLED/CLOSED/EXPIRED`. No unified cross-domain lifecycle vocabulary that
  also covers position open/partial/close — Bridge v2 adds one.

## 8. Candle / tick provider

- `lib/data/marketDataRouter.ts` chain `mt5_broker → deriv → assistant_real`.
- `lib/data/providers/mt5Provider.ts` in-memory, keyed `symbol|timeframe`,
  `CANDLE_TTL_MS = 5min`. `mt5_broker` slot **reserved but inactive** →
  `MT5_BROKER_FEED_NOT_ACTIVE`; today all tradable-symbol candles come from
  `assistant_real` (third-party), never the real broker feed.

## 9. UI + AI consumption seams (where v2 truth threads in)

- UI: `useLiveAccountSnapshotCtx` (SSE `/api/me/live/account-stream`),
  `useGetMeSharedAccountSummary`, `useTradingMode`; surfaces `CockpitCards.tsx`
  (`AccountSnapshotCard`, `masterReconciliation`), positions tables,
  `LiveModeBadge.tsx`.
- AI: Ruby `rubyContext.ts` (`account.snapshotFreshness`, `bridge.availability`);
  Flame `flameRead.ts::readExecutionQuality` (`bridgeConnected`,
  `heartbeatAgeSeconds`); governance `computeSurfaceGovernance`.
- Admin: `adminEaHealth.ts`, `adminReconciliationCenter.ts`, `adminEaUpdates.ts`.

## Flagged weaknesses Bridge v2 must address

1. **No event-driven trade truth** — trade state inferred from polled snapshots +
   command results; no `OnTradeTransaction`.
2. **No monotonic per-stream sequence numbers / gap detection** — transport
   relies on polling + TTL; a dropped/duplicated/reordered message is invisible.
3. **No formal message contract / schemas** for the bridge wire format.
4. **Composite-as-broker-native risk** — chart/scanner data for tradable symbols
   comes from `assistant_real`; `mt5_broker` is inactive and must stay
   non-contributing until verified real candles arrive.
5. **No unified lifecycle vocabulary** spanning command + position
   (queued/accepted/broker_received ≠ filled; partial ≠ full close).
6. **No bridge-event observability** (latency timestamps, gap/duplicate/retry/
   stale counters) surfaced to admin.

## Bridge v2 build approach (additive, safety-preserving)

- New `lib/domain/src/bridge-v2/` contract (12 message types), unified lifecycle
  state model + transition rules, pure sequence-gap detector, idempotency
  helpers — all unit-tested.
- New `bridge_v2_events` event-trace + per-stream sequence tracking in DB.
- New `/api/bridge/v2/*` ingest endpoints (reuse `bridgeAuthPerUserOnly`):
  validate, dedupe by idempotency key, track sequence + detect gaps, capture
  latency, write admin trace — never fake success.
- EA gains `OnTradeTransaction` event push (+`OnTrade` backup), per-message
  sequence + idempotency, local retry queue.
- Additive truth threading (freshness/lifecycle/provider-source) into Ruby,
  Flame, governance, admin health, `LiveModeBadge`.
- Broker-impacting commands keep routing through the existing instant-trade
  router → live command pipeline → 16-gate. Reconciler stays dry-run.
