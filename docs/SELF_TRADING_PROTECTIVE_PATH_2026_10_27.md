# Self-trading protective-action path — 27 October 2026

Branch `claude/self-trading-protective`, cut from the integration merge `444e726` (PR 99 head `11cb10a`). Trading, workers and settlement stay disabled. No broker, demo or network order test ran, no existing database was touched, no schema migration was added. Files owned by the MT5 team (`routes/mt5.ts`, `routes/mt5Live.ts`, `lib/mt5/*`, `mt5-bridge/*`) are read, cited and not edited.

This is offline evidence only. It does not establish real execution correctness or broker behaviour.

## 1. Owner decision and where each clause lives

> Retain the current stale-position restriction for now. Do not introduce a blanket bypass for protective actions. Implement a separate protective-action path that obtains fresh authoritative position evidence, verifies account and exact position identity, and guarantees the action cannot increase exposure, reverse the position or loosen its stop. If verification fails, hold the action and clearly explain why. Preserve manual controls and existing broker-side stops.

| Clause | Code |
| --- | --- |
| Retain the stale-position restriction | `livePositionManager.ts:453-473` is unchanged in effect: `evaluatePositionObservation` keeps its 90 s default (`freshFacts.ts:39`, `POSITION_OBSERVATION_MAX_AGE_MS = 90_000`), `held++` and `heldReasons[MANAGEMENT_OBSERVATION_*]++` happen first, and the hold still leaves `managementState` untouched (the pre-existing lifecycle tests keep asserting `held === 1`, `evaluated === 0`, `managementState` `{}`). |
| No blanket bypass | The path starts *inside* the hold branch, after the hold is counted (`livePositionManager.ts:463-510`), and never uses the refused observation. The guard `check-protective-action-path` refuses a build where the call moves before the hold is counted or the ordinary call grows its own `maxAgeMs`. |
| Fresh authoritative evidence | `evaluateProtectiveObservation` (`freshFacts.ts:362`) accepts only a row written by a complete EA sweep (`lastReliableSnapshotAt === lastSyncedAt`, `brokerAbsentSnapshotCount === 0`), strictly newer than the hold, covered by the bridge's complete-snapshot marker and an online heartbeat (section 2). |
| Verify account and exact position identity | `verifyProtectiveBridge` and `verifyProtectivePosition` (`lib/domain/src/self-trade/protectiveAction.ts:400, 437`); the row is read by the 9-field `managementPositionScope` (`managementConsumers.ts`), never user + ticket (section 5). |
| Cannot increase exposure, reverse or loosen the stop | `doesNotIncreaseExposure`, `doesNotReverse`, `doesNotLoosenStop`, `evaluateProtectiveGeometry` (`protectiveAction.ts:281-315`); the type of intent admits only `CLOSE` of the full volume on the same side and `MODIFY_STOP` with a strictly tighter stop and a pinned take-profit (section 4). Re-checked at the final claim (`managementTarget.ts:488-530`). |
| Hold and explain | Every failure is a hold: nothing is written to `managementState`, an audit row `PROTECTIVE_ACTION_HELD` carries the reason, redacted detail and the plain-English text from `explainProtectiveHold` (`protectiveAction.ts:595`), and the cycle result reports `managementHeld[reason]` (`autonomousCycle.ts:68, 304-307`). |
| Preserve manual controls and broker-side stops | The path only ever produces the same two command types as ordinary management (`CLOSE_LIVE_POSITION`, `MODIFY_LIVE_SLTP`) through the same Guardian rule, pipeline and gates; it never cancels, widens or removes a stop, never touches manual commands, and a manual command sent during the wait forces the path to wait for evidence newer than it (`PROTECTIVE_OBSERVATION_PREDATES_COMMAND`). |

## 2. What "fresh authoritative evidence" means here

The server never asks the broker anything. Position facts arrive only when the EA pushes a complete positions sweep (`PushSnapshots()` every `SnapshotIntervalSeconds = 10` in `ARX_AI_Universal_Agent_v154.mq5:70, 212`; 5 s in older builds). The sweep writes `lastSyncedAt` **and** `lastReliableSnapshotAt` to the same instant and resets `brokerAbsentSnapshotCount` (`routes/mt5Live.ts:324-330`); a ticket missing from a complete sweep gets `brokerAbsentSnapshotCount + 1` (`mt5Live.ts:405-407`); afterwards the connection's `lastPositionsSnapshotAt` marker is stamped (`mt5Live.ts:433`). Reconcilers write `lastSyncedAt` alone (`liveCommandPipeline.ts:293, 522, 532, 610`), so `lastReliableSnapshotAt !== lastSyncedAt` identifies a row that the latest writer was not a sweep.

There is no pull. `POSITIONS_SNAPSHOT_REQUEST` is an allow-listed manual command (`routes/meMt5Commands.ts:18`); the v154 EA answers `GET_OPEN_POSITIONS` by posting a result JSON (`v154.mq5:560, 575`) that no server-side consumer writes into `arx_live_positions`. The path therefore *waits* for the next sweep rather than requesting one (section 12 lists the EA-side follow-up).

Evidence is accepted when all of the following hold (`evaluateProtectiveObservation`, rules in order, first failure wins):

1. `closedAt` and `reconcileState` are null (`PROTECTIVE_OBSERVATION_POSITION_CLOSED`).
2. `lastSyncedAt` parses, is not future-dated and is at most 90 s old — the existing window, no new constant (`_TIMESTAMP_INVALID`, `_FUTURE_DATED`, `_STALE`).
3. `brokerAbsentSnapshotCount === 0` (`PROTECTIVE_POSITION_ABSENT_AT_BROKER`). Checked before provenance because the sweep's absent bump stamps `lastReliableSnapshotAt` without `lastSyncedAt` (`mt5Live.ts:405-407`); in the spec's order the more specific reason would never be reachable from real sweep data (found by the PostgreSQL case "ticket went absent between draft and claim").
4. `lastReliableSnapshotAt === lastSyncedAt` (`_NOT_FROM_SWEEP`).
5. Strictly newer than the hold (`mustBeAfterMs`), or, at the final claim, not older than the evidence the claim was taken on (`mustNotPrecedeMs`) (`_NOT_NEWER`). A non-finite bound refuses.
6. Newer than every command event on the ticket, including a manual close/modify sent during the wait (`_PREDATES_COMMAND`).
7. The bridge's `lastPositionsSnapshotAt` is present, not older than the row and within the 90 s window (`PROTECTIVE_SWEEP_MARKER_STALE`).
8. Heartbeat online, i.e. under 60 s (`heartbeatPolicy.ts:26, 103`) (`PROTECTIVE_BRIDGE_OFFLINE`). The stricter *fresh* bound (under 15 s, `heartbeatPolicy.ts:24, 95`) is applied separately just before the claim.
9. `currentPrice`, `entryPrice`, `volume` are finite and positive (`_PRICE_INVALID`).

## 3. Sequence (`runProtectiveActionPath`, `protectiveActionPath.ts:199`)

No transaction and no row lock are taken anywhere in the path; the only write before dispatch is the compare-and-set on the execution's JSONB `managementState`. The whole body is wrapped in `try/catch`; any throw holds `PROTECTIVE_HOLD_INTERNAL_ERROR`.

1. **Classification, no IO.** Autonomy below L3 → `NOT_APPLICABLE`. The stale row is re-decided only to learn whether a protective trigger exists (`classifyProtectiveTrigger`: `INVALIDATION_BREACH → EXIT_INVALIDATION`, `BREAK_EVEN → MOVE_TO_BE`, `TRAIL → TIGHTEN_SL`; final/first target and HOLD are not protective → `NOT_PROTECTIVE`). That verdict is discarded; nothing from the stale row is acted on.
2. **Pre-checks that make waiting pointless.** Connection read + `verifyProtectiveBridge` (section 5, includes heartbeat online and `supportsManagementTargetV1`); `platformStop()` through `preCheckStopRefusal` (`PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED`; unreadable counts as engaged); user arming (`PROTECTIVE_HOLD_USER_NOT_ARMED`, `PROTECTIVE_HOLD_USER_KILL_SWITCH`). The entry-only self-trade kill switches are deliberately not read here.
3. **Wait budget.** `EXIT_INVALIDATION` gets `PROTECTIVE_EVIDENCE_WAIT_MS = 20_000` (two v154 sweep cadences); `MOVE_TO_BE` and `TIGHTEN_SL` get 0 and hold `PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE` (INFO): stop tightening is not urgent and the ordinary path acts next cycle from a fresh row. One deadline is shared by every held execution of one `manageAgentPositions` call, because one sweep refreshes every row on the bridge.
4. **Poll loop** (`PROTECTIVE_POLL_MS = 1_000`): read the row by the 9-field scope, the connection and the ticket's commands (re-read each poll), evaluate section 2 with `mustBeAfterMs = heldAtMs`. Terminal reasons (closed, row missing, invalid/future timestamp, bridge offline, absent at broker) hold immediately; `_NOT_NEWER` / `_STALE` keep polling; at the deadline the hold is `PROTECTIVE_HOLD_NO_FRESH_SWEEP` when nothing newer ever arrived, otherwise the last specific reason (for example `_PREDATES_COMMAND` when a manual modify kept superseding the evidence).
5. **Fresh decision** on the sweep row with the same inputs as the ordinary path; no protective trigger → `PROTECTIVE_HOLD_TRIGGER_CLEARED` (INFO). If the trigger changed, the fresh one wins.
6. **Identity**: `verifyProtectivePosition` (section 5).
7. **Heartbeat fresh** (under 15 s) else `PROTECTIVE_BRIDGE_HEARTBEAT_NOT_FRESH` — avoids claiming a command the dispatch gate would block.
8. **Intent + geometry**: `CLOSE { side, volume: row.volume }` or `MODIFY_STOP { side, newStopLoss, newTakeProfit: row.takeProfit }`; `evaluateProtectiveGeometry` (section 4). The exact object checked is the one mapped onto the pipeline intent.
9. **Claim (CAS)**: `pendingManagement` gains `protective: { trigger, heldReason, heldAtMs, evidence: { lastSyncedAt, sweepAt, heartbeatAt, serverName, currentPrice, volume, stopLoss, takeProfit } }` (`executionLifecycle.ts:26-41`); a lost CAS holds `PROTECTIVE_HOLD_CLAIM_RACE`.
10. **Dispatch** through the factored `dispatchClaimedManagement` (`livePositionManager.ts:155`): audit `MANAGEMENT_DISPATCH_INTENT` with `afterState.protective` (timing fields in section 9), then `guardianInstantManage({ ruleId: "self-trade-manage", ... })` exactly as the ordinary path. Everything downstream is unchanged and still runs: `buildManagementTarget`, `createLiveOpsDraft` (arming, kill switch, geometry), Risk Governor tighten-only, Phase B gates, `claimManagementCommand` (section 8), mailbox pickup, EA `ArxManagementPreflight`.
11. **Outcome bookkeeping** is the existing code: a refusal without `commandId` rolls the claim back (`PROTECTIVE_HOLD_PIPELINE_REFUSED`); a `commandId` is linked (+ `closeCommandId` for EXIT); an uncertain submission keeps the claim.

Lock order downstream is unchanged: bridge → execution → entry → position → command (`managementTarget.ts:350-357`); no network under locks.

## 4. Geometry predicates (pure, `lib/domain/src/self-trade/protectiveAction.ts`)

Hygiene: positive finite numbers only; `EPS_PRICE = 1e-9`; `volTol(v) = max(1, |v|) · Number.EPSILON · 16`. A `side` other than exactly `"BUY"`/`"SELL"`, an intent with an unknown `kind`, a missing or extra key (`closeVolume`, `volume` on MODIFY, `newTakeProfit` on CLOSE), or any non-finite/zero/negative/string number → `PROTECTIVE_GEOMETRY_INVALID`. Evaluation order: shape/side → reverse → partial → stop → take-profit; first failure wins.

- **G1 `doesNotIncreaseExposure`** — CLOSE must be the full volume on the position's side (`PROTECTIVE_PARTIAL_NOT_SUPPORTED` below; above is G2). MODIFY has no size field and must keep the take-profit (`PROTECTIVE_TAKE_PROFIT_CHANGED`; `null === null` allowed). The intent type admits no open, pending, reverse or close-by.
- **G2 `doesNotReverse`** — CLOSE side must match (`PROTECTIVE_SIDE_MISMATCH`) and volume must not exceed the position (`PROTECTIVE_WOULD_REVERSE`; on a netting account an over-volume close is an opposite-side market order).
- **G3 `doesNotLoosenStop`** — CLOSE: true. MODIFY: `newStopLoss === null` is a removal → `PROTECTIVE_STOP_NOT_TIGHTER`; the stop may never sit at or through price (BUY `s < p − EPS`, SELL `s > p + EPS`, else `PROTECTIVE_STOP_THROUGH_PRICE`, where `p` is the v154 snapshot price on the side the stop triggers); when a stop exists it must be strictly tighter (equal → `PROTECTIVE_STOP_NOT_TIGHTER`: a no-op must not spend a claim); a null current stop may be set.

Edge table (BUY unless stated, entry 1.1000; all cases are in `scripts/src/selfTradeProtectiveActionTest.ts`):

| current stop `c` | price `p` | new stop `s` | Result |
| --- | --- | --- | --- |
| 1.0950 | 1.1120 | 1.1000 | ok (break-even) |
| 1.0950 | 1.1120 | 1.0950 / 1.0950 + 1e-12 | `STOP_NOT_TIGHTER` |
| 1.0950 | 1.1120 | 1.0950 + 1e-8 | ok |
| 1.0950 | 1.1120 | 1.0940 | `STOP_NOT_TIGHTER` (loosens) |
| 1.0950 | 1.1120 | 1.1120 / 1.1120 − 1e-12 / 1.1130 | `STOP_THROUGH_PRICE` |
| null | 1.1120 | 1.1000 | ok |
| null | 1.1120 | 1.1200 | `STOP_THROUGH_PRICE` |
| 1.0950 | 1.1120 | NaN / 0 / −1 / "1.1" | `GEOMETRY_INVALID`; `null` → `STOP_NOT_TIGHTER` |
| SELL 1.1050 | 1.0880 | 1.1000 | ok |
| SELL 1.1050 | 1.0880 | 1.1050 | `STOP_NOT_TIGHTER` |
| SELL 1.1050 | 1.0880 | 1.0880 / 1.0870 | `STOP_THROUGH_PRICE` |
| TP 1.1300 → intent TP 1.1250 or null | — | — | `TAKE_PROFIT_CHANGED` |
| CLOSE 0.10 vs 0.10·(1+1e-17) | — | — | ok |
| CLOSE 0.09 vs 0.10 | — | — | `PARTIAL_NOT_SUPPORTED` |
| CLOSE 0.11 vs 0.10 | — | — | `WOULD_REVERSE` |
| CLOSE side SELL vs BUY / `"buy"` / `"LONG"` | — | — | `SIDE_MISMATCH` / `GEOMETRY_INVALID` |
| `{ kind: "OPEN" }`, `{ kind: "REVERSE" }`, CLOSE with `closeVolume` | — | — | `GEOMETRY_INVALID` |

Downstream the same constraints are enforced again by Guardian `authorizeManagement`, the Risk Governor tighten-only rule, `assertManagementGeometry` at draft/claim/transport and the EA preflight. New here: the through-price refusal and the no-op refusal.

## 5. Identity verification

`verifyProtectiveBridge(entry, execution, connection, heartbeat)` — order: connection present and `id === entry.bridgeConnectionId` (`PROTECTIVE_BRIDGE_UNVERIFIED`); `userId === executingUserId` (`_OWNER_MISMATCH`); `accountNumber === entry.accountLogin`, `brokerName === entry.brokerServer`, non-empty `serverName` (`_ACCOUNT_MISMATCH`); not revoked, token present (`_REVOKED`); `accountType` live/real (case-insensitive; null refuses) and `mode !== "MOCK"` (`_NOT_LIVE`); heartbeat online (`_OFFLINE`); `supportsManagementTargetV1` (`PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED`). The domain function takes the heartbeat class as a label so the module stays import-free; the caller classifies with `heartbeatPolicy`.

`verifyProtectivePosition(execution, entry, row)` — order: row present (`PROTECTIVE_IDENTITY_ROW_MISSING`); `row.userId === executingUserId === entry.userId` (`_OWNER_MISMATCH`); same broker account as the entry (`_ACCOUNT_MISMATCH`); `brokerTicket` equal across row, execution and entry (`_TICKET_MISMATCH`); `row.sourceCommandId === entry.commandId` (`_SOURCE_COMMAND_MISMATCH`); broker-native symbol (`_SYMBOL_MISMATCH`); side (`_SIDE_MISMATCH`); volume within `volTol` of the intended volume (`_VOLUME_CHANGED`). Detail carries `{ field, expected, observed, rowId }`.

The row itself is read by `managementPositionScope` over all nine fields (row id, user, bridge, login, company, ticket, entry command, symbol, side), so a reused ticket on another account of the same user never matches (PostgreSQL case "the 9-field protective scope reads only the exact row when another account reuses the ticket").

MT5 `POSITION_IDENTIFIER` is not checkable: it is not ingested, there is no column and no migration is allowed. Compensating controls are the EA `ArxManagementPreflight` (`mt5-bridge/ArxManagementTarget.mqh:169-217`: real trade mode, login, server, `PositionSelectByTicket`, symbol/type/volume/SL/TP equality, re-check after selection) and `assertReceipt` on the result.

## 6. Hold reasons and their text

All 44 reasons in `PROTECTIVE_HOLD_REASONS` have operator text in `explainProtectiveHold(reason, detail)`; placeholders come from the redacted detail (`redactProtectiveDetail` drops keys matching token/hash/secret/apikey/password/credential), unknown placeholders render as "unknown", and `ageMs`/`waitedMs` are also offered as seconds. Representative texts:

| Reason | Text |
| --- | --- |
| `PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED` | The platform emergency stop is engaged ({sources}). Automatic closes and stop moves are refused by design; use the admin emergency close or the broker terminal. Broker-side stop and take-profit remain active. |
| `PROTECTIVE_HOLD_USER_NOT_ARMED` / `_USER_KILL_SWITCH` | Live trading is not armed / your live kill switch is engaged, so no automatic order can be created. Manual close/modify and broker-side stops are unaffected. |
| `PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED` | This terminal's EA does not support exact-target management (supportsManagementTargetV1). Upgrade the EA or manage the position manually. |
| `PROTECTIVE_BRIDGE_*` | The bridge now reports account {login}@{server} ({mode}/{accountType}); the position was opened on {expectedLogin} at {expectedCompany}. Nothing is sent to a different account. |
| `PROTECTIVE_BRIDGE_OFFLINE` / `_HEARTBEAT_NOT_FRESH` | The MT5 bridge heartbeat is {ageSec}s old (offline after 60s) / live dispatch requires under 15s. |
| `PROTECTIVE_HOLD_NO_FRESH_SWEEP` | No broker position snapshot newer than {heldAt} arrived within {waitedSec}s (last snapshot {ageSec}s old). ARX will not close or move a stop from old data. Manual controls and the stop held at the broker remain active. |
| `PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE` (INFO) | Stop tightening is not urgent; it will be re-evaluated next cycle from a fresh snapshot. |
| `PROTECTIVE_OBSERVATION_*` | The latest snapshot is {ageMs}ms old / dated ahead of the server / has no usable time / was last written by a reconciler, not a complete terminal snapshot / is not newer than the hold at {heldAt} / predates a close or modify sent at {eventAt}. |
| `PROTECTIVE_SWEEP_MARKER_STALE` | The terminal's complete-snapshot marker is older than the row or too old; the row cannot be trusted as part of a full sweep. |
| `PROTECTIVE_POSITION_ABSENT_AT_BROKER` | The latest complete broker snapshot did not list ticket {ticket} (absent {count} sweep(s)). It may already be closed at the broker; reconciliation will confirm. No order was sent. |
| `PROTECTIVE_IDENTITY_*` | The broker position no longer matches the one this agent opened ({field}: expected {expected}, observed {observed}). Nothing is sent. |
| `PROTECTIVE_HOLD_TRIGGER_CLEARED` (INFO) | Fresh snapshot: price {p} no longer triggers {trigger}; no action. |
| `PROTECTIVE_GEOMETRY_*` | The proposed {action} would loosen or not tighten the stop / place the stop at or through price / change the take-profit / exceed the open volume / reduce size (no partial path) / act on the wrong side; refused. |
| `PROTECTIVE_HOLD_CLAIM_RACE` / `_PIPELINE_REFUSED` / `_OUTCOME_UNCERTAIN` / `_INTERNAL_ERROR` | Another cycle already claimed this position / the live pipeline refused the request before a command existed: {pipelineReason} / the submission outcome is unknown and the claim is kept for reconciliation / the protective path failed safely ({message}); nothing was sent. |
| `MANAGEMENT_PAUSED_AACI_REVIEW` (cycle-level) | Management for this agent is paused until the AACI chain review clears. |

Where they surface: (1) `self_trade_audit_log` rows `PROTECTIVE_ACTION_HELD` (severity WARNING; INFO for TRIGGER_CLEARED and DEFERRED) → `GET /self-trade-ai/audit` (`routes/selfTradeAi.ts:109`) and the existing Audit tab; (2) `ManagePositionsResult.protective.held` → `RunAutonomousCycleResult.managementHeld` → `POST /self-trade-ai/run-autonomous-cycle` (`routes/selfTradeAi.ts:162`); (3) `managementNote` says "Protective close/stop change awaiting broker confirmation." for a linked protective claim (`executionLifecycle.ts:87-88`); (4) `logger.warn`. Hold explanations are durable in the audit log, not in `managementState` (kept out so that a hold still leaves `managementState` untouched).

## 7. What is untouched

- The ordinary hold (`livePositionManager.ts:453-473`): same 90 s rule, same `_PREDATES_COMMAND` rule, same five `MANAGEMENT_OBSERVATION_*` keys in `heldReasons`, `managementState` not written on a hold.
- Under `chain.shouldPauseManagement` (`autonomousCycle.ts`) neither the ordinary nor the protective path runs; the cycle result records `MANAGEMENT_PAUSED_AACI_REVIEW`.
- Manual commands, the admin emergency close, the platform emergency stop, user arming and kill switches: all still gate or pre-empt the path; nothing bypasses them.
- Broker-side SL/TP: never cancelled, widened or removed; a stop move is only ever strictly tighter.
- MT5 routes, transport, EA sources and the C++ harness: unchanged.
- No new `livePositionWriter` caller, no `mt5CommandsTable` or `arx_live_commands` write from the path, no `fetch`.

## 8. Final-claim parity (`managementTarget.ts:488-530`)

Inside the existing `LIVE_APPROVED` block of `claimManagementCommand`, after `assertManagementGeometry` and the existing observation check, a claim carrying `pendingManagement.protective` re-evaluates the already-locked row and bridge with `mustNotPrecedeMs = protective.evidence.lastSyncedAt` (an unparseable value becomes `NaN` and refuses) and, for a stop move, re-proves `doesNotLoosenStop` against the locked `currentPrice`. No new statement and no new lock are taken; the ordinary claim without `protective` is unchanged. Refusals surface as `ManagementTargetError` with the protective reason and leave the command `LIVE_APPROVED`.

## 9. Thresholds

| Quantity | Value | Source |
| --- | --- | --- |
| Observation window | 90 s | existing `POSITION_OBSERVATION_MAX_AGE_MS` (`freshFacts.ts:39`); the path adds no window of its own and the guard asserts it |
| Evidence wait | 20 s | `PROTECTIVE_EVIDENCE_WAIT_MS` (`protectiveActionPath.ts:84`) = 2 × v154 `SnapshotIntervalSeconds` (10 s, `v154.mq5:70`) |
| Poll | 1 s | `PROTECTIVE_POLL_MS` (`protectiveActionPath.ts:86`) |
| Heartbeat online | < 60 s | `heartbeatPolicy.ts:26` |
| Heartbeat fresh (pre-claim) | < 15 s | `heartbeatPolicy.ts:24` |

## 10. Measured latency

Container measurements on a shared, loaded host; not production SLOs. No broker or EA timing is inferred.

- **Pure predicates** (`test:self-trade-protective-domain`, n = 10 000 each, printed as `PROTECTIVE_DOMAIN_BENCHMARK`): `evaluateProtectiveGeometry` 1.2–3.9 µs, `verifyProtectivePosition` 1.8–2.7 µs, `verifyProtectiveBridge` 0.26–0.37 µs per call across runs.
- **Final-claim parity** (opt-in, disposable PostgreSQL: `ARX_PROTECTIVE_BENCHMARK=/path/out.json runuser -u claude -- env … pnpm --filter @workspace/api-server run test:self-trade-management-postgres`; 320 interleaved pairs, 20 warm-up pairs discarded, EXIT command, `claimLiveCommandForDispatch` wall time):

| Variant | median / p95 / p99 (ms) |
| --- | --- |
| ordinary claim (no `protective`) | median 8.72 ms · p95 13.27 ms · p99 27.66 ms (n=300) |
| protective claim (parity evaluated) | median 8.80 ms · p95 13.35 ms · p99 25.83 ms (n=300) |

  The parity check is a pure evaluation over rows the claim already locks; the difference is within run-to-run noise of this container (compare `docs/SELF_TRADING_FRESH_FACTS_2026_10_27.md` section "Added latency at the final check", medians 13–16 ms on the same kind of fixture).
- **Per dispatch** (no new infrastructure): the `MANAGEMENT_DISPATCH_INTENT` audit `afterState.protective` carries `heldAtMs`, `evidenceAtMs`, `evidenceWaitMs`, `waitedMs`, `polls`, `verifyMs` (identity + geometry) and `claimMs` (CAS). A histogram is a `SELECT` over `self_trade_audit_log`.
- **Manager cost** per held `EXIT_INVALIDATION` position: +1 connection read, +1 `platformStop()`, +1 arming read, then per poll one row read (primary key + 9-field tuple), one connection read and one ticket-command read; at most 20 polls; one shared deadline per `manageAgentPositions` call. Worst case +20 s on the operator's `POST /self-trade-ai/run-autonomous-cycle` request when an agent holds a protective EXIT and the EA is online but not pushing.
- Not measurable here: EA pickup and broker execution.

## 11. Tests and the guard

| Suite | Before | After | New cases |
| --- | --- | --- | --- |
| `test:self-trade-protective-domain` (new, `scripts/src/selfTradeProtectiveActionTest.ts`) | — | 441 checks | geometry edge table for BUY and SELL, adversarial intents, trigger classification, every reason has text and redacted detail, identity perturbations one field at a time, connection perturbations, micro-benchmark. Failed first with "module not found". |
| `test:self-trade-fresh-facts` | 58 | 80 | 22 `evaluateProtectiveObservation` cases (ties, sweep provenance, absent count, marker, heartbeat, 89 999 / 90 001 ms, future dating, malformed times, closed row, invalid price, command at exactly the observation). Failed first with a missing export. |
| `test:self-trade-lifecycle` | 52 | 68 | 16 seam cases from the hold: no connection row; sweep lands on poll 3 → one dispatch under `self-trade-manage` with `protective.evidence.lastSyncedAt` = new row time; price recovered → TRIGGER_CLEARED; volume halved → IDENTITY_VOLUME_CHANGED; no sweep → NO_FRESH_SWEEP with ≤ 20 sleeps; final-TP EXIT → NOT_PROTECTIVE; L2 → NOT_APPLICABLE; platform stop; manual MODIFY during the wait → waits for newer evidence; non-sweep row → NOT_FROM_SWEEP; MOVE_TO_BE → DEFERRED; heartbeat 20 s → HEARTBEAT_NOT_FRESH; pipeline refusal → claim rolled back; connection read throws → INTERNAL_ERROR; two held executions share one 20 s deadline; user kill switch. All 16 failed first (`result.protective` undefined); the 52 existing cases keep their `held === 1`, `evaluated === 0`, `managementState` `{}` assertions. |
| `test:self-trade-management-postgres` (as `claude`, disposable cluster) | 153 (150 pass, 3 skip) | 166 (162 pass, 4 skip; 163 pass, 3 skip with the benchmark enabled) | accepted EXIT and TIGHTEN_SL protective claims; row older than the evidence → NOT_NEWER with the command left `LIVE_APPROVED`; a 45 s reconciler-written row passes the ordinary claim and fails the protective one (NOT_FROM_SWEEP); marker null → SWEEP_MARKER_STALE; absent count → POSITION_ABSENT_AT_BROKER; `serverName` change → existing BRIDGE_IDENTITY_CHANGED; through-price stop → ordinary unchanged, protective STOP_THROUGH_PRICE; no-op stop → existing TARGET_CHANGED; 9-field scope on a duplicate ticket; two real row-lock races on the position row (`FOR UPDATE` held by a writer while the claim waits, waiter observed through `pg_blocking_pids`; a sweep-style commit → SENT, a reconciler-style commit → NOT_FROM_SWEEP; the writer stamps the bridge marker before the race because the claim already holds the bridge row and touching it from the writer deadlocks); opt-in benchmark. Written alongside the path rather than run red first; they depend on exports this branch adds. |
| `test:protective-action-path` (new guard + mutation fixtures) | — | pass, 32 assertions | see below |
| `ci:guards` | 88/88 | 89/89 | `check-protective-action-path` |

The guard `scripts/src/ci/check-protective-action-path.ts` (registered in `run-all.ts`) asserts, on comment-stripped text: (1) the manager invokes `runProtectiveActionPath(` after the hold is counted and before that branch's `continue`, and the ordinary `evaluatePositionObservation({` call has no `maxAgeMs`; (2) the path value-imports none of `livePositionWriter`, `demoPositionWriter`, `mt5CommandsTable`, `node:http(s)`, `../mt5/managementTargetTransport`, `../live/liveCommandPipeline`, `tradeEngine/`, calls no `fetch(`, acts only under `"self-trade-manage"`, and evaluates evidence → identity → geometry → CAS claim → dispatch in that order; (3) `claimManagementCommand` re-checks `pendingManagement?.protective` with `evaluateProtectiveObservation(` and `doesNotLoosenStop(` after `assertManagementGeometry(` and refuses on failure; (4) only the path constructs a `protective:` claim inside `pendingManagement`; (5) `POSITION_OBSERVATION_MAX_AGE_MS` stays `90_000` and `evaluateProtectiveObservation` carries no literal window; (6) the domain module imports only from `./`; (7) `manageAgentPositions(` is called only inside the `!chain.shouldPauseManagement` block; (8) `lib/selfTrade/protectiveActionPath.ts` is listed under the `self-trade-manage` Guardian rule and classified `MANAGEMENT` in `SELF_TRADE_PRODUCERS`. Verified by hand: removing either registration fails `ci:guards` (`protective-action-path` 1 violation, 88/89), and both files were restored.

## 12. Explicit limits

1. The server can prove the EA read the broker's position list after the hold; it cannot prove the terminal is on the same account at execution. `ArxManagementPreflight` re-checks login/server/trade mode before and after `PositionSelectByTicket` but is not atomic (`ArxManagementTarget.mqh:204-217`).
2. No MT5 `POSITION_IDENTIFIER` server-side (not ingested, no column, no migration). Ticket reuse across accounts is defended by the account tuple and the 9-field scope; same-account ticket reuse is not detectable.
3. `brokerServer` on rows is the company label; the MT5 server name lives in the mutable heartbeat (`routes/mt5.ts:458`) and is pinned into the claim evidence (`serverName`), not into the row.
4. "Fresh" is not "connected": an EA whose terminal lost the trade server can still push snapshots with last-known prices; the heartbeat carries no `TERMINAL_CONNECTED`. EA-side follow-up.
5. No pull: evidence arrives only when the EA pushes (10 s in v154); while it does not push the path holds, which is also when the EA would not poll a command.
6. The v131 `currentPrice` basis (bid vs ask) is not documented in the payload; the through-price rule assumes the v154 convention (BID for BUY, ASK for SELL).
7. Broker execution (slippage, requote, partial fill, a broker-side SL firing between push and pickup) is unknown until the result report; settlement comes from evidence, never from elapsed time.
8. Between the final claim and EA pickup nothing server-side can halt the command; unchanged.
9. The cycle is operator-run (`routes/selfTradeAi.ts:162`); production protective latency is bounded by how often cycles run, not by this path.
10. `_PREDATES_COMMAND` after a manual modify delays a protective EXIT by up to one sweep cadence; accepted (acting on a snapshot that ignores a human's just-sent change is worse).
11. The advisory broker-quote cross-check from the spec (symbol-keyed `getQuote`, never gating) is not implemented in this slice; the path relies on the sweep row's price only.
12. Legacy EAs without `supportsManagementTargetV1` never receive protective commands; the hold says so.
13. `SYMBOL_TRADE_STOPS_LEVEL` is unknown server-side; a stop too close to price is rejected by the broker and resolves as `REJECTED`.
14. The optional `protectiveHold` join on `GET /self-trade-ai/executions` is not implemented; holds are read from the audit route and the cycle result.
15. Hold explanations are durable in the audit log, not in `managementState`.

## 13. Cross-team follow-ups (not done here; EA and MT5 route files are owned elsewhere)

- EA: handle `POSITIONS_SNAPSHOT_REQUEST` by calling `PushSnapshots()` so a server-side request can shorten the wait through the existing ingest (no new writer).
- Ingest: compare the payload `positionId` to `ticket` and read the envelope `timestamp` with broker-time semantics.
- Heartbeat: carry `TERMINAL_CONNECTED` / `TERMINAL_TRADE_ALLOWED`.

## 14. Baseline timing failure

The pre-existing "actual concurrent cold-map manual polls complete with a one-connection pool" case (child-process timeout on this shared host) is neither waived, skipped nor re-timed by this slice; its result in each run is recorded in section 11 as observed.
