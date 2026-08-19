# ARX AI — Execution State Machine / Orchestrator / Reconciliation Audit

**Auditor scope:** spec §4 (service architecture rules), §6 (canonical domain model), §12 (execution state machine), §13 (orchestrator), §14 (reconciliation), §7 tables `execution_intents` / `broker_orders` / `execution_events` / `reconciliation_runs` / `trading_control_state`.
**Spec:** `/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md` (1,244 lines).
**Codebase root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai` (all code paths below are relative to this root).
**Read-only audit. No code was modified.**

## 0. Language conflict noted up front

The spec declares "Core: Python 3.12" (spec line 5) and gives a Python package layout (§5, spec lines 255–322). The codebase is TypeScript end-to-end (Fastify/Express-style api-server + Drizzle ORM + Postgres). Per task instructions, everything below is evaluated against the TypeScript equivalents. The spec's *semantic* requirements (state machine shape, table shapes, orchestration rules) are treated as binding; the Python packaging is not.

---

## 1. Reuse map — what already satisfies each spec section

### 1.1 §6 canonical domain model → three existing state machines

The spec's single 14-value `OrderState` enum (spec lines 368–382) is currently implemented as **three parallel state machines**:

| Spec concept | Existing implementation | Evidence |
|---|---|---|
| `OrderState` (14 values incl. `unknown`, `reconciliation_required`) | **Live:** 11-value `ARX_LIVE_COMMAND_STATUSES` (`LIVE_DRAFT`, `LIVE_CONFIRMATION_REQUIRED`, `LIVE_APPROVED`, `SENT_TO_MT5_LIVE`, `LIVE_FILLED`, `LIVE_REJECTED`, `LIVE_FAILED`, `LIVE_BLOCKED`, `LIVE_CANCELLED`, `LIVE_CLOSED`, `LIVE_EXPIRED`) | `lib/db/src/schema/arxLiveExecution.ts:20-37` |
| | **Demo:** 8-value `DemoCommandStatus` (`DRAFT`, `USER_CONFIRMATION_REQUIRED`, `DEMO_APPROVED`, `SENT_TO_MT5_DEMO`, `FILLED_DEMO`, `REJECTED`, `BLOCKED`, `FAILED`) | `lib/domain/src/safety-contracts/executionMode.ts:93-112` |
| | **Legacy transport:** free-text `mt5_commands.status` (`PENDING|DELIVERED|claimed|sent|completed|failed|expired|cancelled` + legacy variants) | `lib/db/src/schema/mt5Commands.ts:21` |
| Transition table (spec §12) | `ALLOWED_TRANSITIONS` (live) with `assertCanTransition` throwing on illegal moves | `artifacts/api-server/src/lib/live/liveCommandPipeline.ts:94-103`, `1160-1164` |
| | `DEMO_COMMAND_TRANSITIONS` + `isValidDemoCommandTransition` (demo) | `lib/domain/src/safety-contracts/executionMode.ts:114-130` |
| `ExecutionMode` manual/automated | Partially: `ExecutionMode` here means PAPER/DEMO/LIVE_LOCKED surface, not manual-vs-automated (`executionMode.ts:31-35`). Automated attribution exists via `selfTradeAgentId`/`selfTradeDecisionId` columns (`arxLiveExecution.ts:153-154`) and agent-ownership payload (`liveCommandPipeline.ts:244-252`) | see refs |
| `TradeIntent` immutability | Approximated by AACI command-integrity: `payloadHash` stamped at draft, HMAC `integrityHash` re-verified at dispatch — any change to trade-critical params between confirm and dispatch is a tamper block | `arxLiveExecution.ts:156-185`; verifier consulted at `liveCommandPipeline.ts:1220-1257` |

### 1.2 §7 tables → existing tables

| Spec table | Closest existing artifact | Match quality |
|---|---|---|
| `execution_intents` | `arx_live_commands` (`lib/db/src/schema/arxLiveExecution.ts:87-212`) and `mt5_demo_commands` (`lib/db/src/schema/mt5DemoExecution.ts:35-95`) | Partial. Carries commandType/symbol/side/volume/SL/TP, confirmation timestamps, gate snapshot, actor provenance (`actorId`/`actorType` `arxLiveExecution.ts:182-183`). **Not immutable** — the same row mutates through the whole lifecycle. No workspace/assignment columns. |
| `broker_orders` | Merged into the same rows: `brokerTicket`, `fillPrice`, `executedVolume`, `mt5Retcode`, `brokerMessage` (`arxLiveExecution.ts:113-116, 104`); demo: `brokerOrderId`, `brokerTicket`, `fillPrice`, `fillVolume`, `brokerRawResult` (`mt5DemoExecution.ts:54-58`) | Partial. No separate ack record, no `client_order_id` unique separate from intent, no `terminal_at` distinct from status. |
| `execution_events` (append-only, `unique(intent_id, sequence_no)`, spec lines 668–679) | `live_trading_audit` (append-only, `lib/db/src/schema/liveTrading.ts:80-108`) + `security_events` (`lib/db/src/schema/security.ts:42`) + tamper-evident mirror (`mirrorCriticalEvent`, `liveCommandPipeline.ts:2735-2742`) | **Weak.** Audit rows exist for most transitions, but there is no per-intent sequence number, no uniqueness per (intent, seq), and no retention of out-of-order broker payloads (see gap G3). |
| `reconciliation_runs` (spec lines 681–691) | **None.** The Reconciliation Center computes issues on the fly with deterministic ids and deliberately does not persist runs: "without persisting issues to a new table" (`artifacts/api-server/src/lib/reconciliation/detect.ts:1-5`) | Missing (gap G5). |
| `trading_control_state` singleton (spec lines 693–702) | Split across: `live_trading_state` singleton with fail-closed defaults `killSwitchActive=true`, `emergencyStopActive=true` (`lib/db/src/schema/liveTrading.ts:17-40`); `global_trading_settings` (`accountRoutingMode`, `liveBrokerExecutionArmed`; `lib/db/src/schema/adminTrading.ts:25`); env var `ARX_LIVE_BROKER_EXECUTION_ENABLED`. Reconciled by AND-logic in `resolveLiveBrokerExecutionEnabled` (`artifacts/api-server/src/lib/live/phaseBConfig.ts:54-72`) | Good spirit (default OFF everywhere), fragmented shape (collision C4). |
| `allocation_reservations` (spec lines 564–575) | `arx_dispatch_exposure_reservations` + advisory-locked `reserveExposureAtomic` / `releaseReservation` / `fulfillReservation` (`artifacts/api-server/src/lib/concurrency/exposureReservation.ts:1-80+`) | Good analogue for the shared-master pool. Not per-assignment (no workspaces). |

### 1.3 §12 state machine mechanics → existing

- **Transactional transitions + CAS:** demo `transitionTo` supports compare-and-swap `WHERE id=? AND status=?` with `RACE_LOST` on 0 rows (`artifacts/api-server/src/lib/mt5/demoCommandQueue.ts:290-323`). Demo dispatch is a conditional `UPDATE ... WHERE status='DEMO_APPROVED'` inside a transaction that also writes attribution atomically (`artifacts/api-server/src/lib/mt5/demoCommandConsumer.ts:322-384`). Live result recording is first-write-wins CAS on `status='SENT_TO_MT5_LIVE'` (`liveCommandPipeline.ts:2708-2730`). Live TTL sweep is CAS-guarded by status (`liveCommandPipeline.ts:2301-2308`). **This is genuinely strong, reusable machinery.**
- **Exactly-once EA pickup:** atomic claim with `pickedByEaAt IS NULL` guard + bridge-binding (`liveCommandPipeline.ts:2349-2393`).
- **Bridge-binding on result write:** only the dispatched bridge may post the result (`liveCommandPipeline.ts:2621-2623`).
- **Duplicate result handling:** terminal rows acknowledge duplicates without re-applying (`liveCommandPipeline.ts:2629-2645`); demo reconciler is idempotent on re-delivery of the same terminal state (`artifacts/api-server/src/lib/mt5/demoCommandReconciler.ts:80-82`).
- **TTL:** `LIVE_COMMAND_TTL_SECONDS=60` + `computeLiveExpiry`/`isLiveCommandStale` pure helpers (`liveCommandPipeline.ts:110-145`); EA-side `STALE_COMMAND_REJECTED` maps to `LIVE_EXPIRED` (`liveCommandPipeline.ts:2649-2650`).
- **Honesty rule on fills:** `mapBridgedLiveOutcome` refuses to fabricate a fill without a broker ticket (`liveCommandPipeline.ts:2574-2589`) — but see gap G1b for the failure-mode cost.

### 1.4 §13 orchestrator → `dispatchLiveCommand`

`dispatchLiveCommand` (`liveCommandPipeline.ts:1198-2277`) is the de-facto orchestrator and already implements most of the spec's ordering:

1. Replay/double-dispatch refusal on non-APPROVED state (`1201-1212`)
2. Command integrity pre-gate, default-deny (`1220-1257`)
3. Operator allocation-freeze pre-gate; close/modify exempted from entry-freeze (`1259-1309`)
4. Pilot cohort gate (`1311-1356`)
5. ARX-focus market backstop + data-sufficiency + synthetic floor, entry-only, TOCTOU re-checks (`1415-1534`)
6. Master-routing user-access + master-bridge gates (`1536-1617`)
7. MOCK-bridge short-circuit — no silent live→mock fallback (`1643-1674`)
8. Per-user exposure gates counting open positions **plus in-flight SENT commands** to close the TOCTOU window (`1747-1847`)
9. Activation gate re-check (`1849-1886`)
10. 18-gate `evaluateLivePhaseBDispatchGate` pure evaluator (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts:117-250`), master switch default-false (`:20`), sentinel `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` appended when off (`:239-241`)
11. Atomic master exposure reservation before SENT (`2008-2081`)
12. Idempotency-keyed SENT_TO_MT5_LIVE write, DB partial-unique enforced (`2083-2111`, index at `arxLiveExecution.ts:209-211`)
13. Fail-closed transport mirror into `mt5_commands` with reservation release on failure (`2135-2219`)

Demo equivalent: `consumeApprovedCommand` with the `canDispatchToMt5` chokepoint (`demoCommandConsumer.ts:97-505`; chokepoint contract `executionMode.ts:245-265`).

**Spec deltas in the orchestrator:** intents are not `create_once`-immutable; a lost/unknown submission does not produce `UNKNOWN` + `reconciler.enqueue_urgent` (spec lines 929–932); manual confirmation is a status (`LIVE_CONFIRMATION_REQUIRED`) rather than a server-side challenge bound to the immutable intent (spec line 1006) — though the integrity hash partially provides the "changing params invalidates it" property.

### 1.5 §14 reconciliation → existing (fragmented)

| Spec requirement | Existing | Evidence |
|---|---|---|
| Compare broker truth vs ARX | Reconciliation Center: 10 read-only detectors (BRIDGE_MISMATCH, ORPHAN_BROKER_POSITION, MISSING_ATTRIBUTION, COMMAND_RESULT_MISMATCH, …) | `artifacts/api-server/src/lib/reconciliation/detect.ts:29-52` |
| Resolve only from broker-authoritative identifiers, never manufacture orders | Broker-absence guardrail: N consecutive reliable complete sweeps + min age before stamping `RECONCILED_BROKER_ABSENT`; pure evidence engine | `artifacts/api-server/src/lib/live/brokerAbsenceReconcile.ts:39-65`; evidence columns `arxLiveExecution.ts:256-274` |
| Apply EA-reported results | `reconcileExecutionResult` (legacy mt5_commands/trade_action_requests path) — terminal-monotonic, enrich-only on late fields, user-scoped ticket lookups | `artifacts/api-server/src/lib/mt5/executionReconciler.ts:95-467` |
| | `reconcileBrokerResult` (demo) — CAS, owned-only, terminal-idempotent | `demoCommandReconciler.ts:74-185` |
| | `recordLiveCommandResult` (live) — CAS + ghost-close stamping from broker truth | `liveCommandPipeline.ts:2591-2845`, ghost close `2773-2829`, pure matcher `155-168` |
| Stuck/stale sweeps | `stuckCommandWatchdog` (5 min, legacy mailbox), demo `expireStaleSentCommands` (2 min), live `sweepExpiredLiveCommands` (60 s TTL) | `artifacts/api-server/src/lib/mt5/stuckCommandWatchdog.ts:16-50`; `demoCommandQueue.ts:611-674`; `liveCommandPipeline.ts:2289-2330` |
| Canonical mismatch vocabulary | 8-value `CanonicalReconciliationStatus` incl. fail-closed mapping of unknown → `RECONCILIATION_BLOCKED` | `lib/domain/src/safety-contracts/reconciliation.ts:10-19, 55+` |

**Missing:** scheduled authoritative polls as an execution-safety gate, persisted runs, freshness requirement at dispatch, automatic freeze on mismatch (gaps G5, G6).

### 1.6 §4 architecture rules — compliance scorecard

- "API requests never place orders from controllers" — **holds**: routes go through draft→confirm→dispatch pipelines; the only broker writers are the EA mailboxes.
- "Broker acknowledgements are not treated as fills" — **partially holds**: `mapBridgedLiveOutcome` requires a broker ticket for `LIVE_FILLED` (`liveCommandPipeline.ts:2585-2588`), but there is no ACKNOWLEDGED stage at all (gap G2).
- "Lost acknowledgement produces UNKNOWN, not automatic duplicate retry" — **half holds**: nothing auto-retries (good), but the lost-ack outcome is a *presumed* terminal (`LIVE_EXPIRED`/`failed`), not `UNKNOWN` (gap G1).
- "No silent fallback live→demo/mock" — **holds**: MOCK short-circuit (`liveCommandPipeline.ts:1643-1674`); demo and live tables are physically separate (`liveCommandPipeline.ts:9-11`).
- "Default OFF" — **holds**: env AND DB-arm both required (`phaseBConfig.ts:54-72`); Phase A gate is a CI-pinned always-false (`lib/domain/src/safety-contracts/liveDispatchGate.ts:1-14`); fail-closed singleton defaults (`liveTrading.ts:20-22`).

---

## 2. Collisions and duplication risks

**C1 — Three command tables, and every live order gets TWO lifecycle rows.** The authoritative live row (`arx_live_commands`) is mirrored into the legacy `mt5_commands` mailbox for the v1.50 EA (`enqueueBridgedMt5Command`, `liveCommandPipeline.ts:2512-2552`; rationale block `2406-2424`). Two state machines now describe one order. The mirror row is swept by `stuckCommandWatchdog` at **5 minutes** to `failed` (`stuckCommandWatchdog.ts:16, 42-50`) while the authoritative row is swept at **60 seconds** to `LIVE_EXPIRED` (`liveCommandPipeline.ts:110, 2289-2330`) — divergent terminal states and reasons for the same order are structurally guaranteed whenever the EA doesn't respond. Spec §7 has a single `execution_intents` + `broker_orders` pair. Any new-broker work that clones the mirror pattern doubles this debt per venue.

**C2 — Two position tables with two writers.** `live_positions` is written by the legacy `executionReconciler` (`executionReconciler.ts:271-353, 469-516`) while `arx_live_positions` is written by `recordLiveCommandResult` + snapshot sync + broker-absence guardrail (`arxLiveExecution.ts:217-278`). A bridged live command's EA result flows through the `mt5_commands` result endpoint, which contains both the legacy reconciler path and the live-bridge forwarding branch — position truth for one fill exists (or fails to exist) in two places with different schemas (`brokerPositionId` vs `brokerTicket` keying).

**C3 — Three reconciliation vocabularies and five reconciler-ish modules.** `executionReconciler` (apply EA callback), `demoCommandReconciler` (demo write-back), `recordLiveCommandResult` (live write-back), Reconciliation Center `detect.ts` (drift detection), `brokerAbsenceReconcile*` (position-close truth). None is the spec-§14 authoritative periodic poll, and their statuses (`ExecutionResultStatus`, `BrokerReportedStatus`, `CanonicalReconciliationStatus`, `ReconciliationIssueType`) overlap without a mapping layer except the one in `lib/domain/src/safety-contracts/reconciliation.ts:55+`.

**C4 — Master-switch truth split three ways** (env var, `global_trading_settings.liveBrokerExecutionArmed`, `live_trading_state` singleton). AND-composed correctly today (`phaseBConfig.ts:54-72`), but spec's single `trading_control_state` should absorb these; adding brokers multiplies the read sites.

**C5 — Duplicate-suppression implemented three different ways.** Demo: payload fingerprint + 10 s window scan + partial unique index (`demoDispatchDuplicate.ts:18, 47-55`; `mt5DemoExecution.ts:92-94`). Live: minute-bucket SHA idempotency key + partial unique index over `('SENT_TO_MT5_LIVE','LIVE_FILLED')` (`phaseBConfig.ts:74-95`; `arxLiveExecution.ts:209-211`). Legacy: none. Spec wants one idempotency ledger keyed by a client-supplied `idempotency_key` unique forever (`execution_intents.idempotency_key text not null unique`, spec line 621).

**C6 — Two live dispatch gates plus a demo chokepoint plus a legacy guard.** Phase A `evaluateLiveDispatchGate` (always-false, CI-pinned), Phase B `evaluateLivePhaseBDispatchGate` (18 gates), demo `canDispatchToMt5`, and the untouched `placeLiveOrderGuarded()` chokepoint referenced at `livePhaseBDispatchGate.ts:14-18`. Intentional layering, but any spec-§12 refactor must keep the CI-pinned literals (`BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` appended at `livePhaseBDispatchGate.ts:239-241` and asserted by `scripts/src/ci/check-live-trading-readiness-lock.ts` per `liveDispatchGate.ts:4-6`).

**C7 — Status vocabulary near-collisions.** `SENT_TO_MT5_DEMO` vs `SENT_TO_MT5_LIVE` vs legacy `sent`; `FAILED` vs `failed` vs `LIVE_FAILED`; `REJECTED` vs `rejected` vs `LIVE_REJECTED`. All free-text columns — none of the three tables uses a Postgres enum, unlike spec §7's `execution_order_state` enum (spec lines 458–463).

---

## 3. Gaps (ranked)

### G1 — No `UNKNOWN` state; timeouts presume an outcome (spec §6 lines 381–382, §12 lines 870–884, §4 line 251)

The spec's core safety semantic — *submission with no confirmed outcome is `UNKNOWN`, only reconciliation may resolve it, and unknown outcomes block duplicate submission* — does not exist anywhere:

- **G1a — Live TTL sweep presumes non-execution.** `sweepExpiredLiveCommands` moves any over-TTL `SENT_TO_MT5_LIVE` row to terminal `LIVE_EXPIRED` (`liveCommandPipeline.ts:2303-2308`) *including rows the EA already picked up* (`pickedByEaAt` set) whose result POST was lost. If the EA executed the order and crashed before reporting, ARX permanently records "expired before EA execution" (`:2320`) while a real position exists at the broker. The broker-absence guardrail only reconciles *closes* of known positions, not unverified *fills*; `COMMAND_RESULT_MISMATCH` detection is advisory (`detect.ts` is read-only) and blocks nothing.
- **G1b — Ambiguous results are coerced to FAILED and release exposure.** `mapBridgedLiveOutcome` collapses "success-looking status without a broker ticket" to `LIVE_FAILED` (`liveCommandPipeline.ts:2585-2588`), and every non-FILLED outcome **releases** the master exposure reservation (`:2752-2756`). Honest about not fabricating fills — but if the order actually stands at the broker, the pool is now under-counted and the next reservation can over-expose the master account. Spec semantics: this is `UNKNOWN` → urgent reconciliation → resolve from broker-authoritative state; the reservation must be held, not released.
- **G1c — Legacy watchdog marks stale commands `failed`,** with `errorCode: "WATCHDOG_STALE"` and no broker verification (`stuckCommandWatchdog.ts:42-50`), cascading `failed` into `trade_action_requests` (`:62-69`). Same presumption of non-execution.
- **G1d — Demo sweep marks `FAILED`** after 2 minutes without EA pickup (`demoCommandQueue.ts:611-674`) — lower stakes (demo), same pattern.
- **G1e — Unknown outcomes do not block duplicates.** The live idempotency partial index covers only `('SENT_TO_MT5_LIVE','LIVE_FILLED')` (`arxLiveExecution.ts:209-211`). Once the sweep stamps `LIVE_EXPIRED` (an unknown-in-disguise), the identical order re-dispatched in the same minute bucket passes the unique index — precisely the duplicate the spec's "Unknown outcomes block duplicate submission" (spec line 1227) rule prohibits. `RECONCILIATION_REQUIRED` as a distinct, dispatch-blocking condition does not exist in any pipeline (repo-wide grep: no hits outside spec).

### G2 — No acknowledged-vs-filled separation, no partial fills (spec §4 line 249, §12 lines 871–872, 884; §20 line 1226)

- The live machine goes `SENT_TO_MT5_LIVE → LIVE_FILLED` directly (`liveCommandPipeline.ts:99`). `pickedByEaAt` (`arxLiveExecution.ts:127`) is an ack *timestamp*, not a state — no `ACKNOWLEDGED`, no `CANCEL_PENDING`, no `PARTIALLY_FILLED`.
- The legacy reconciler literally maps `"partial" → "completed"` for commands and `"partial" → "executed"` for actions (`executionReconciler.ts:71-79, 82-90`) — a partial fill is recorded as a terminal complete (with `filledLotSize` noted), so remaining quantity is silently dropped and never worked/cancelled.
- `executedVolume` is stored on live fills (`liveCommandPipeline.ts:2661`) but `fulfillReservationByCommandId` fulfils the reservation at requested volume regardless of what actually filled (`:2752-2753`; no volume argument) — partial fills do not "update exposure immediately" (spec line 884).

### G3 — Out-of-order / duplicate broker events are dropped, not retained (spec §12 line 881: "Out-of-order broker events are retained and resolved by venue sequence/time semantics"; §7 `execution_events` unique(intent_id, sequence_no))

- A late or duplicate live result only bumps `duplicateResultCount` and writes an audit line with `reportedOutcome` — the payload (ticket, fill price, retcode) of the losing event is discarded (`liveCommandPipeline.ts:2629-2645, 2714-2730`).
- A late demo result in the wrong state is refused with a security event and discarded (`demoCommandReconciler.ts:84-109`).
- The legacy path merges late fields into terminal action rows (enrichment, `executionReconciler.ts:165-184`) — the best current behavior — but still keeps no ordered event log.
- There is no `execution_events`-shaped table anywhere: no per-intent `sequence_no`, no `occurred_at` vs `received_at` distinction, no venue-sequence resolution. If the first-arriving event is wrong (e.g., EA posts REJECTED, then the true FILLED arrives late), first-write-wins makes the wrong outcome permanent and destroys the evidence needed to fix it.

### G4 — Intents are not immutable; no intent/order separation (spec §4 line 248, §13 `create_once`)

One row mutates from draft through terminal: `status`, `payload`-adjacent columns, and `dispatchGateSnapshot` are overwritten in place (e.g., snapshot rewritten at dispatch `liveCommandPipeline.ts:2110`; every BLOCKED path rewrites it). The AACI integrity hash freezes trade-critical params (`arxLiveExecution.ts:156-185`) — good — but the spec's separation (immutable `execution_intents` row + mutable `broker_orders` row + append-only events) is the actual mechanism that makes audit reconstruction and G1/G3 fixes tractable.

### G5 — No `reconciliation_runs`, no reconciliation-freshness gate (spec §7 lines 681–691, §11 check 10, §14)

Reconciliation sweeps are ephemeral by design (`detect.ts:1-5`). Consequences: no "last reconciled at" fact exists for the risk path; the 18-gate evaluator has **no gate for reconciliation freshness or open mismatches** (full gate list `livePhaseBDispatchGate.ts:24-43`); spec-§14 trigger points (after unknown submission, after restart, before re-enabling) are not orchestrated — there is no `reconciler.enqueue_urgent` analogue (spec line 931).

### G6 — Mismatch does not freeze new entries (spec line 27: "A broker reconciliation mismatch is CRITICAL and blocks new entries"; §14 lines 950–952)

The only freezes consulted at dispatch are *operator-set*: `user_slot_allocation.allocationStatus='frozen'` / `tradingFrozen` (`liveCommandPipeline.ts:1259-1309`). Nothing wires a detected `COMMAND_RESULT_MISMATCH` / `ORPHAN_BROKER_POSITION` / position-count divergence into an automatic connection-level `FROZEN`/`DEGRADED` state that blocks entries. The detector output (`detect.ts:29-40`) is admin-review only.

### G7 — Idempotency is time-bucketed, not durable (spec §7 line 621, §13 lines 890–892)

`buildLiveIdempotencyKey` hashes `(userId|symbol|side|lot|sl|tp|minuteBucket)` (`phaseBConfig.ts:74-95`). The same logical duplicate submitted 61 seconds later is a *different* key. There is no client-supplied idempotency key on intent creation and no `DuplicateIntentError` semantics at draft time (demo fingerprinting comes closest: `demoDispatchDuplicate.ts:47-55` + DB index).

### G8 — Smaller deltas

- `CANCEL_PENDING` / cancel-race-with-fill (spec line 873) is unmodeled: `cancelLiveCommand` only works pre-SENT (`ALLOWED_TRANSITIONS`, `liveCommandPipeline.ts:94-103`); a cancel racing a fill at the broker has no state.
- `LIVE_FILLED → LIVE_CLOSED` exists but position-close reconciliation stamps `arx_live_positions.closedAt` without transitioning the originating OPEN command to `LIVE_CLOSED` (close path `liveCommandPipeline.ts:2773-2829` touches positions, not the source command).
- Protective-order failure fail-safe (spec line 885) exists only as EA-side gates (SL/TP requirements at draft/dispatch, `livePhaseBDispatchGate.ts:211-218`) and the close-ticket-missing critical alert (`liveCommandPipeline.ts:2188-2216`) — no general "protection failed post-fill → critical alert + configured fail-safe" path.
- Statuses are free-text columns, not the spec's `execution_order_state` pg enum — DB accepts any string.
- The function encyclopedia does not document `liveCommandPipeline` / `demoCommandConsumer` / `executionReconciler` / `stuckCommandWatchdog` (grep: no hits) — the doc corpus lags the real execution core.

---

## 4. Smallest dependency-ordered TS implementation slices

Each slice is independently shippable, feature-flagged, and preserves the CI-pinned literals and existing behavior (spec Phase 0 discipline, spec lines 1153–1158).

**S0 — Canonical state vocabulary (pure domain, no DB).**
New `lib/domain/src/safety-contracts/executionOrderState.ts`: the spec's 14-value enum + total mapping functions `fromLiveStatus(ArxLiveCommandStatus)`, `fromDemoStatus(DemoCommandStatus)`, `fromLegacyMt5Status(string)` (fail-closed → `reconciliation_required` for unknown inputs, mirroring `mapLegacyReconciliationStatus`'s pattern at `reconciliation.ts:55+`). No callers change. Unblocks every later slice and gives the UI/reporting one vocabulary.

**S1 — UNKNOWN semantics in the live pipeline (schema-additive).**
Add `LIVE_UNKNOWN` and `LIVE_RECONCILIATION_REQUIRED` to `ARX_LIVE_COMMAND_STATUSES` + `ALLOWED_TRANSITIONS` (`SENT_TO_MT5_LIVE → LIVE_UNKNOWN`, `LIVE_UNKNOWN → LIVE_RECONCILIATION_REQUIRED`, `LIVE_RECONCILIATION_REQUIRED → LIVE_FILLED|LIVE_REJECTED|LIVE_FAILED|LIVE_CANCELLED|LIVE_EXPIRED`). Change exactly two decision points: (a) `sweepExpiredLiveCommands` sends `pickedByEaAt IS NULL` rows to `LIVE_EXPIRED` (EA provably never saw it) but `pickedByEaAt IS NOT NULL` rows to `LIVE_UNKNOWN`; (b) `mapBridgedLiveOutcome` returns a new `LIVE_UNKNOWN` outcome for success-without-ticket instead of `LIVE_FAILED`. In `recordLiveCommandResult`, `LIVE_UNKNOWN` **holds** the exposure reservation instead of releasing (`liveCommandPipeline.ts:2749-2764`). Extend the idempotency partial index to `('SENT_TO_MT5_LIVE','LIVE_FILLED','LIVE_UNKNOWN','LIVE_RECONCILIATION_REQUIRED')` so unknown outcomes block duplicates (fixes G1e).

**S2 — `execution_events` append-only table (schema-additive, dual-write).**
New table keyed `(commandId, sequenceNo)` unique, columns per spec lines 668–679 (`event_type`, `source`, `payload`, `occurred_at`, `received_at`). Write from the existing choke functions only: `transitionTo` (demo), `assertCanTransition` call sites / the CAS updates (live), and — critically — the duplicate/late-result branches (`liveCommandPipeline.ts:2629-2645, 2714-2730`; `demoCommandReconciler.ts:84-109`) so out-of-order payloads are *retained* (fixes G3). Revoke UPDATE/DELETE at the DB layer (spec line 705). No reads depend on it yet.

**S3 — Urgent reconciliation worker for UNKNOWN (depends S1, S2).**
A small runner (pattern: `brokerAbsenceReconcileRunner.ts`) that, for each `LIVE_UNKNOWN` command, requests an EA order/position snapshot (`SYNC_REQUEST` command type already exists, `executionMode.ts:80`), matches on broker ticket/comment (`buildArxOrderComment` already stamps identity, `demoCommandQueue.ts:214-218`), and resolves via the existing CAS write path with events. Unresolved after N reliable sweeps → `LIVE_RECONCILIATION_REQUIRED` + per-user entry freeze flag (reuse the `tradingFrozen` mechanism consulted at `liveCommandPipeline.ts:1270-1281`). This delivers spec §14 "immediately after an unknown submission" and G6's automatic entry-block for the highest-severity mismatch class.

**S4 — `reconciliation_runs` + freshness gate (depends S3 conceptually, independent mechanically).**
Persist each Reconciliation Center sweep (`broker_account`≈bridgeConnectionId, `status`, `positions_match`, `orders_match`, `mismatch_summary`, timestamps — spec lines 681–691) from `detect.ts` output. Add gate #19 to `evaluateLivePhaseBDispatchGate`: `RECONCILIATION_STALE_OR_MISMATCHED` (input: last run age + open critical-issue count; entry orders only, ops commands exempt, same pattern as `isOpsCommand` at `liveCommandPipeline.ts:1688-1689`). Default the age threshold generously and flag-gate it so behavior is preserved until enabled.

**S5 — Acknowledged + partial-fill states (depends S0, S2).**
Promote `pickedByEaAt` to a real `LIVE_ACKNOWLEDGED` state (EA pickup = venue ack for the MT5 transport); add `LIVE_PARTIALLY_FILLED` with `executedVolume` accumulation events; change `fulfillReservationByCommandId` to fulfil by executed volume and release the remainder. Stop mapping `"partial"→"completed"` in `executionReconciler.ts:71-79` — map to a non-terminal partial status on `trade_action_requests`. This is the largest behavioral slice; it rides on the event log from S2 for multi-fill aggregation.

**S6 — Durable idempotency ledger (independent after S0).**
Accept a client/caller idempotency key at draft creation (`createLiveDraft` input), unique index on `arx_live_commands(idempotency_key_client)` over non-terminal + filled + unknown states, and keep the minute-bucket hash as a defense-in-depth secondary. Demo already has the equivalent (fingerprint) — converge naming via S0.

**S7 — Adapter seam (Phase 0/1 of multi-broker; depends on nothing above).**
Extract a TS `BrokerAdapter` interface mirroring spec §6's Protocol (lines 424–439) and implement `Mt5EaAdapter` by wrapping the existing mailbox primitives (`enqueueBridgedMt5Command`, `pickupNextLiveCommand`, `recordLiveCommandResult`, heartbeat facts from `mt5ConnectionTable`). No behavior change — this is the boundary that lets Deriv/OANDA adapters plug into the *same* orchestrator instead of cloning C1's dual-row pattern per venue. Unimplemented brokers return explicit `NOT_IMPLEMENTED` (spec line 1244).

---

## 5. Red-fail tests (prove each safety gate can fail)

Each test must be written to **fail against today's code** where it encodes a gap (marked ⛔), or fail when a future regression weakens a gate (marked ✅ = passes today, guards regressions).

**UNKNOWN / reconciliation semantics**
1. ⛔ *Picked-up command is never presumed dead:* dispatch → stamp `pickedByEaAt` → advance clock past TTL → run `sweepExpiredLiveCommands` → assert status is **not** terminal-`LIVE_EXPIRED` (must be `LIVE_UNKNOWN`). Fails today at `liveCommandPipeline.ts:2303-2308`.
2. ⛔ *Unknown blocks duplicates:* same-minute re-dispatch of an identical order after the original was swept from a picked-up state must be refused by the idempotency index. Fails today (`arxLiveExecution.ts:209-211` excludes `LIVE_EXPIRED`).
3. ⛔ *Ambiguous success holds the reservation:* `recordLiveCommandResult` with success-status + `brokerTicket:null` must NOT call `releaseReservationByCommandId`. Fails today (`liveCommandPipeline.ts:2585-2588` + `2752-2756`).
4. ⛔ *Watchdog does not fabricate failure:* a `mt5_commands` row mirroring a live command that has a broker-side open position (seeded snapshot) must not be marked `failed` by `sweepStuckCommands` without a reconciliation probe. Fails today (`stuckCommandWatchdog.ts:42-50` is unconditional).

**Acknowledged vs filled / partial**
5. ⛔ *Partial is not complete:* `reconcileExecutionResult` with `status:"partial"`, `lotSizeFilled < lot` must leave the command/action in a non-terminal partial state. Fails today (`executionReconciler.ts:73-74, 84-85`).
6. ⛔ *Partial fulfils reservation partially:* reservation fulfilment after a partial fill must reduce reserved lots to `executedVolume`. Fails today (no volume plumbed at `liveCommandPipeline.ts:2752-2753`).
7. ✅ *No fill without ticket:* `mapBridgedLiveOutcome({status:"completed", hasBrokerTicket:false})` never returns `LIVE_FILLED` (`liveCommandPipeline.ts:2585-2588`). Mutation target: flip `hasBrokerTicket` check → test must go red.

**Out-of-order event retention**
8. ⛔ *Late conflicting result is retained:* post `LIVE_REJECTED`, then post `LIVE_FILLED` with a real ticket for the same command → assert the second payload (ticket/price) is durably stored somewhere queryable (events table), not just `duplicateResultCount++`. Fails today (`liveCommandPipeline.ts:2631-2634` discards the payload).
9. ✅ *First-write-wins CAS:* concurrent result POSTs (FILLED vs REJECTED) → exactly one applies; loser gets `DUPLICATE_IGNORED`; command never shows the loser's status (`liveCommandPipeline.ts:2708-2730`).

**State machine integrity**
10. ✅ *Illegal transitions throw:* every `(from,to)` pair not in `ALLOWED_TRANSITIONS`/`DEMO_COMMAND_TRANSITIONS` is rejected (`liveCommandPipeline.ts:1160-1164`; `executionMode.ts:125-130`). Mutation: add `LIVE_EXPIRED → SENT_TO_MT5_LIVE` to the table → a pinned-snapshot test of the transition tables must go red.
11. ✅ *Terminal monotonicity:* a result POST for a terminal command never mutates status (`liveCommandPipeline.ts:2629-2645`); a "pending" callback never downgrades a completed legacy command (`executionReconciler.ts:101-113`).
12. ✅ *Race-lost sweep never overwrites a real result:* concurrent `expireStaleSentCommands` vs demo EA write-back → the EA terminal stands (`demoCommandQueue.ts:634-646` CAS + `RACE_LOST`).

**Dispatch gates (mutation-test the chokepoints — spec line 1030)**
13. ✅ *18-gate truth table:* for each of the 18 gates in `evaluateLivePhaseBDispatchGate`, flipping exactly that input flips `decision` to BLOCKED with that `primaryReason` (`livePhaseBDispatchGate.ts:117-250`). Mutation: comment out any single `fail(...)` call → suite goes red.
14. ✅ *Master switch sentinel:* `liveBrokerExecutionEnabled=false` always appends `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` last (`livePhaseBDispatchGate.ts:239-241`); env `true` + DB unarmed still blocks (`phaseBConfig.ts:54-72` truth table).
15. ✅ *Demo chokepoint refuses with no inputs:* `canDispatchToMt5()` with zero args refuses `NO_PER_USER_INPUTS` (`executionMode.ts:254-259`); `eaVersionAtLeast:false` refuses `EA_VERSION_TOO_OLD` (`executionMode.ts:221-223`).
16. ✅ *Bridge binding:* result POST from `reportingBridgeConnectionId != row.bridgeConnectionId` → `BRIDGE_BINDING_MISMATCH`, no dedup counter bump (`liveCommandPipeline.ts:2621-2623`); pickup from the wrong bridge returns no command (`:2367-2376`).
17. ✅ *MOCK never live:* a MOCK-mode bridge with `accountType='live'` is refused pre-evaluator (`liveCommandPipeline.ts:1643-1674`).
18. ✅ *Exposure TOCTOU:* two parallel dispatches against remaining cap for one → exactly one obtains a reservation (`exposureReservation.ts` advisory lock); in-flight SENT commands count toward per-user caps (`liveCommandPipeline.ts:1759-1785`).

**Reconciliation-blocks-entries (S3/S4 acceptance)**
19. ⛔ *Mismatch freezes entries:* seed a `COMMAND_RESULT_MISMATCH`-class divergence (command `LIVE_FILLED`, no broker position in a reliable snapshot; or vice versa) → next entry-order dispatch for that user/bridge must block with a reconciliation reason. Fails today: no such gate exists in `livePhaseBDispatchGate.ts:24-43`.
20. ⛔ *Reconciliation freshness:* with no recorded reconciliation run (table absent/empty), an entry dispatch must block once the S4 gate is enabled. Fails today by construction.
21. ✅ *Broker-absence guardrail never single-snapshot-closes:* one missing snapshot, or an unreliable/partial sweep, never stamps `RECONCILED_BROKER_ABSENT` (`brokerAbsenceReconcile.ts:39-65` reset rules).

---

## 6. Bottom line

The TypeScript codebase already contains high-quality, test-worthy implementations of the spec's *mechanics* — CAS transitions, exactly-once pickup, bridge binding, atomic reservations, fail-closed master switches, honest fill mapping, evidence-based close reconciliation. What it lacks is the spec's *epistemology*: the system currently refuses to say "I don't know." Every timeout and every ambiguous broker answer is coerced into a confident terminal state (`LIVE_EXPIRED`, `LIVE_FAILED`, `failed`), duplicate/late broker evidence is discarded, and no dispatch gate consults reconciliation state. Those are exactly the behaviors spec §12/§14 exist to forbid, and they are concentrated in ~6 decision points (S1–S4) that can be changed additively without disturbing the CI-pinned safety literals.
