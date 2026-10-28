# Self-trading emergency stops and kill switches — 2026-10-27

Branch `claude/self-trading-killswitch`, cut from `5767ec5`. Offline work only. Trading stays disabled. No worker, setting or flag was changed. No broker, demo or network order test was run. No existing database was touched, and there is no schema migration: the only PostgreSQL used was the disposable Unix-socket clusters the test runners create. This document covers the server. The terminal side is listed under remaining gaps.

## 1. The stops that exist

| Stop | Where it is stored | Who changes it | What it halts | If it cannot be read |
|---|---|---|---|---|
| **Platform emergency stop** | `global_trading_settings.emergency_kill_switch`, read through `lib/safety/platformSwitches.platformStop()` | admin `POST /api/admin/trading/emergency-kill` | Every LIVE command type at dispatch. The only exception is a CLOSE that carries the admin emergency-close marker (Task #743 Cluster D). | Treated as engaged: `platformStop()` catches the error and reports both sources engaged |
| **Safety-core kill switch** | `safety_core` (same `platformStop()` read) | Safety Core | LIVE **entries** at dispatch. The Risk Governor applies it on every venue as "new risk only". | Treated as engaged |
| **Per-user kill switch** (gate #5) | `arx_live_arming.kill_switch_engaged` | trader / admin | Every LIVE command except the Cluster D admin CLOSE (Phase B gate `KILL_SWITCH_ENGAGED`). The Risk Governor halt applies it as new risk only. | The Risk Governor halt reads it as `"unreadable"` and counts it as engaged |
| **Self-trade kill switches** | `self_trade_kill_switches` (GLOBAL / NEWS / AGENT / STRATEGY / SYMBOL) | admin `POST /admin/self-trade-ai/kill-switch` → `service.toggleKillSwitch` | Autonomous agent **entries** only (see §3) | Treated as engaged at every check point (§4, gaps 2–4 fixed) |
| **Operational mode** LOCKDOWN / INCIDENT | security operational mode (`getOperationalMode`) | admin | New autonomous entries (`autonomousCycle` step 3a). Protective management still runs. | An unknown mode resolves to INCIDENT upstream (entries paused) |
| **Allocation freeze / close-only / risk locks** | `user_slot_allocation`, `risk_locks` | operator | `tradingFrozen`, close-only mode and risk locks block entries. `allocationStatus='frozen'` blocks everything. | Risk Governor halt: `"unreadable"` counts as engaged. The dispatch pre-gate reads the row directly, and a throw there aborts dispatch. |
| **Broker controls** (`execution_enabled`, maintenance) | `broker_health_state` | Broker Hub | New risk on DEMO and LIVE (Risk Governor) | See `loadBrokerControlHalt` |
| **Server live switch** | `ARX_LIVE_BROKER_EXECUTION_ENABLED`, plus venue-open / `liveApproved` in the safety envelope | deployment / operator | Every LIVE dispatch (Phase B) | Default deny |

All four stop families can only add a refusal. None of them can permit an order on its own.

## 2. Inventory: every code path that creates, changes or dispatches a broker command

Every LIVE path ends in `liveCommandPipeline.dispatchLiveCommand` (`check-trade-engine-single-pipeline`). Inside it, the platform-stop pre-gate (`:2599`), the Risk Governor (`:3779`, which carries the halt) and the Phase B evaluator (`:3919`, gate #5) all run before the compare-and-set claim `claimLiveCommandForDispatch` (`:4143`). Line numbers refer to this branch. "SELF-TRADE KS" means the self-trade kill switches.

| # | Path (entry point) | Command | SELF-TRADE KS checked where | Platform stops / per-user KS / Risk Governor halt | KS read failure |
|---|---|---|---|---|---|
| 1 | Autonomous agent entry: `autonomousCycle` → `agentExecutor.executeAgentDecision` → `submitInstantTrade` → `executeInstant` → `createLiveDraft` (`createAgentEntryDraft`) → confirm → `dispatchLiveCommand` | PLACE_LIVE_MARKET/PENDING | (a) pre-decision: `decisionEngine` reads GLOBAL only, as advice. (b) `executionGate.evaluateAgentExecution:172`, all scopes, as the decisive block code. (c) executor TOCTOU `agentExecutor:364`, after reservation (`:344`) and before submission (`:422`). (d) **new:** draft, confirm and the final dispatch claim, inside `withEntryAuthority:260-270` under locks | All of them at dispatch. Operational-mode pause runs before (b). | (a) **fixed**: engaged. (b) throws, so nothing is reserved or sent. (c) **fixed**: BLOCKED `KILL_SWITCH_UNREADABLE` and the slot is released. (d) **new**: the transaction rolls back, nothing is claimed, `LIVE_BLOCKED` |
| 2 | Agent PREPARE_ONLY draft confirmed later by a person: `POST /me/live/commands/:commandId/confirm` + `/dispatch` (`routes/meLive.ts:254,261`) → `claimLiveCommandForConfirm` / `claimLiveCommandForDispatch` → `claimAgentCommand` | entry | **new:** at the confirm claim and at the final claim (`withEntryAuthority`). Before this change it was never re-read. | All of them at dispatch | **new:** refusal, nothing claimed |
| 3 | Agent management MOVE_TO_BE / TIGHTEN_SL / EXIT: `livePositionManager:341` → `guardianInstantManage` → `executeInstant` (ops) → `createLiveOpsDraft` → dispatch → `claimManagementCommand` | MODIFY_LIVE_SLTP / CLOSE_LIVE_POSITION | **Not checked, by design.** These actions only reduce risk (§3). | Emergency stop **blocks** them (no admin marker). Safety-core does not. Per-user KS blocks them. The Risk Governor halt allows closes and stop tightening. | n/a |
| 4 | Manual one-click: `routes/instantTrade`, `routes/meOneClick` → `submitInstantTrade` / staged contract | entry, close, modify | n/a (not an agent command) | All of them | Platform stop: treated as engaged |
| 5 | Manual staged: `routes/meLive`, `routes/tradesLiveShared` (draft / confirm / dispatch) | entry, close, modify | n/a | All of them | same |
| 6 | Manual position ops: `routes/livePositions`, `routes/meTrades`, `lib/tradeAction/route` → `submitTrade` → `governedOps` | close, modify | n/a | All of them | same |
| 7 | Assistant / Ruby: `routes/meAssistant:1731` → `submitInstantTrade` | entry, close | n/a (Ruby is AI_ASSISTED and needs the user's confirmation) | All of them | same |
| 8 | Mission: `missionExecution` → `submitInstantTrade`. Mission exit: `missionExitManager:777` → `guardianInstantManage` | entry / close | n/a. Mission is not a self-trade agent. | All of them | same |
| 9 | Position Guardian exit door: `positionGuardian/manage` → `submitInstantTrade` / `submitTrade` MODIFY | close / restore stop | n/a | All of them | same |
| 10 | Admin emergency close: `lib/live/emergencyClose:140` (staged OPS with the Cluster D marker) | CLOSE | n/a | Exempt from the emergency stop and per-user KS **only** for this marked CLOSE. Every other gate runs. | — |
| 11 | Operator live test cycle: `lib/live/liveTestCycle` (staged) | entry + close | n/a | All of them | same |
| 12 | DEMO queue: `routes/meDemoCommands` → `demoCommandQueue`; consumer `demoCommandConsumer` | demo order | n/a (agents are LIVE or SHADOW only) | Risk Governor halt (`loadTradingHalt`: platform stops, trader KS, allocation) when the command is consumed | Halt sources unreadable → engaged |
| 13 | Legacy `mt5_commands` writers: `routes/mt5.ts:1466` (always stored BLOCKED), `routes/brokerHealth` (RECONNECT, non-trading), `routes/meMt5Commands` (SAFE_ACTIONS allow-list), `tradeEngine/legacyDemoClose` (DEMO close, governor-checked) | non-trading / DEMO close | n/a | as noted | — |
| 14 | Bridged mailbox mirror after a claim: `enqueueBridgedMt5Command` (`:4766`) and the EA poll `pickupNextLiveCommand` | the already-claimed command | **none** | **none.** Runs after the hand-off. | see §6 |
| 15 | Settlement outbox recovery worker (`RESULT_SETTLEMENT_OUTBOX.md`) | none: allow-listed server state only | n/a | n/a. It sends no orders. Default OFF. | — |
| 16 | Retries | No automatic resend exists. `stuckCommandWatchdog` only marks commands failed or stale. Unknown outcomes stay held. | — | — | — |
| 17 | Operator CLI scripts (`src/scripts/*`) | as invoked | n/a | Go through `dispatchLiveCommand` | — |

## 3. Halt semantics (taken from code and docs, not assumed)

- **Self-trade kill switches stop agent entries only.** Sources: `SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md` ("Pausing an agent does not make this entry-only rule block protective management"), `autonomousCycle` step 2b ("Protective actions … ALWAYS still run"), and `livePositionManager` ("Risk-reducing actions are allowed under a kill switch"). MOVE_TO_BE and TIGHTEN_SL can only move a stop toward price (`positionManagement.ts`: "A protective stop is never relaxed"; `stopAtLeastAsProtective`). EXIT closes the position. The Risk Governor independently allows closes and known-stop tightening under a halt (`preTrade.evaluatePreTradeRisk`).
- **The platform emergency stop is stricter on purpose.** It refuses CLOSE and MODIFY as well, including autonomous management and a trader's own close. The one exception is the integrity-hashed admin emergency-close CLOSE. This is the documented design (`emergencyKillSwitchPreGate.test.ts`, "the ONLY exemption"), and it is unchanged here. Under an emergency stop, an operator must flatten positions through admin emergency close.
- **Matching** (`killSwitchScope.evaluateKillSwitchRows`, the only copy of the rules):
  - Precedence is GLOBAL > NEWS > MALFORMED > AGENT > STRATEGY > SYMBOL.
  - GLOBAL and NEWS always cover. NEWS has no symbol scoping.
  - AGENT matches the agent key. STRATEGY matches the decision's `setupType`. SYMBOL matches the canonical decision symbol or the broker-native command symbol.
  - Both sides are trimmed and upper-cased. Broker suffixes are never guessed: `EURUSD` does not cover `EURUSD.r` unless that spelling is passed.
  - An **engaged** row with an unknown or mis-cased scope, or a targeted scope with an empty ref, blocks every agent entry as `KILL_SWITCH_MALFORMED`.
  - `engaged` is the only truth. The table has no expiry column, and `engagedAt` / `releasedAt` never release a switch, so a "future-dated" or "stale" engaged row still blocks.
- **Linearization.** The final claim takes `pg_advisory_xact_lock_shared(213000213)` before it reads the switches. `toggleKillSwitch` takes the exclusive lock first in its transaction. If an engage commits first, the claim refuses. If a claim commits first, it is a completed hand-off: a later engage cannot un-send it. Lock order: agent → settings → ledger → decision → execution → kill lock → command. `toggleKillSwitch` takes no agent lock, so the two cannot deadlock. Two statements are needed: in READ COMMITTED, a single statement's snapshot predates its own lock wait.

## 4. Gaps found and fixed

| # | Gap (file:line before the fix) | How to reproduce | Fix | Commit |
|---|---|---|---|---|
| 1 | `killSwitchGate.ts:61-71` (base) compared scopeRef case- and whitespace-sensitively. An unknown or empty-ref engaged row matched nothing, so it failed open. | Engage SYMBOL `" eurusd "`, or a row with scope `global`, and evaluate an EURUSD entry: `killed=false`. The new suite showed 5 of 16 tests failing. | Shared matcher with normalization and fail-closed MALFORMED | `95ad7d5` |
| 2 | The dispatcher never re-read self-trade switches. `entryAuthority.withEntryAuthority` (base `:122-249`) had no kill read, so a PREPARE_ONLY draft could be confirmed after an AGENT/SYMBOL halt. A switch engaged after the executor's TOCTOU read did not stop the final claim. | Stage or approve an agent command, engage AGENT `alpha`, then call `claimLiveCommandForConfirm` / `claimLiveCommandForDispatch`: the command reached `SENT_TO_MT5_LIVE`. 14 of 16 new PG tests failed. | Kill read inside the locked authority transaction for draft, confirm and claim, plus the advisory lock | `bb1bd7d` |
| 3 | Executor TOCTOU read failure (`agentExecutor.ts:355` at base). The throw escaped, leaving a `PENDING_TICKET` row with no command. Reconciliation can never resolve such a row, so the agent's slot leaked and nothing was audited. | Make `assertAgentNotKilled` throw after reservation: the row stays `PENDING_TICKET` with `commandId=null`. | Catch, block as `KILL_SWITCH_UNREADABLE`, audit `EXECUTION_BLOCKED_TOCTOU`, release the slot (non-submission is certain) | `91c6502` |
| 4 | `decisionEngine.ts:484` (base): `globalKillEngaged().catch(() => false)` made the advisory decision feed fail open. No order could follow, because (b) and (d) still refuse. | Found by reading the code. The `catch` returns `false` and `killEngaged` feeds `buildCandidate`. The fix is pinned by a source-level guard assertion that failed before it; no behavioural decision-cycle test was written (that cycle is not test-harnessed offline). | `.catch` logs and returns `true` (engaged) | `70463b5` |

## 5. Tests and guards (exact counts on this branch)

| Suite | Before | After | Notes |
|---|---:|---:|---|
| `api-server test:self-trade-kill-switch-scope` (offline, new, in root `ci`) | 0 | **19** | matcher, reader, monotonicity (2,000 generated cases), pre-decision read engage and failure |
| `scripts test:self-trade-kill-switch-coverage` (offline, new, in root `ci`) | — | guard + **34** mutation assertions | each assertion fires when the code it guards is mutated |
| `pnpm run ci:guards` | 87 | **88** | new `self-trade-kill-switch-coverage`. The run needs `DATABASE_URL=postgres://nobody@127.0.0.1:1/none`; that requirement predates this work. |
| `api-server test:self-trade-entry-postgres` (disposable PG) | 73 | **91** | +9 claim-time scope cases, no over-blocking, PREPARE_ONLY confirm, draft refusal, read failure at claim, engage-while-claim-waits, toggle-waits-behind-claim, manual unaffected, executor TOCTOU engaged and read failure |
| `api-server test:emergency-kill-switch-gate` | 9 | 9 | unchanged, passing |
| `scripts test:self-trade-safety-audit` | 61 | 61 | unchanged, passing |
| `api-server test:self-trade-lifecycle` | — | 44 pass | regression |
| `api-server test:self-trade-accounting-postgres` | 37 (34 pass, 3 skipped) | same | regression |
| `api-server test:result-evidence-postgres` | — | 32 (30 pass, 2 skipped) | regression |
| `api-server test:self-trade-management-postgres` | 107 (103 pass, **1 fail**, 3 skipped) | same failure | Already failing at the base commit: "actual concurrent cold-map manual polls complete with a one-connection pool". On this loaded host the file finishes in about 56 s against its 60 s runner budget, so some runs, **with or without** these changes, hit the timeout. Per-test timings showed no systematic difference. None of its code paths changed. |

Not run: the full root `ci` aggregate and the other integration-lane suites.

## 6. Remaining gaps and limits

1. **Commands already handed off cannot be halted server-side.** After the final claim (`SENT_TO_MT5_LIVE`), neither delivery path re-reads any stop: the `arx_live_commands` poll (`pickupNextLiveCommand`) and the bridged `mt5_commands` mirror. A command engaged-against after its claim stays deliverable until the EA picks it up or the 60 s live TTL sweeps it (the mirror row until the watchdog marks it stale). Once the terminal holds it, nothing on the server can stop it. A pickup-time platform-stop refusal for ENTRY commands would shorten this window. It needs an owner decision on status and reconciliation semantics, and it touches the delivery path, so it was not done here.
2. **The emergency stop also blocks protective management.** This is by design (§3), but it means autonomous MOVE_TO_BE / TIGHTEN_SL / EXIT are refused during an emergency stop. Only the admin emergency close can reduce exposure then.
3. **The executor pre-decision gate does not block on governor `UNKNOWN`.** This happens when `loadPlatformHalt()` throws past `platformStop()`'s own catch, which should be unreachable. `executionPermission` blocks only LOCKED or hard blocks. Dispatch re-reads the platform stop and fails closed, so this is defence in depth only. Not changed.
4. **`decisionEngine` reads GLOBAL only**, not NEWS or malformed rows. Those decisions can be persisted APPROVED and are then refused by the executor gate and the claim. The feed is less informative but stays safe. Not changed.
5. **Executor TOCTOU fix limit.** If the database is so far down that the BLOCKED write itself fails, the executor still throws and the slot stays held. That is fail-closed and needs manual repair.
6. **Self-trade switches cover LIVE agent entries only.** SHADOW agents never dispatch, and agents never use DEMO. The switch has no meaning for manual, Mission or assistant orders; use the platform stop or the per-user kill switch for those.
7. **Not traced end to end (unverified):** whether a per-user `user_trading_permissions.trading_mode` demotion alone (LIVE→DEMO with `live_approved` still true) refuses Phase B dispatch. Live dispatch reads the envelope's `globalLiveEnabled` / `userLiveApproved`, the activation gate and `ARX_LIVE_BROKER_EXECUTION_ENABLED`.
8. Mixed-version rollouts: an older API process does not take the kill lock and does not re-read switches at the claim. Every writer must run this code before the guarantee holds.

## 7. Latency of the changed hot path

`pnpm --filter @workspace/api-server benchmark:self-trade-kill-switch-claim` (disposable PG, `withEntryAuthority` with a no-op operation, 2,000 interleaved iterations after 200 warm-up, A/B against a copy of the pre-change module). The host was loaded: other agents were running suites at the same time. Milliseconds, two runs:

| Scenario | Version | median | p95 | p99 | max |
|---|---|---:|---:|---:|---:|
| no engaged switches, run 1 | previous | 6.599 | 12.283 | 20.754 | 71.405 |
| | current | 7.265 | 14.293 | 20.874 | 41.802 |
| 50 engaged non-covering, run 1 | previous | 6.120 | 10.524 | 19.050 | 71.384 |
| | current | 6.926 | 12.089 | 19.157 | 49.748 |
| no engaged switches, run 2 | previous | 7.024 | 10.239 | 15.520 | 84.096 |
| | current | 7.847 | 11.580 | 18.154 | 44.967 |
| 50 engaged non-covering, run 2 | previous | 7.146 | 11.034 | 18.408 | 56.851 |
| | current | 8.106 | 12.404 | 18.882 | 39.389 |

The cost is about +0.7–1.0 ms median and +1.3–2.0 ms p95: two extra round trips (shared lock, then the engaged-row read). It runs once per agent draft, confirm and final claim, never for manual or protective commands. These are local numbers only, not a production or broker latency claim.
