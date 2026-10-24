# Tier 1: Platform Safety, one source for the safety switches

Base: `a4cea8b` (PR #39). This change covers the single-source and callers
part of Platform Safety (kill switches and trading halt, live-venue enable,
readiness, the Phase B master switch). Tier 1 is still not complete after
it, and the published scorecard has not changed.

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
  - `loadGlobalTradingSettingsRow()` returns the raw row and seeds it when missing. It moved here from `getGlobalSettings`, and only the audited admin writers use it. `getGlobalSettings()` in `safetyEnvelope.ts` now returns the config view without switches. Its type is `Omit<…, SwitchField>`, so the compiler rejects reading a switch from it.
- **`tradingHalt.ts`** keeps the per-trader halt (trader kill switch, frozen allocation). It now reads the install-wide stops through `platformSwitches.ts`. It also gains `venueTradingVerdict({ userId, venue })`, the one answer to "may this venue trade now, and why not". That answer is the venue switch AND every stop switch, with reasons. It adds no gate and approves nothing.

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
8. names a switch column or the `safety_core` table in raw SQL.

The guard also fails on a stale allowlist entry (a file that no longer breaks the listed rule, or that no longer exists). It also fails if the authority loses its strict multi-row combine, its fail-closed answer or `venueTradingVerdict`.

The 7 reviewed exceptions are:

- audited admin writers: `adminTrading`, `adminLiveSharedReadiness`, `adminLiveSharedActivation`, `adminMasterBridge`, `adminLiveFirstTestMode`;
- env-flag readers: `phaseBConfig`, `startup/envChecklist`.

Tests:

- `test:single-safety-switch-source` runs the guard on the real tree plus negative fixtures.
- `test:platform-switches` is a new DB test, added to `ci:integration`. It covers:
  - missing-row policies;
  - that the schema defaults match `DEFAULT_SWITCH_ROW`;
  - venue rules and the unknown-mode rule;
  - the stray-row strictest-wins rule, with the envelope agreeing;
  - `venueTradingVerdict` for the venue switch, emergency stop, safety core and trader kill switch (paper is never closed by a platform switch);
  - that the config view carries no switch.

## Behaviour changes (all stricter, or reports only)

1. **More than one settings row:** every reader now combines all rows strictly (see above). Before, readers picked different rows. With one row nothing changes. A stray row seeded with defaults blocks the operator arm until it is removed, because it is not armed. That is safe, but an operator has to clean it up.
2. **Unknown platform-mode casing:** `tradeAction/guards`, readiness and the account shell used to upper-case the stored value. A non-canonical value such as `live` now reads as `OFF`. The admin handler only writes the canonical values.
3. **Unreadable or missing settings now read as stopped in reports that used to show "released" or throw:** `adminCockpit`, `adminLaunchReadiness`, `adminOperatorCommandCenter`, the assistant operator summary, `meAccountShell` (now shows OFF instead of returning 500), `tradingReadiness` (unreadable safety core now gives LOCKED instead of 500), and system health (an unreadable safety core now adds a `KILL_SWITCH` hard block).
4. **`resolveLiveBrokerExecutionEnabledAsync`** now returns false on a read error instead of throwing, and it reads every row (armed only if all rows are armed).
5. **`/risk/pause` now disarms live and writes an audit event,** as the other kill-switch path always did. After `/risk/resume` the trader has to re-arm before trading live. `/risk/resume` also clears the engaged-at and engaged-by fields and is audited.
6. **The live-gates diagnostic** reports the enforced flag. Before, it reported `kill_switch_engaged_at`: it called a stop "clear" if the flag was set without a timestamp, and "engaged" if a stale timestamp remained after release. Admin readiness reports show the stop's reason and time only while it is engaged.
7. **The handshake admin-control and kill-switch layers** read the authority (all rows) instead of only the row with `id = 1`.

No tables, columns, migrations, RLS policies, Risk Governor rules or dispatch gates were changed. No order path lost a check.

## What remains

1. **Writers are reviewed, not unified.** The emergency stop is written by `adminTrading` (engage and reset, audited), by `adminLiveSharedActivation` (engage on rollback), and by the activation handler in `adminLiveSharedReadiness`. That handler releases it with `patch.emergencyKillSwitch=false` and does not clear the reason or time. That release path, and its unordered-row write target, should move to one audited `releasePlatformStop` in the authority. That needs an owner decision on whether activation may release a stop at all.
2. **Two install-wide stops.** The safety-core kill switch and the platform emergency stop are independent switches, and both are honoured by the Risk Governor through `tradingHalt`. Some pre-checks read only one of them: the trade-action guard reads the safety core, and the order guard reads the emergency stop through the envelope. They are stricter-only pre-checks ahead of the governor, but a single "platform stop" would be cleaner.
3. **Out of scope here:** shared-master and master-bridge enables (`shared_live_trading_enabled`, `master_bridge_live_enabled`), per-user arming (`is_armed`) and user permissions. These are routing and consent facts with their own owners. The same applies to `self_trade_kill_switches` (per agent) and `protective_auto_close_settings`. Legacy `live_trading_state` stays confined by `legacy-live-state-confined`. The broker health toggles (`broker_health_state.execution_enabled`, `maintenance_mode`) already have one reader, `lib/brokerHub/brokerHealthState.ts` (guard `single-broker-state-source`, PR #36). This change does not duplicate that reader. Folding those toggles into `venueTradingVerdict` would add a new gate, so it is left for an owner decision.
4. **Bridge/EA safety and readiness truth** (`safetyCore` mode and global state) were not re-surveyed.
5. **No published score.** The scorecard rubric and its destination are still needed before a new score can be measured.

## Honest limits

- The guard is static source analysis. It closes the ways a raw switch value enters a file (column refs, whole-row reads, the raw loader, raw SQL), but it does not track a row object passed in from an allowlisted writer.
- An allowlist entry records a reviewed path. It does not prove that path is correct.

**TIER 1 NOT COMPLETE**
