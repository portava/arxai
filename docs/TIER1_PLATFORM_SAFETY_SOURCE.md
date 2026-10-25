# Tier 1: Platform Safety, one source for the safety switches

Base: `a4cea8b` (PR #39). This change covers the single-source and callers
part of Platform Safety (kill switches and trading halt, live-venue enable,
readiness, the Phase B master switch). Tier 1 is still not complete after
it, and the published scorecard has not changed.

Round 3 (branch `r3/platform-stop`, on `18b1e01` / PR #40) adds one
"platform stop" answer for the two install-wide stops and surveys the
safety-core mode and global state. See [Round 3: one platform stop](#round-3-one-platform-stop)
and [Round 3: safety-core mode and global state](#round-3-safety-core-mode-and-global-state).

Round 4 (branch `r4/safety-readers-and-engage`, on `04a197e` / PR #45) moves
the reports and readiness views onto `platformStop()` and gives the
emergency stop one engage writer. See [Round 4: reports on the platform stop, one engage writer](#round-4-reports-on-the-platform-stop-one-engage-writer).

Round 5 (stacked branches `r5/safety-1..4`, on `2a0b3f6` / PR #48) implements
the owner's Platform Safety decisions 1–5 and 19 (2026-10-25). Those
decisions allow the behaviour changes listed there and nothing else. See
[Round 5: owner decisions](#round-5-owner-decisions).

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
  - `platformStopWith(switches)`, `stopSourceEngaged(stop, source)`, `platformStopReport(stop)` and `readSafetyCorePosture()` (round 4) are what a report uses: the platform stop for switches it already read (its own missing-row rule kept), a labelled per-source flag taken from that answer, the combined fields it adds, and the safety core's mode and state without its kill switch.
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
9. (round 3) reads one install-wide stop's raw value on its own: `.emergencyStop` of the switches, `.emergencyKillSwitch` of a derived view such as the envelope, `readSafetyCoreSwitch()`, or `.killSwitchEngaged` in a file that imports `lib/safetyCore.ts` (static or dynamic import, so `getStatus().killSwitchEngaged`). A pre-check reads `platformStop()` + `preCheckStopRefusal()` instead; a report reads `platformStop()` / `platformStopWith()` (round 4). The trader's own arming kill switch (`getMyArming().killSwitchEngaged`) is not an install-wide stop and is not flagged.
10. (round 4) writes an ENGAGED emergency stop anywhere but `lib/safety/platformStopWriter.ts`: an `emergencyKillSwitch` property whose value is not the literal `false` in a `.set()` / `.values()` object (spreads of object literals and shorthand included), or `<x>.emergencyKillSwitch = <not false>` (property or element access, so a patch object built up and passed to `.set()` is caught); and a call to `engagePlatformStop()` from a file that does not write `admin_action_audit_log`. Release writes (`false`) are not this rule.

The guard also fails on a stale allowlist entry (a file that no longer breaks the listed rule, or that no longer exists). It also fails if the authority loses its strict multi-row combine, its fail-closed answer, `venueTradingVerdict`, `platformStop()` (combining both reads and failing closed on both sources when a read throws), `preCheckStopRefusal()`, or if `tradingHalt.ts` stops reading `platformStop()`. Round 4 adds the same kind of check for the engage writer: it must exist, export `engagePlatformStop()`, update `global_trading_settings` with no `.where()` (every row) and set `emergencyKillSwitch: true`, `killSwitchEngagedAt`, `killSwitchReason` and `updatedByAdminId`.

The reviewed exceptions went from 7 to 29 in round 3 (the new rule 9 listing the existing single-stop readers) and from 29 to 15 in round 4: 15 reports and readiness views moved onto `platformStop()` and left the list, and the engage writer was added. No rule was loosened. They are:

- the engage writer `lib/safety/platformStopWriter.ts` (rule 3 only: it is the one place an engaged emergency stop is written);
- audited admin writers: `adminTrading`, `adminLiveSharedReadiness`, `adminLiveSharedActivation`, `adminMasterBridge`, `adminLiveFirstTestMode` (the first three are also listed for rule 9: their audit snapshots, the arm precondition and the activation handler name the emergency stop they write; they engage it only through the writer);
- env-flag readers: `phaseBConfig`, `startup/envChecklist`;
- rule 9, `safetyEnvelope` and `assistant/derivedEnvelope`: the envelope's labelled `emergencyKillSwitch` field and its early return. The envelope's `tradingMode` / `allowOrderExecution` feed the order guard and the live pipeline, so folding the safety core in there would add a gate refusal (see What remains);
- rule 9, `liveCommandPipeline`: the pure `emergencyKillSwitchBlocksDispatch()` decision names its inputs; the one call site feeds them from `platformStop()`;
- rule 9, legacy gates with no Risk Governor behind them, which keep their safety-core-only rule (see round 3, owner decision): `mt5` (command endpoints), `brokerHealth` (RECONNECT), `trades` (`/execute-trade` TOCTOU re-check), `permission` (paper permission verdict).

Tests:

- `test:single-safety-switch-source` runs the guard on the real tree plus negative fixtures.
- `test:platform-switches` is a new DB test, added to `ci:integration`. It covers:
  - missing-row policies;
  - that the schema defaults match `DEFAULT_SWITCH_ROW`;
  - venue rules and the unknown-mode rule;
  - the stray-row strictest-wins rule, with the envelope agreeing;
  - `venueTradingVerdict` for the venue switch, emergency stop, safety core and trader kill switch (paper is never closed by a platform switch);
  - that the config view carries no switch;
  - (round 4) `platformStopWith()` keeps the caller's missing-row rule (a fail-closed view still reads "settings missing", a defaults view reads released) and adds the safety core; `platformStopReport()` / `stopSourceEngaged()` / `readSafetyCorePosture()`; `buildApprovedTraderLiveState` for all four stop combinations (`emergencyKillSwitch` names only the emergency stop, `platformStopEngaged` / `platformStopSources` say both); `engagePlatformStop()` engages every row of a two-row table with one reason, time and actor, rolls back with a caller's transaction, and throws when there is no row;
  - (round 3) `platformStop()` for all four combinations of the two stops, with `loadPlatformHalt` and the paper `loadTradingHalt` agreeing; a missing settings row reads released and never writes; fail closed when either read throws (both sources) or reports unreadable (that source); the full `preCheckStopRefusal` matrix (own × stop × venue × opens-new-risk: never looser than the own stop, the other stop only on new risk, never the emergency stop on paper); and the trade-action guard's `kill_switch` step on a real DB.
- `test:unified-live-readiness` (round 4): each stop source gives its own blocker; with only the safety core engaged `emergencyKillSwitch` stays false and `platformStopEngaged` is true.
- `test:single-safety-switch-source` (round 4): rule 10 fixtures (engage write in a reviewed writer, spread, shorthand, patch object, element access, insert, unaudited caller; a release, a report object and the writer itself pass) and the writer-shape check (every row, reason, actor).
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

Why this cannot loosen anything (round 3): the own stop's value comes from the same authority read as before (`readPlatformSwitches` for the emergency stop, all rows, strictest wins; the canonical `safety_core` row for the kill switch), and `preCheckStopRefusal` keeps every own-stop refusal (the test matrix checks this). The envelope's `emergencyKillSwitch=true` fail-closed answer happens only when the switches are unreadable (`platformStop()` is then engaged too) or the user id is invalid (refused earlier by each path's auth step). An unreadable source, or a read that throws, counts as engaged.

### Round 4 behaviour changes (reports more truthful, one engage writer; no gate loosened)

Reports and readiness views now name both install-wide stops. Every per-source field a client parses keeps its meaning (`emergencyKillSwitch`, `killSwitchActive`, `killSwitchEngaged`, `killSwitchReason`, `killSwitchEngagedAt` still describe the platform emergency stop, from the same switches read as before); the views add `platformStopEngaged`, `platformStopSources` and (admin reports) `platformStopReason`.

13. **`approvedTraderLiveState`** (`/me/live-readiness` `liveState`, the master live-access views, the cockpit trader view, mode scope): adds `platformStopEngaged` / `platformStopSources`. `executionReady` / `canPlaceRealMoneyTrades` is now false, with the new code `SAFETY_CORE_KILL_SWITCH_ENGAGED`, while only the safety-core kill switch is engaged (the Risk Governor refuses those orders anyway). It is a readiness view: the activation gate it also exports does not read the stop. One extra `safety_core` read per call. The dashboard's reason copy (`liveSharedReasonCopy`, `structuredRejection`) gets a sentence for the new code; before, it would have shown the generic "Trade blocked by safety checks".
14. **Unified live readiness** (`/me/live-readiness/unified`, the live preflight's observation log): adds the blocker `SAFETY_CORE_KILL_SWITCH_ENGAGED` and `platformStopEngaged`; `killSwitchClear` / `liveExecutionActive` / `liveEntryEligible` are false while either stop is engaged. The decision's input is now `platformStopSources` (the output's `emergencyKillSwitch` is derived from it). The preflight only logs this record; dispatch is unchanged.
15. **Handshake KILL_SWITCH layer:** FAIL while either stop is engaged ("safety-core kill switch engaged" detail added); NOT_AVAILABLE when the safety core cannot be read. Advisory only.
16. **Ruby's launch-readiness summary** (`assistant/tools`): adds the blocker `SAFETY_CORE_KILL_SWITCH_ENGAGED` (verdict BLOCKED) and the combined fields in `systemStatus`.
17. **Trading readiness label** (`/trading-readiness`): the platform emergency stop now also makes the label LOCKED ("Platform emergency stop engaged"). Advisory; its header says it never gates.
18. **Admin reports:** cockpit overview `safety`, launch readiness `safety`, operator command center `safetyControls`, live-test readiness `panelB_masterLiveGates`, the master live-access trader view and the live-shared readiness `globalSwitches` add the combined fields. The live-gates diagnostic adds a `safety_core_kill_switch` row. The two controlled dry runs (live-test readiness preflight / T015 status, live-shared test-connection; nothing is submitted) now show the kill-switch gate failing while either stop is engaged.
19. **Portfolio plan** (`POST /portfolio/plan`, advisory): frozen while either stop is engaged (before: the safety core only); the freeze reason names the source. A safety-core read error still freezes it.
20. **Trade-decision orchestrator** (advisory, places nothing): the safety-core kill switch still adds the blocker; the platform emergency stop adds a warning (it halts broker entries, not the paper simulator this orchestrator defaults to), which raises the risk score by 10. A safety-core read error now adds the blocker instead of only a warning.
21. **System health:** no change in output. Its `KILL_SWITCH` hard block reads the stop as it applies to PAPER (this report covers the paper stack, which the emergency stop does not halt), so it is the safety-core kill switch, as before.
22. **One engage writer.** `engagePlatformStop({ reason, actorUserId, source })` in `lib/safety/platformStopWriter.ts` engages the stop on EVERY settings row with one timestamp, the given reason (stored exactly as the caller passed it) and the actor (`updated_by_admin_id`), and logs the source. The three engage paths call it with their audit events unchanged: `POST /admin/trading/emergency-kill` (`ENGAGE_KILL_SWITCH`), `POST /admin/live-shared/kill-switch` (`ADMIN_ENGAGED_LIVE_SHARED_KILL_SWITCH`, still in one transaction with its audit row and its shared-posture write) and `POST /admin/live-shared/rollback` (`ADMIN_LIVE_SHARED_ROLLBACK`, still in one transaction with its posture write and command cancellation). The live-shared kill switch was a third engage path the round 3 doc did not list. Differences:
    - before, `emergency-kill` and `kill-switch` wrote one row (the canonical row, and an unordered first row); they now write every row. With one row nothing changes. The reader already said "engaged" when any row did, so the read answer is unchanged.
    - the rollback and the live-shared kill switch now also record the actor in `updated_by_admin_id` (they did not before).
    - with more than one settings row, `POST /admin/trading/reset-kill` still releases only the canonical row (the release paths were not touched, owner decision), so after an engage the stop stays engaged until the stray row is removed. That is stricter, and an operator has to clean the stray row up, as with behaviour change 1.

Why this cannot loosen anything (round 4): every per-source field is taken from `platformStopWith()` over the same switches read as before, so its value is unchanged; the combined fields and blockers only add "stopped" answers. The engage writer sets the same three columns the handlers set, on at least the rows they set. No pre-check, Risk Governor rule, dispatch gate, release path or legacy gate changed.

## What remains

1. ~~**Engage is unified, release is not.**~~ **Done in round 5 (owner decision 1).** Release is one operation, `releasePlatformStop()`, and live activation no longer releases a stop. See [Round 5](#round-5-owner-decisions).
2. **Two install-wide stops: one read now (round 3), two switches still.** `platformStop()` is the one answer, and every pre-check that sits in front of the governor reads it (see round 3). What remains:
   - The two stops are still two switches with two writers (admin handlers; `lib/safetyCore.ts`). Merging them into one stored switch is out of scope here.
   - ~~Four legacy gates keep their safety-core-only rule.~~ **Round 5 (decision 3):** `/mt5/*`, `/broker/reconnect` and the paper permission verdict are action-aware. Left: the `/execute-trade` TOCTOU re-check, which owner decision 14 retires in another change (its caller migration and refusal are not part of this work).
   - Readiness views and reports read `platformStop()` (round 4). ~~Left on one stop: the safety envelope.~~ **Round 5 (decision 4):** the envelope reports both stops and derives new-risk permission from them; `emergencyKillSwitch` keeps naming the emergency stop. Ruby's projection keeps its OpenAPI-pinned shape (no combined field added there).
3. **Out of scope here:** shared-master and master-bridge enables (`shared_live_trading_enabled`, `master_bridge_live_enabled`), per-user arming (`is_armed`) and user permissions. These are routing and consent facts with their own owners. The same applies to `self_trade_kill_switches` (per agent) and `protective_auto_close_settings`. Legacy `live_trading_state` stays confined by `legacy-live-state-confined`. The broker health toggles (`broker_health_state.execution_enabled`, `maintenance_mode`) already have one reader, `lib/brokerHub/brokerHealthState.ts` (guard `single-broker-state-source`, PR #36). This change does not duplicate that reader. ~~Folding those toggles into `venueTradingVerdict` is left for an owner decision.~~ **Round 5 (decision 2):** `venueTradingVerdict` blocks new DEMO/LIVE risk on them. Not done: no order path (order guard, live dispatch, pre-trade governor) reads the verdict or the toggles yet, so they are reported, not enforced, at dispatch. Wiring them into the governor's halt would refuse every DEMO/LIVE entry on an install where `execution_enabled` is still at its schema default (false). Production fact needed first: the current `broker_health_state` row (exists? `execution_enabled`? `maintenance_mode`?) on the production install.
4. **Bridge/EA safety and readiness truth:** surveyed in round 3 (see below). One owner, no duplicate raw readers to move. Two findings were left as they are: ~~the EA update gate honours only the trader kill switch~~ (round 5, decision 5: it now honours both install-wide stops), and the admin EA-health preview hardcodes its stop inputs (fixed in round 4).
5. **No published score.** The scorecard rubric and its destination are still needed before a new score can be measured.
6. **Shared-live pause (round 5, decision 19):** the pause is per pool row; there is no per-allocation pause column, and the decision's "allocation" scope is served by the allocation's own freeze (`trading_frozen`, owned by Allocation). Adding a per-allocation pause would need a schema change and an owner decision. QA scripts (`scripts/src/qaSharedBridgeReconciliation.ts`) and the generated API types still name the column; they are not runtime and are outside the guard.

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
  - ~~The EA self-update gate (`routes/mt5RemoteOps.ts`, `evaluateEaUpdateGate`) blocks on the trader's own kill switch only, not on the install-wide stops.~~ **Round 5 (owner decision 5):** it also blocks while either install-wide stop is engaged.
  - ~~The admin EA-health view (`routes/adminEaHealth.ts`) previews the same gate with `killSwitchEngaged: false` and `maintenanceMode: false` hardcoded. Its preview can therefore say "update allowed" where the EA's real check (`mt5RemoteOps`) blocks.~~ **Fixed in round 4 (Broker State, `r4/bridge-freshness-source`).** Both the real check and the admin preview now get their safety inputs from one loader, `lib/mt5/eaUpdateGateInputs.ts`. The inputs are the trader's kill switch (`liveArming.getMyArming`), the per-trader `ea_remote_config.maintenance_mode` (the real gate's maintenance source, not `broker_health_state`), an open LIVE position, any in-flight live command, and the 15 s heartbeat window. The preview also used to hardcode `hasOpenLiveTrade: false`, looked only at the latest command, and used the watchdog's liveness instead of the gate's heartbeat window. Those inputs now match the real check as well. The gate itself is unchanged: it makes the same reads in the same order. (Round 5 adds the install-wide stops as the last input, decision 5.) Test: `test:ea-update-gate-inputs` (`ci:integration`).
  - ~~Heartbeat freshness thresholds are repeated: `safetyCore` uses 15 s / 60 s, `paperIntelligence` 15 s, and `brokerHub/mt5ReadOnlyAdapter` 60 s.~~ **Moved in round 4.** The thresholds are now named in `lib/brokerHub/freshness.ts` and enforced by guard `single-bridge-freshness-source`. No value changed. See `docs/TIER1_BROKER_HUB_SOURCE.md`, "Round 4".

## Round 4: reports on the platform stop, one engage writer

**Readers.** Each report or readiness view that says whether trading is stopped now reads `platformStop()`. A view that already loaded the switches (with its own missing-row rule) calls `platformStopWith(switches)`, so its emergency-stop answer is exactly what it was, and the safety-core kill switch is read next to it. A labelled per-source field keeps its meaning and is taken from that answer with `stopSourceEngaged()`; the combined fields come from `platformStopReport()`.

| View | Before | Now |
|---|---|---|
| `approvedTraderLiveState` | emergency stop | both (`platformStopEngaged`, `platformStopSources`; new blocker code) |
| `unifiedLiveReadiness` + decision | emergency stop | both (input `platformStopSources`; new blocker) |
| `handshake/layerAdapters` KILL_SWITCH | emergency stop | both |
| `assistant/tools` launch readiness | emergency stop | both |
| `tradingReadiness` | safety core | both (+ `readSafetyCorePosture()` for the mode) |
| `systemHealth/health` | safety core | `platformStop()` for PAPER (= safety core, unchanged) |
| `adminCockpit`, `adminLaunchReadiness`, `adminOperatorCommandCenter`, `adminLiveTestReadiness`, `adminMasterLiveAccess` | emergency stop | both (combined fields added) |
| `adminLiveGatesDiagnostic` | emergency stop row | + safety-core row |
| `portfolio` plan | safety core | both |
| `tradeDecision` | safety core | both (emergency stop as a warning) |
| `adminLiveSharedReadiness` readiness + test-connection dry run | emergency stop | combined fields added; stays listed for its arm precondition and activation handler |
| `safetyEnvelope`, `assistant/derivedEnvelope` | emergency stop | unchanged (gate input, see What remains) |
| `mt5`, `brokerHealth`, `trades`, `permission` | safety core | unchanged (owner decision) |

**Engage writer.** `lib/safety/platformStopWriter.ts` is the only file that may write an engaged emergency stop (guard rule 10). It writes every settings row because the reader says "engaged" when any row does. It takes an optional transaction so the live-shared kill switch and the rollback keep their atomic writes. Each caller still writes its own audit event; the guard fails a caller that does not reference `admin_action_audit_log`. The release paths were not touched.

## Round 5: owner decisions

The owner decided the Platform Safety questions this doc left open (2026-10-25). They are recorded here as given, with what each PR did. Each PR is one commit on its own stacked branch.

| # | Owner decision (short) | PR / branch |
|---|---|---|
| 1 | Live activation must not release an emergency stop. One explicit, authorized, audited release of the selected stop, on every applicable settings row, clearing its active reason/time and keeping audit history. Never clear the other stop or re-arm. | `r5/safety-1` |
| 2 | Broker-health `executionEnabled` and `maintenanceMode` affect the DEMO/LIVE venue verdict. Platform Safety owns the operator-control decision; Broker Hub supplies the facts. Disabled execution or maintenance blocks new risk; governed close/cancel/protection paths keep their checks. | `r5/safety-2` |
| 3 | Make the four legacy gates action-aware. New-risk commands (and `/execute-trade`) honour both install-wide stops. Reconnect stays available for recovery but cannot clear stops, arm trading or dispatch queued orders. PAPER keeps its emergency-stop exemption and honours the safety-core stop. No blanket block on every endpoint. | `r5/safety-3` (`/execute-trade`: left to the decision-14 retirement) |
| 4 | The safety envelope includes the safety-core kill switch. Report both sources and derive new-risk permission from the common authority. Keep the emergency-stop field truthful; no accidental blanket refusals of closes/protection. | `r5/safety-2` |
| 5 | Install-wide stops block automatic EA updates. Keep every existing check (open positions, in-flight commands, trader stops, maintenance). Diagnostics stay available. No automatic recovery bypass. | `r5/safety-3` |
| 19 | Platform Safety owns the shared-live pause decision: a scoped, authorized, audited safety API that the allocation routes call. The flag stays scoped to its pool/allocation (never install-wide); Broker Hub keeps broker facts; readers of the flag go through the authority. | `r5/safety-4` |

### Decision 1: one release operation (`r5/safety-1`)

`releasePlatformStop({ stop, reason, actor: { userId, role }, source, ipAddress?, acknowledgement?, resetBy? })` in `lib/safety/platformStopWriter.ts`, next to the engage writer:

- **Authorized:** refuses `NOT_AUTHORIZED` unless the actor's role is ADMIN or OWNER (`operatorRoleFromSession`, the same check as the admin routes). Refuses `REASON_REQUIRED` under 4 characters. A refusal writes nothing.
- **Selected stop only:**
  - `platform_emergency_stop`: one transaction sets `emergency_kill_switch=false`, `kill_switch_engaged_at=null`, `kill_switch_reason=null`, `updated_by_admin_id` (the actor) on EVERY `global_trading_settings` row (the reader says engaged when any row does), and writes the audit row (`RESET_KILL_SWITCH`, as before). The audit's before-state keeps the reason and engage time the stop had, the other engaged stops and the source; the after-state the row count. No settings row: `NO_SETTINGS_ROW`, nothing written.
  - `safety_core_kill_switch`: delegated to its owner, `lib/safetyCore.ts resetKillSwitch()` (acknowledgement `I_UNDERSTAND_RISK` still required; it drops to `OBSERVE_ONLY` / `RECOVERY_MODE` and records its vault event and state transition as before), then audited (`RESET_SAFETY_CORE_KILL_SWITCH`). A refused reset returns `SAFETY_CORE_REFUSED`.
- **Never the other stop, never arming:** neither branch writes the other stop, the live-execution arm, the platform mode or the venue enables. The safety core's own reset lowers its mode; nothing raises it.

Callers:

- `POST /admin/trading/reset-kill` (emergency stop). Same auth, reason check and response shape (`settings` is the canonical row).
- `POST /system/kill-switch/reset` (safety-core kill switch). Same `requireOperator`, body, acknowledgement and response shape (`ok`, `reasons`, `blockers`, `status`); the actor's product role is passed in.
- `POST /admin/live-shared/activate-step` no longer releases. A request with `releaseKillSwitch` gets 409 `ACTIVATION_DOES_NOT_RELEASE_STOP` naming `POST /api/admin/trading/reset-kill`, and nothing is written. The footgun posture check no longer lists a release (it cannot happen there).
- The dashboard's two release buttons (Live Shared panel, activation wizard step 9) now call `reset-kill` and ask the operator for a reason.

Guard rule 10 now covers releases too: an `emergencyKillSwitch: false` property in a `.set()` / `.values()` object, `<x>.emergencyKillSwitch = false`, or a call to the safety core's `resetKillSwitch()` (in a file that imports `lib/safetyCore.ts`) outside the writer fails the build, in every file, allowlisted writers included. The writer-shape check requires `releasePlatformStop()` to check the operator role, update every settings row (no `.where()`) inside its transaction with the flag, time, reason and actor, write its audit row in that transaction, touch no arm / mode / venue column, and release the safety core through `resetKillSwitch()`. The allowlist stays at 15 entries (no file added; reasons updated).

Tests: `test:platform-stop-release` (new, `ci:integration`): duplicate settings rows (engage then release clears every row, actor recorded, audit row keeps the old reason and time); releasing either stop leaves the other engaged; live arm, mode and venue unchanged; the safety core's acknowledgement still required and its mode comes back `OBSERVE_ONLY`; non-operator roles and short reasons refused with nothing written; the routes (activation with the stop engaged and `releaseKillSwitch` refuses with the actionable message and writes nothing; an activation step without it still applies and leaves the stop engaged; `reset-kill` 403 / 400 / 200 and every row released; the system reset releases only the safety core). `test:single-safety-switch-source` adds release fixtures and the release-shape checks.

### Decision 4: the envelope reads both stops (`r5/safety-2`)

`getEnvelope()` (`lib/adminTrading/safetyEnvelope.ts`) reads the stop with `platformStopWith(switches)`: the emergency stop comes from the same switches read as before (its seeding missing-row rule and its early return are unchanged), and the safety-core kill switch is added (unreadable = engaged).

- `emergencyKillSwitch` still names the platform emergency stop only.
- New fields: `safetyCoreKillSwitch` (that switch only), `platformStopEngaged`, `platformStopSources`, `platformStopReason` (the combination). `FAIL_CLOSED_ENVELOPE` reports both sources engaged.
- New-risk permission comes from the combination: `allowOrderExecution` is false and `liveLocked` true while the safety core is engaged; the banner reads "Emergency Trading Halt" with the safety core's reason.
- `tradingMode` and `readOnlyMode` are NOT changed by the safety core. `POST /me/trades/close` refuses on `tradingMode=DISABLED`, so folding the safety core into `tradingMode` would have refused every guarded close; closes keep exactly the checks they had (the close's own emergency-stop pre-check, the live pipeline's dispatch pre-gate and the governor). The emergency stop's early return (which does set `DISABLED`) is unchanged.
- The order guard, the guarded close and the live dispatch pre-gate already read `platformStop()` themselves (round 3); they read `tradingMode` / `globalLiveEnabled` from the envelope, which did not change, so no order path gains or loses a check here.
- `getEnvelope(userId, { readSafetyCore })` takes an optional reader (tests inject an unreadable safety core).
- The envelope left the guard's allowlist (rule 9; 15 → 14 entries): it now reads `platformStopWith()` + `stopSourceEngaged()`. Ruby's projection (`assistant/derivedEnvelope`) stays listed; it carries the envelope's `allowOrderExecution` / `liveLocked` / `bannerReason`, which now follow both stops. Its response shape (OpenAPI-pinned) is unchanged.

### Decision 2: broker operator controls in the venue verdict (`r5/safety-2`)

`lib/safety/tradingHalt.ts`:

- `readBrokerOperatorControls()` reads `execution_enabled` / `maintenance_mode` through the Broker Hub reader (`brokerHub/brokerHealthState.readBrokerHealthState`, lowest-id row; guard `single-broker-state-source` unchanged). It never throws: a read error returns `readable=false`. No row yet reads as the schema defaults (`execution_enabled=false`, i.e. execution not enabled).
- `brokerControlBlocks(controls, { venue, opensNewRisk })` is the pure decision: only new risk on DEMO/LIVE is blocked (`broker_execution_disabled`, `broker_maintenance_mode`, `broker_controls_unreadable`); a close / cancel / protection change (`opensNewRisk: false`) and PAPER never are.
- `venueTradingVerdict({ userId, venue, opensNewRisk? (default true), readBrokerControls? })` adds `opensNewRisk`, `brokerControls`, `brokerControlBlocks` and a reason per block; `allowed` is false while a block applies. The venue switch and stop answers are unchanged.
- Its one caller, the readiness engine (`userReadiness/engine`, reporting only), now reports "Live trading is stopped platform-wide: Broker execution is disabled by the operator…" (or maintenance) for new live risk.

Tests: `test:platform-switches` adds the envelope matrix (all four stop combinations: per-source fields truthful, combined fields, `allowOrderExecution` / `liveLocked` refused for the safety core, `tradingMode` / `readOnlyMode` unchanged, unreadable safety core fails closed for new risk) and the operator-control matrix (execution disabled, maintenance, both, unreadable, no row, throwing reader × DEMO/LIVE × new risk / close, PAPER never; the real reader through the Broker Hub). `test:readiness-stop-switches` adds the readiness item for execution disabled, maintenance and no row.

### Decision 3: the legacy gates are action-aware (`r5/safety-3`)

Each gate reads both stops once through `platformStop()` + `preCheckStopRefusal({ own: "safety_core_kill_switch", opensNewRisk, venue })`, so its own stop (the safety core) refuses exactly what it refused before and the emergency stop is added only for new risk.

| Gate | New risk | Close / modify / cancel / recovery | Not gated |
|---|---|---|---|
| `/mt5/*` command endpoints (`refuseWhenNotArmed`) | `POST /mt5/execute` and a queued `OPEN` / `PLACE_PENDING_ORDER` (an unknown queued action counts as new risk): refused by EITHER stop | `/mt5/close`, `/mt5/modify`, `/mt5/close-all`, queued `CLOSE` / `MODIFY` / `CLOSE_ALL`: refused by the safety core only, as before | heartbeat, sync, diagnostics, command polling/results (never ran the gate) |
| `/broker/reconnect` | n/a | available under both stops; `PENDING` vs `BLOCKED` decided by the safety-core mode + kill switch exactly as before | |
| paper `/permission` verdict | the safety core blocks (as before); the emergency stop does not (paper exemption, `platformStopForVenue(stop, "PAPER")`) | | |
| `/execute-trade` | unchanged here: owner decision 14 retires it in another change | | |

The `LIVE_TRADING` mode requirement of the `/mt5` gate is the arm, not a stop, and is unchanged; every `/mt5` command is still stored `BLOCKED` (paper-only lock). The 403 body adds `platformStopSources` and `opensNewRisk`; `killSwitchEngaged` still names the safety core. An unused safety-core read inside `queueCommand` (its result was discarded) was removed.

Reconnect writes only its `RECONNECT` command row, the reconnect counter and its vault event. The test proves that under every stop combination the stops, the live arm and the safety-core mode are unchanged, an earlier queued order stays `BLOCKED` and no live command is written.

The three files left the guard's allowlist (rule 9; 14 → 11 entries). `routes/trades.ts` stays listed until `/execute-trade` is retired.

Tests: `test:legacy-gates-action-aware` (new, `ci:integration`): the `/mt5` matrix (released, emergency stop, safety core, both; new risk vs close / modify / close-all / queued actions; diagnostics available), reconnect under three stop combinations, and the paper permission verdict under all four.

### Decision 5: install-wide stops block automatic EA updates (`r5/safety-3`)

- The pure gate (`lib/domain/src/safety-contracts/eaUpdateGate.ts`) takes a required `platformStopEngaged` input and returns `BLOCK:PLATFORM_STOP_ENGAGED` (new reason, appended to the list). It is checked right after the trader's kill switch; every other check (maintenance, open LIVE trade, in-flight command, heartbeat, manifest) is unchanged. There is no override input.
- `lib/mt5/eaUpdateGateInputs.ts` reads it last (`platformStop().engaged`: either stop, unreadable = engaged), so the existing reads keep their order. The EA's real check (`GET /mt5/update-check`) and the admin EA-health preview both get it from that loader; a userless preview row reads it too (it is install-wide).
- Diagnostics: the preview still runs and reports `PLATFORM_STOP_ENGAGED`. Recovery: the update stays blocked until the stop is released through `releasePlatformStop()`; nothing releases it automatically.

Tests: `test:ea-update-gate` (block cases: stop engaged, stop + open trade, the trader kill switch still first) and `test:ea-update-gate-inputs` (stop blocks, every existing check still blocks with the stops released, userless rows, read order, and the real reader on the database for each stop).

### Decision 19: the shared-live pause authority (`r5/safety-4`)

`lib/safety/sharedLivePause.ts` owns the pause columns of `arx_master_bridge_pool` (`shared_live_paused`, `paused_reason`, `paused_at`, `paused_by_user_id`):

- **Scope:** `{ poolId }`, one shared-master pool row. That row is the only place the flag exists, so a pause is per pool, never install-wide: the authority does not read or write `global_trading_settings`, the safety core, the operator live arm or any other pool row. A per-allocation stop already exists as the allocation's own freeze (`user_slot_allocation.trading_frozen`, refused at the same dispatch pre-gate) and is not moved here. No schema change.
- **`pauseSharedLive({ scope, reason, actor: { userId, role }, ipAddress? })`:** refuses `NOT_AUTHORIZED` unless the role is ADMIN or OWNER (`operatorRoleFromSession`), `REASON_REQUIRED` for a blank reason, `POOL_NOT_FOUND` for an unknown pool; a refusal writes nothing. Otherwise one transaction row-locks the scoped row, sets flag / reason / time / actor on that row only and writes the audit row (`SHARED_LIVE_PAUSED_OVER_ALLOCATION`, same action and before/after as before, plus the pool id).
- **`resumeSharedLive({ scope, actor, reason?, ipAddress? })`:** same authorization and scope; clears the four columns on that row only and writes `SHARED_LIVE_RESUMED` in the same transaction. It arms or releases nothing else.
- **`sharedLivePauseOf(pool)`:** the one reader. It interprets a pool row the caller already loaded (no extra read), so every reader means the same thing by "paused": the live dispatch pre-gate (`liveCommandPipeline`, entries only; closes and modifies still flow), the admin allocation pre-check and pool view (`adminAllocations`) and the per-user bridge view (`masterBridgePool.getUserAllocationView`).

Callers: `POST /admin/shared-live/pause` and `/resume` (`routes/adminAllocations.ts`) keep their auth (`requireAdmin`), body, master-pool lookup, post-commit tamper-evident mirror and responses; the write and the audit row now come from the authority. The LIVE pool recompute (`lib/live/masterBridgePool.ts`) keeps writing broker facts and no longer names the pause columns at all: an existing row keeps them, and a new row takes the schema defaults (not paused) instead of literal values that equal them. Broker Hub (`brokerHub/masterBridgePoolReader.ts`) stays the status reader of the pool row; the broker-state guard's write entry for the table moved from `routes/adminAllocations.ts` to the authority (with `lockingReads`: its only read is the `SELECT ... FOR UPDATE` of the row it writes, inside its transaction).

Guard: `single-safety-switch-source` gains rule 11. Outside the authority, a `.sharedLivePaused` property access, a `sharedLivePaused` property in a `.set()` / `.values()` object (spreads followed) or raw SQL naming `shared_live_paused` fails the build; nothing is allowlisted for it. A shape check requires the authority to keep `pauseSharedLive()`, `resumeSharedLive()` and `sharedLivePauseOf()`, to check the operator role, to write the pool row only `.where(eq(arxMasterBridgePoolTable.id, scope.poolId))`, to write its audit row in the same transaction, and never to name an install-wide switch or its writer. The safety-switch allowlist stays at 11 entries.

Tests: `test:shared-live-pause` (new, `ci:integration`): pausing pool A leaves pool B, every settings row, the safety-core row and `platformStop()` unchanged; the audit row and its before/after; resuming A leaves a separately paused pool B paused; refusals (four non-operator roles for pause and resume, blank reason, unknown pool) write no flag and no audit row; the routes still answer 403 to a non-operator session. `test:single-safety-switch-source` adds rule 11 fixtures and the shape checks; `test:single-broker-state-source` moves its pool-writer fixtures to the authority (the admin route writing the table now fails).

### Round 5 behaviour changes

23. **Live activation no longer releases the emergency stop** (decision 1). `releaseKillSwitch` in an activation request is refused (409 `ACTIVATION_DOES_NOT_RELEASE_STOP`) and nothing in that request is applied. Before, it released the stop on one row (the canonical one), and the readback that fed its audit row came from an unordered first row. The dashboard buttons that sent it now call `reset-kill`.
24. **`reset-kill` releases every settings row** (decision 1). Before, only the canonical row; with a stray engaged row the stop stayed engaged (round 4 behaviour change 22). The audit row (`RESET_KILL_SWITCH`) now records the combined before-state (engaged if any row was), its old reason and time, and the row count, and is written in the same transaction as the release.
25. **The safety-core reset is audited in `admin_action_audit_log`** (`RESET_SAFETY_CORE_KILL_SWITCH`) as well as in the vault. Its checks and response are unchanged.
26. **The envelope's new-risk permission follows both stops** (decision 4). While only the safety-core kill switch is engaged: `allowOrderExecution=false`, `liveLocked=true`, banner "Emergency Trading Halt". Consumers of those fields are Ruby's surfaces (live availability copy, `orderExecution.available`); they now say no new orders. `tradingMode`, `readOnlyMode` and `emergencyKillSwitch` are unchanged, so no close is newly refused. New fields `safetyCoreKillSwitch` and `platformStop*` appear in `/me/trading/mode`'s `envelope`. One extra `safety_core` read per envelope.
27. **The venue verdict blocks new DEMO/LIVE risk on broker execution disabled / maintenance / unreadable controls** (decision 2). Its only caller is the readiness engine, so readiness for live now reports a platform-wide stop in those cases, including on an install whose `broker_health_state` row was never created or whose execution was never enabled (the schema default is `execution_enabled=false`). No order path calls the verdict; see What remains.
28. **`/mt5` new-risk commands are refused while the platform emergency stop is engaged** (decision 3). Before, only the safety core refused them. Closes, modifies and close-all are unchanged. The 403 body adds `platformStopSources` / `opensNewRisk`.
29. **`/broker/reconnect` and the paper `/permission` verdict:** no change in what they allow or refuse (decision 3 confirms both rules); they now read the stop through the authority (lowest-id `safety_core` row without seeding; unreadable counts as engaged instead of throwing).
30. **Automatic EA updates are blocked while either install-wide stop is engaged or unreadable** (decision 5). `GET /mt5/update-check` answers `BLOCK` / `PLATFORM_STOP_ENGAGED`; the admin EA-health preview shows the same. One extra stop read per check.
31. **Shared-live pause / resume write the flag and the audit row in one transaction** (decision 19). Before, the route updated the pool row and then inserted the audit row separately, so a failed audit insert left the flag changed with no audit row; now both commit or neither does. The audit's after-state adds `poolId`. A whitespace-only pause reason is refused (400 `BAD_BODY`, nothing written) instead of being stored, and the stored reason is trimmed. The flag's readers, the dispatch pre-gate and the responses are unchanged.

## Honest limits

- The guard is static source analysis. It closes the ways a raw switch value enters a file (column refs, whole-row reads, the raw loader, raw SQL), but it does not track a row object passed in from an allowlisted writer.
- An allowlist entry records a reviewed path. It does not prove that path is correct.
- Rule 9 is name-based: it flags `.emergencyStop`, `.emergencyKillSwitch`, `readSafetyCoreSwitch` and, in files that import the safety core, `.killSwitchEngaged`. A stop value copied into a differently named field and passed to another file is not tracked.
- Rule 9 is name-based, so a report that takes `stopSourceEngaged(stop, "platform_emergency_stop")` passes it. That is the intended way to keep a labelled per-source field, but the guard cannot tell whether a view that does so also shows the combined answer; that was checked by review for each view moved in round 4.
- Rule 10 sees literal objects passed to `.set()` / `.values()` and assignments to `.emergencyKillSwitch`. An engaged value that reaches a write through a variable holding a whole object (built elsewhere, or with a computed key) is not traced. Its "audited caller" check only asks that the calling file references `admin_action_audit_log`; it does not prove the audit row is written on the same path.
- Rule 11 is name-based (`sharedLivePaused`, `shared_live_paused`). A pool row passed whole to another file and read through a computed key is not traced; the other pause columns (`pausedReason`, `pausedAt`) share names with investor tables and are not guarded by name.
- `preCheckStopRefusal` adds the other stop only for actions that open new risk. Pre-checks pass `opensNewRisk` from their own action classification (`RG_CLASSIFY.OPENS_NEW_RISK`; live entry command types; orders). A widening stop modify is still refused only by the governor.

**TIER 1 NOT COMPLETE**
