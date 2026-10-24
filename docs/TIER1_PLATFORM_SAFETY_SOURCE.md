# Tier 1: Platform Safety, one source for the safety switches

Base: `a4cea8b` (PR #39). This change covers the single-source and callers
part of Platform Safety (kill switches and trading halt, live-venue enable,
readiness, the Phase B master switch). Tier 1 is still not complete after
it, and the published scorecard has not changed.

Round 3 (branch `r3/platform-stop`, on `18b1e01` / PR #40) adds one
"platform stop" answer for the two install-wide stops and surveys the
safety-core mode and global state. See [Round 3: one platform stop](#round-3-one-platform-stop)
and [Round 3: safety-core mode and global state](#round-3-safety-core-mode-and-global-state).

## The problem

Several places could each say whether trading is stopped or allowed, and
they read the same switches in different ways:

| Switch | Stored in | How it was read before |
|---|---|---|
| Platform mode + venue enables | `global_trading_settings.platform_mode`, `demo_enabled`, `live_enabled` | About 15 files each selected the row and built their own "venue open" rule. Some upper-cased the mode and some did not. Some read the lowest id, some read `id = 1`, and some used an unordered `LIMIT 1`. |
| Platform emergency stop | `global_trading_settings.emergency_kill_switch` | `tradingHalt` (lowest id, missing → released), the envelope (`!!flag`, seeded row), `approvedTraderLiveState` (`!== false`, missing → engaged), the handshake monitor (`id = 1`, missing → not available), admin reports (`!!flag`, missing → released). The live-gates diagnostic read `kill_switch_engaged_at` instead of the flag. |
| Operator live-execution arm (+ env master switch) | `global_trading_settings.live_broker_execution_armed`, `ARX_LIVE_BROKER_EXECUTION_ENABLED` | `phaseBConfig` (unordered row), plus separate reads of the row in mode scope, unified mode, approved-trader state and admin readiness. Two routes had their own private env-helper wrappers. |
| Safety-core kill switch | `safety_core.kill_switch_engaged` | `tradingHalt`, system health (unordered row), trading readiness (raw select). |
| Trader kill switch | `arx_live_arming.kill_switch_engaged` | Written by `liveArming` and also by `/risk/pause` and `/risk/resume` in `routes/riskProfile.ts`, which did not disarm or audit. Four routes selected the arming row directly instead of calling `getMyArming`. |

## The authority

`artifacts/api-server/src/lib/safety/` is now the only reader:

- **`platformSwitches.ts`** (new) is the read authority for the install-wide switches.
  - `readPlatformSwitches({ ifMissing })` returns `PlatformSwitches`: platform mode, raw venue enables, `venueOpen.DEMO` / `venueOpen.LIVE`, the emergency stop (with reason and time), and the Phase B master switch (env, operator arm, and the effective env-AND-arm value).
  - `loadPlatformSettings()` returns the switches plus a config view with the switches removed (routing, shared master, policy flags), from one read.
  - `readSafetyCoreSwitch()` reads the safety-core kill switch. It never seeds the row.
  - `platformStop()` (round 3) returns `PlatformStop` `{ engaged, sources, reason, detail, readable }` for BOTH install-wide stops (the platform emergency stop and the safety-core kill switch). It never throws and fails closed. `preCheckStopRefusal(stop, { own, opensNewRisk, venue })` says which sources refuse a pre-check's action. `platformStopForVenue()` drops the emergency stop for PAPER.
  - `loadGlobalTradingSettingsRow()` returns the raw row and seeds it when missing. It moved here from `getGlobalSettings`, and only the audited admin writers use it. `getGlobalSettings()` in `safetyEnvelope.ts` now returns the config view without switches. Its type is `Omit<…, SwitchField>`, so the compiler rejects reading a switch from it.
- **`tradingHalt.ts`** keeps the per-trader halt (trader kill switch, frozen allocation). It reads the install-wide stops through `platformStop()` (round 3; before, it read each stop separately). It also gains `venueTradingVerdict({ userId, venue })`, the one answer to "may this venue trade now, and why not". That answer is the venue switch AND every stop switch, with reasons. It adds no gate and approves nothing.

Rules (fail closed, and the stricter source wins):

- An unreadable switch counts as engaged, and the venue counts as closed and not armed.
- A missing settings row fails closed by default. A caller that already treated a missing row differently says so explicitly:
  - `"defaults"` for `tradingHalt`, where a fresh install starts released (owner decision 2026-10-24);
  - `"seed"` for the paths that used the seeding `getGlobalSettings` (envelope, trade-action guard, readiness, cockpit).
- `global_trading_settings` has no singleton constraint, so the authority reads every row. The emergency stop is engaged if ANY row says so. A venue, a raw enable flag and the operator arm count as on only if EVERY row says so. The platform mode is the strictest mode across rows. With one row, which every normal install has, the answer is exactly that row.
- An unknown stored platform mode reads as `OFF`. The match is exact: the admin handler only writes `OFF`, `SIMULATED`, `DEMO` or `LIVE`.

## Callers moved onto the authority

- **Order-path inputs:**
  - `adminTrading/safetyEnvelope` (`getEnvelope`)
  - `tradeAction/guards` (platform-mode step)
  - `live/phaseBConfig` (`resolveLiveBrokerExecutionEnabledAsync`)
  - `live/approvedTraderLiveState`
  - `modeScope/getUserModeScope`
- **Readiness and reports:**
  - `userReadiness/engine` (now `venueTradingVerdict`)
  - `handshake/layerAdapters` (admin-control and kill-switch layers)
  - `systemHealth/health`
  - routes: `tradingReadiness`, `meAccountShell`, `meUnifiedMode`, `meReadinessSummary`, `meLiveReadiness`, `adminCockpit`, `adminLaunchReadiness`, `adminLiveGatesDiagnostic`, `adminLiveTestReadiness`, `adminOperatorCommandCenter`
  - the GET readiness and preflight handlers of `adminLiveSharedReadiness`
  - `assistant/tools` (operator summary; Ruby reads only)
- **Arm preconditions:** the live-execution arm handler in `adminLiveSharedReadiness` (`kill_released`, `platform_mode_live`, `live_enabled`) reads the authority. The raw row is still its write target and audit snapshot.
- **Config-only readers now select only config columns:** `routingResolver`, `masterLiveBridgeGate`, `operatorFundedPilotGate`, `adminMasterBridge`, `adminLiveFirstTestMode`, `adminLiveTestReadiness` (pinned bridge), and `liveCommandPipeline` (routing mode, one line).
- **Trader kill switch:** `/risk/pause` and `/risk/resume` now call `engageKillSwitchForUser` / `releaseKillSwitchForUser` in `liveArming`, its one owner. Arming-row reads in `mt5RemoteOps`, `adminLiveTestReadiness`, `adminLiveSharedReadiness` and `adminOperatorCommandCenter` use `getMyArming`. The cockpit fleet view uses the new `listArmingFlags`.
- **Env master switch:** the private wrappers in `adminMasterBridge` and `adminOperatorCommandCenter` were removed. They now use `phaseBConfig` or the authority.

## What is enforced

`single-safety-switch-source` runs in `ci:guards` (85 guards after rebase on `a4cea8b`). It uses the TypeScript AST, so it catches aliases, namespace access, the relational query API and raw SQL string literals. It fails when a runtime file outside `lib/safety/` does any of these:

1. references a `global_trading_settings` switch column through the table object;
2. reads the whole settings row (`select().from(table)` or `db.query.…`);
3. writes the settings table outside the reviewed writers;
4. references `safetyCoreTable` outside `lib/safetyCore.ts`;
5. references `arxLiveArmingTable` outside `lib/live/liveArming.ts`;
6. calls `loadGlobalTradingSettingsRow()` outside the reviewed writers;
7. calls the env helper `isLiveBrokerExecutionEnabledEnv` outside `phaseBConfig` and the boot env checklist;
8. names a switch column or the `safety_core` table in raw SQL;
9. (round 3) reads one install-wide stop's raw value on its own: `.emergencyStop` of the switches, `.emergencyKillSwitch` of a derived view such as the envelope, `readSafetyCoreSwitch()`, or `.killSwitchEngaged` in a file that imports `lib/safetyCore.ts` (static or dynamic import, so `getStatus().killSwitchEngaged`). A pre-check reads `platformStop()` + `preCheckStopRefusal()` instead. The trader's own arming kill switch (`getMyArming().killSwitchEngaged`) is not an install-wide stop and is not flagged.

The guard also fails on a stale allowlist entry (a file that no longer breaks the listed rule, or that no longer exists). It also fails if the authority loses its strict multi-row combine, its fail-closed answer, `venueTradingVerdict`, `platformStop()` (combining both reads and failing closed on both sources when a read throws), `preCheckStopRefusal()`, or if `tradingHalt.ts` stops reading `platformStop()`.

The reviewed exceptions went from 7 to 29 in round 3. The rise is the new rule 9 listing the existing single-stop readers; no rule was loosened. They are:

- audited admin writers: `adminTrading`, `adminLiveSharedReadiness`, `adminLiveSharedActivation`, `adminMasterBridge`, `adminLiveFirstTestMode` (the first three are now also listed for rule 9: their audit snapshots and the arm precondition name the emergency stop they write);
- env-flag readers: `phaseBConfig`, `startup/envChecklist`;
- rule 9, reports and readiness views that name one stop and gate no order: `safetyEnvelope` (derives the envelope field and banner), `approvedTraderLiveState`, `unifiedLiveReadiness`, `unifiedLiveReadinessDecision`, `handshake/layerAdapters`, `assistant/derivedEnvelope`, `assistant/tools`, `systemHealth/health`, `tradingReadiness`, `adminCockpit`, `adminLaunchReadiness`, `adminLiveGatesDiagnostic`, `adminLiveTestReadiness`, `adminMasterLiveAccess`, `adminOperatorCommandCenter`, `portfolio` (plan), `tradeDecision` (advisory);
- rule 9, `liveCommandPipeline`: the pure `emergencyKillSwitchBlocksDispatch()` decision names its inputs; the one call site feeds them from `platformStop()`;
- rule 9, legacy gates with no Risk Governor behind them, which keep their safety-core-only rule (see round 3): `mt5` (command endpoints), `brokerHealth` (RECONNECT), `trades` (`/execute-trade` TOCTOU re-check), `permission` (paper permission verdict).

Tests:

- `test:single-safety-switch-source` runs the guard on the real tree plus negative fixtures.
- `test:platform-switches` is a new DB test, added to `ci:integration`. It covers:
  - missing-row policies;
  - that the schema defaults match `DEFAULT_SWITCH_ROW`;
  - venue rules and the unknown-mode rule;
  - the stray-row strictest-wins rule, with the envelope agreeing;
  - `venueTradingVerdict` for the venue switch, emergency stop, safety core and trader kill switch (paper is never closed by a platform switch);
  - that the config view carries no switch;
  - (round 3) `platformStop()` for all four combinations of the two stops, with `loadPlatformHalt` and the paper `loadTradingHalt` agreeing; a missing settings row reads released and never writes; fail closed when either read throws (both sources) or reports unreadable (that source); the full `preCheckStopRefusal` matrix (own × stop × venue × opens-new-risk: never looser than the own stop, the other stop only on new risk, never the emergency stop on paper); and the trade-action guard's `kill_switch` step on a real DB.
- `test:emergency-kill-switch-gate` (round 3 additions): the dispatch pre-gate with the safety-core input across every command type, marker and stop value (never looser than the emergency rule; the safety core refuses entries only; unknown counts as engaged), and a source check that the inputs come from `platformStop()`.

## Behaviour changes (all stricter, or reports only)

1. **More than one settings row:** every reader now combines all rows strictly (see above). Before, readers picked different rows. With one row nothing changes. A stray row seeded with defaults blocks the operator arm until it is removed, because it is not armed. That is safe, but an operator has to clean it up.
2. **Unknown platform-mode casing:** `tradeAction/guards`, readiness and the account shell used to upper-case the stored value. A non-canonical value such as `live` now reads as `OFF`. The admin handler only writes the canonical values.
3. **Unreadable or missing settings now read as stopped in reports that used to show "released" or throw:** `adminCockpit`, `adminLaunchReadiness`, `adminOperatorCommandCenter`, the assistant operator summary, `meAccountShell` (now shows OFF instead of returning 500), `tradingReadiness` (unreadable safety core now gives LOCKED instead of 500), and system health (an unreadable safety core now adds a `KILL_SWITCH` hard block).
4. **`resolveLiveBrokerExecutionEnabledAsync`** now returns false on a read error instead of throwing, and it reads every row (armed only if all rows are armed).
5. **`/risk/pause` now disarms live and writes an audit event,** as the other kill-switch path always did. After `/risk/resume` the trader has to re-arm before trading live. `/risk/resume` also clears the engaged-at and engaged-by fields and is audited.
6. **The live-gates diagnostic** reports the enforced flag. Before, it reported `kill_switch_engaged_at`: it called a stop "clear" if the flag was set without a timestamp, and "engaged" if a stale timestamp remained after release. Admin readiness reports show the stop's reason and time only while it is engaged.
7. **The handshake admin-control and kill-switch layers** read the authority (all rows) instead of only the row with `id = 1`.

No tables, columns, migrations, RLS policies, Risk Governor rules or dispatch gates were changed. No order path lost a check.

### Round 3 behaviour changes (all stricter, pre-checks only)

Each pre-check below always enforced one install-wide stop (its "own" stop) and still refuses exactly what it refused before, with the same refusal code. It now also refuses when the OTHER stop is engaged, but only for actions the pre-trade Risk Governor refuses anyway on that venue (new risk; the emergency stop never halts paper; closes and stop tightening stay open at the governor). Nothing else changed. Neither stop's writers changed.

8. **Trade-action guard** (`tradeAction/guards`, step `kill_switch`): own = safety-core kill switch (every action, every mode; message unchanged). Now also refuses an `OPEN` on DEMO/LIVE while the platform emergency stop is engaged, with the message "The platform emergency stop is engaged. No new positions can be opened." plus the stop's reason. Same check id `kill_switch`. Previews (Opportunity Radar) see the same answer. It no longer seeds a missing `safety_core` row on read, and a safety-core read error now refuses at this step instead of throwing out of the guard chain.
9. **Order guard** (`adminTrading/orderGuard`, gate 4 `kill_switch`): own = platform emergency stop (every mode). An order opens new risk, so it now also refuses while the safety-core kill switch is engaged (every mode, as the governor does). Same code `EMERGENCY_KILL_SWITCH_ACTIVE`; the audit row's `guardSnapshot.platformStopSources` names the source.
10. **Live dispatch emergency pre-gate** (`liveCommandPipeline.dispatchLiveCommand`): own = platform emergency stop (every command type except the Cluster D marked close, unchanged). Now also refuses `PLACE_LIVE_MARKET_ORDER` / `PLACE_LIVE_PENDING_ORDER` while the safety-core kill switch is engaged. Same reason `LIVE_BLOCKED:EMERGENCY_KILL_SWITCH_ENGAGED`; the dispatch snapshot and audit metadata carry `platformStopSources`.
11. **Guarded close** (`POST /me/trades/close`): moved onto `platformStop()` with no change. A close opens no new risk, so only its own emergency stop refuses it, as before.
12. **Opportunity Radar labels** (`opportunityRadar/radar`): `liveOk` / `demoOk` / `tradingDisabled` and `modeSummary.emergencyKillSwitch` read `platformStop().engaged`. `liveOk` and `demoOk` already excluded the safety-core kill switch through `allowedModes`, so suggestions do not change. `tradingDisabled` and the summary flag are now also true while only the safety-core kill switch is engaged (preview labels only).

Why this cannot loosen anything: the own stop's value comes from the same authority read as before (`readPlatformSwitches` for the emergency stop, all rows, strictest wins; the canonical `safety_core` row for the kill switch), and `preCheckStopRefusal` keeps every own-stop refusal (the test matrix checks this). The envelope's `emergencyKillSwitch=true` fail-closed answer happens only when the switches are unreadable (`platformStop()` is then engaged too) or the user id is invalid (refused earlier by each path's auth step). An unreadable source, or a read that throws, counts as engaged.

## What remains

1. **Writers are reviewed, not unified.** The emergency stop is written by `adminTrading` (engage and reset, audited), by `adminLiveSharedActivation` (engage on rollback), and by the activation handler in `adminLiveSharedReadiness`. That handler releases it with `patch.emergencyKillSwitch=false` and does not clear the reason or time. That release path, and its unordered-row write target, should move to one audited `releasePlatformStop` in the authority. That needs an owner decision on whether activation may release a stop at all.
2. **Two install-wide stops: one read now (round 3), two switches still.** `platformStop()` is the one answer, and every pre-check that sits in front of the governor reads it (see round 3). What remains:
   - The two stops are still two switches with two writers (admin handlers; `lib/safetyCore.ts`). Merging them into one stored switch is out of scope here.
   - Four legacy gates keep their safety-core-only rule because no governor runs behind them, so folding in the emergency stop would add a refusal the governor never makes: `/mt5/*` command endpoints (every command is stored `BLOCKED` anyway), `/broker/reconnect`, the `/execute-trade` TOCTOU re-check, and the paper permission verdict (the emergency stop does not halt paper). Whether these should honour the emergency stop is an owner decision.
   - Readiness views (`approvedTraderLiveState.executionReady`, unified live readiness, admin reports) still name one stop each. They gate no order. Showing the combined stop there would change what the reports say.
3. **Out of scope here:** shared-master and master-bridge enables (`shared_live_trading_enabled`, `master_bridge_live_enabled`), per-user arming (`is_armed`) and user permissions. These are routing and consent facts with their own owners. The same applies to `self_trade_kill_switches` (per agent) and `protective_auto_close_settings`. Legacy `live_trading_state` stays confined by `legacy-live-state-confined`. The broker health toggles (`broker_health_state.execution_enabled`, `maintenance_mode`) already have one reader, `lib/brokerHub/brokerHealthState.ts` (guard `single-broker-state-source`, PR #36). This change does not duplicate that reader. Folding those toggles into `venueTradingVerdict` would add a new gate, so it is left for an owner decision.
4. **Bridge/EA safety and readiness truth:** surveyed in round 3 (see below). One owner, no duplicate raw readers to move. Two findings were left as they are: the EA update gate honours only the trader kill switch, and the admin EA-health preview hardcodes its stop inputs.
5. **No published score.** The scorecard rubric and its destination are still needed before a new score can be measured.

## Round 3: one platform stop

`platformStop()` reads both install-wide stops at once: the emergency stop through `readPlatformSwitches({ ifMissing: "defaults" })` and the kill switch through `readSafetyCoreSwitch()`. The missing-row rule is the governor's (a fresh install starts released). It never throws: an unreadable source is engaged, and a read that throws engages both sources (`readable=false`). The Risk Governor's `tradingHalt` (both `loadTradingHalt` and `loadPlatformHalt`) now reads it, so the governor and the pre-checks combine the stops in one place.

`preCheckStopRefusal(stop, { own, opensNewRisk, venue })` is the rule for a pre-check. The own stop refuses every action on every venue, as it did. The other stop refuses only new risk on a venue it halts, which is exactly what the governor refuses. This is why the change can only make pre-checks stricter and never stricter than the governor.

| Pre-check | Own stop | Moved? |
|---|---|---|
| `tradeAction/guards` `kill_switch` | safety core | yes (+ emergency stop on DEMO/LIVE opens) |
| `adminTrading/orderGuard` gate 4 | emergency stop | yes (+ safety core) |
| `liveCommandPipeline` emergency pre-gate | emergency stop | yes (+ safety core on entries) |
| `POST /me/trades/close` | emergency stop | yes (close: no change) |
| `opportunityRadar` labels + guard prefetch | both (envelope + `allowedModes`) | yes (labels) |
| `/mt5/*` arm middleware, `/broker/reconnect`, `/execute-trade` re-check, `/permission` | safety core | no: no governor behind them (owner decision) |

Rule 9 of the guard flags any new file that reads one stop's raw value, so a new pre-check has to read `platformStop()` or be listed with a reason.

## Round 3: safety-core mode and global state

Survey of every reader of the safety core's operational mode, global state, kill switch and MT5 link health (bridge/EA safety and readiness truth):

- **Single owner:** `lib/safetyCore.ts` owns the `safety_core` row. It is the only writer (`setOperationalMode`, `engageKillSwitch`, `resetKillSwitch`, `driveGlobalState`). It also gives the derived status through `getStatus()`: mode, global state, kill switch, `mt5LinkHealth` (from the bridge heartbeat via `brokerHub/mt5StateReader`, guard `single-broker-state-source`) and `allowedModes`. `tradeGate()` is its own choke point.
- **One read-only copy in the authority:** `readSafetyCoreSwitch()` in `lib/safety/platformSwitches.ts` reads the same canonical row (lowest id) without seeding: kill switch, mode, state. Its consumers are `platformStop()`, system health and the advisory trading-readiness label.
- **No other raw reader.** Guard rule 4 confines `safetyCoreTable` to the owner (the authority is exempt), and rule 8 catches raw SQL on `safety_core`. Every other consumer goes through `getStatus()`: `mt5`, `brokerHealth`, `trades`, `tradeDecision`, `executionConfirmations`, `system`, `permission`, `portfolio`, `liveTrading/readiness`, `paperIntelligence` and `opportunityRadar`. `mt5LinkHealth` is computed only in `getStatus()`. Nothing needed to move, so no behaviour changed here.
- **Not the safety core:** `lib/security/operationalMode.ts` is a separate security posture switch (`security_settings.operational_mode`: NORMAL / LOCKDOWN / INCIDENT) with its own audited owner. It shares only the word "mode".
- **Findings left as they are (owner or other-domain decisions):**
  - The EA self-update gate (`routes/mt5RemoteOps.ts`, `evaluateEaUpdateGate`) blocks on the trader's own kill switch only, not on the install-wide stops. An EA update is not an order and no governor runs behind it, so adding the stops would be a new gate.
  - ~~The admin EA-health view (`routes/adminEaHealth.ts`) previews the same gate with `killSwitchEngaged: false` and `maintenanceMode: false` hardcoded. Its preview can therefore say "update allowed" where the EA's real check (`mt5RemoteOps`) blocks.~~ **Fixed in round 4 (Broker State, `r4/bridge-freshness-source`).** Both the real check and the admin preview now get their safety inputs from one loader, `lib/mt5/eaUpdateGateInputs.ts`. The inputs are the trader's kill switch (`liveArming.getMyArming`), the per-trader `ea_remote_config.maintenance_mode` (the real gate's maintenance source, not `broker_health_state`), an open LIVE position, any in-flight live command, and the 15 s heartbeat window. The preview also used to hardcode `hasOpenLiveTrade: false`, looked only at the latest command, and used the watchdog's liveness instead of the gate's heartbeat window. Those inputs now match the real check as well. The gate itself is unchanged: it makes the same reads in the same order. It still does not read the install-wide stops (owner decision above). Test: `test:ea-update-gate-inputs` (`ci:integration`).
  - ~~Heartbeat freshness thresholds are repeated: `safetyCore` uses 15 s / 60 s, `paperIntelligence` 15 s, and `brokerHub/mt5ReadOnlyAdapter` 60 s.~~ **Moved in round 4.** The thresholds are now named in `lib/brokerHub/freshness.ts` and enforced by guard `single-bridge-freshness-source`. No value changed. See `docs/TIER1_BROKER_HUB_SOURCE.md`, "Round 4".

## Honest limits

- The guard is static source analysis. It closes the ways a raw switch value enters a file (column refs, whole-row reads, the raw loader, raw SQL), but it does not track a row object passed in from an allowlisted writer.
- An allowlist entry records a reviewed path. It does not prove that path is correct.
- Rule 9 is name-based: it flags `.emergencyStop`, `.emergencyKillSwitch`, `readSafetyCoreSwitch` and, in files that import the safety core, `.killSwitchEngaged`. A stop value copied into a differently named field and passed to another file is not tracked.
- `preCheckStopRefusal` adds the other stop only for actions that open new risk. Pre-checks pass `opensNewRisk` from their own action classification (`RG_CLASSIFY.OPENS_NEW_RISK`; live entry command types; orders). A widening stop modify is still refused only by the governor.

**TIER 1 NOT COMPLETE**
