# Tier 1: Risk Governor, one source for the risk limits

Base: `04a197e` (PR #45). Branch `r4/risk-governor-single-source`. This
change covers the "one source for the limits" part of the Risk Governor:
who reads the limit settings, and who compares a value against a limit.
The one pre-trade verdict (`enforcePreTradeRisk`) was already enforced by
`single-risk-authority`, and the one trader-editable store by
`single-limit-store`. Tier 1 is still not complete after this change, and
the published scorecard has not changed.

## The problem

The numbers the pre-trade Risk Governor enforces live in two stores:

| Store | Holds | Writers |
|---|---|---|
| `user_risk_settings` | the trader's own limits (lot, risk per trade, daily / weekly loss, open trades, trades per day, streak, cooldown, R:R, exposure columns, symbol limits) | the Risk Governor settings page (`/me/risk-settings`), the older settings page (`lib/risk/userRiskSettings.ts`), presets and prop-firm mode (`riskProfile`), the governor's get-or-create |
| `user_risk_limits` | the operator's hard limits for that trader (lot, daily loss USD, trades per day, symbols, direction, account type, exposure columns) | the audited admin risk-limits handler (`routes/adminTrading.ts`) |

The governor resolves both with its platform ceilings in
`resolveEffectiveLimits` (`lib/riskGovernor/preTrade.ts`): strictest wins,
the trader's daily-loss switch can turn off only the trader's own daily
cap, and missing values take the governor's defaults.

Before this change, 16 server files outside the governor selected these
rows themselves (`db.select().from(userRiskSettingsTable)` /
`userRiskLimitsTable`), and about 25 files compared a value against a
limit with their own numbers. Each such reader can disagree with the
governor: it ignores the operator cap, uses its own defaults, or ignores
the daily-loss switch. Nothing stopped a new one.

## The authority

- **`lib/riskGovernor/limitSettings.ts`** (new) is the one reader of the
  limit settings:
  - `readTraderRiskSettings(userId)` / `readTraderRiskSettingsMany(userIds)`
    return the trader's saved `user_risk_settings` row(s);
  - `readOperatorRiskLimits(userId)` / `readOperatorRiskLimitsMany(userIds)`
    return the operator's `user_risk_limits` row(s);
  - `loadStoredLimitRows(userId)` and `loadEffectiveLimits(userId)` moved
    here from `enforce.ts` (which re-exports them, so importers are
    unchanged). `loadEffectiveLimits` is the limits in force: the same
    values the governor applies on every order.
- **`lib/riskGovernor/preTrade.ts`** keeps the one resolution
  (`resolveEffectiveLimits`) and every limit evaluation (rules 1 to 13).
- The governor itself reads through the reader: `enforce.ts`
  (`loadEffectiveLimits(intent.userId)`), `riskEvents.ts`
  (`getOrCreateRiskSettings`).

## Callers moved onto the authority

Every move is the same query (one row by `user_id`, or `user_id IN (...)`),
with the same handling of "no row":

| File | Before | After |
|---|---|---|
| `lib/riskGovernor/enforce.ts` | own selects of both tables | `limitSettings` (moved there) |
| `lib/riskGovernor/riskEvents.ts` | own select in `getOrCreateRiskSettings` | `readTraderRiskSettings` |
| `lib/risk/userRiskSettings.ts` | own selects (the older page's store) | `readTraderRiskSettings` (the insert stays) |
| `lib/adminTrading/orderGuard.ts` | own select of `user_risk_limits` (step 6) | `readOperatorRiskLimits` |
| `lib/readiness/traderReadiness.ts` | own select | `readTraderRiskSettings` |
| `lib/assistant/tools.ts` (`getRiskLimits`) | own select | `readTraderRiskSettings` |
| `lib/assistant/coachTools.ts` (2 places) | own selects | `readTraderRiskSettings` |
| `lib/alerts/ruleEngine.ts` | own `IN` select of two columns | `readTraderRiskSettingsMany` |
| `lib/reportBuilder.ts` | own select | `readTraderRiskSettings` |
| `routes/meDashboard.ts` | own select | `readTraderRiskSettings` |
| `routes/health.ts` | own select (`configured = rows > 0`) | `readTraderRiskSettings` (`configured = row != null`) |
| `routes/meAccountShell.ts` | own select | `readTraderRiskSettings` |
| `routes/pendingOrderDraft.ts` | own select | `readTraderRiskSettings` |
| `routes/portfolioRisk.ts` | own select | `readTraderRiskSettings` |
| `routes/adminAllocations.ts` | own `IN` select of two columns | `readOperatorRiskLimitsMany` |
| `routes/meRiskGovernor.ts` | own select before the upsert | `readTraderRiskSettings` (the writes stay) |
| `routes/adminTrading.ts` | own select for the audit "before" snapshot | `readOperatorRiskLimits` (the writes stay) |

One duplicated number moved onto the governor: the trade-action guard's
early lot hard cap (`lib/tradeAction/guards.ts`, `MAX_LOT_HARD_CAP = 5.0`)
now reads `PLATFORM_RISK_CEILINGS.maxLotSize` (also 5), so the early
refusal and the governor's own ceiling cannot drift apart. The message is
unchanged ("exceeds hard cap 5").

## What is enforced

`single-risk-limit-source` runs in `ci:guards` (86 guards). It uses the
TypeScript AST (aliases, destructured dynamic imports, namespace access,
the relational query API, raw SQL string literals). Outside
`lib/riskGovernor/limitSettings.ts` it fails on:

1. **table**: any reference to `userRiskSettingsTable` / `userRiskLimitsTable`
   that is not part of a write (selects, `db.query.…`, column refs). This
   applies inside `lib/riskGovernor/` too. Type-only use
   (`typeof userRiskSettingsTable.$inferSelect`) is not a read;
2. **write**: insert / update / delete on either table outside the
   reviewed writers (the whole call chain, `where` clause included, counts
   as the write);
3. **raw_sql**: raw SQL naming `user_risk_settings` / `user_risk_limits`;
4. **raw_reader**: outside `lib/riskGovernor/`, a call to a reader of the
   trader's SAVED row (`readTraderRiskSettings[Many]`,
   `readOperatorRiskLimits[Many]`, `getOrCreateRiskSettings`,
   `getOrCreateUserRiskSettings`). These return what was saved, not the
   limit in force. A caller that needs "the limit" reads
   `loadEffectiveLimits()` (or `loadStoredLimitRows()` +
   `explainLimitLayers()`), which is not flagged;
5. **limit_eval**: outside `lib/riskGovernor/`, a comparison (`<`, `<=`,
   `>`, `>=`) against a property named like a governor limit (`maxLotSize`,
   `maxPositionSize`, `maxDailyLoss*`, `maxOpenTrades`, `maxTradesPerDay`,
   `maxRiskPerTrade*`, `maxDrawdownPercent`, `maxPortfolioRiskPercent`,
   `maxPositionsPerSymbol`, `maxLeverage`, `maxSymbolLeverage`,
   `cooldownAfterLossMinutes`, `maxConsecutiveLosses`, `maxWeeklyLoss*`,
   `minRewardRiskRatio`) or a live / self-trade lane cap (`maxOpenPositions`,
   `maxConcurrentPositions`, `maxLotPerTrade`, `maxLotConfirmed`, `maxLot`,
   `dailyLossLimitUsd`, `maxExposurePerSymbolLots`). Parentheses, `!`, `as`
   and `?? default` are seen through.

It also fails on a stale allowlist entry (file gone, or no longer breaks
the listed rule), and if the authority loses a reader, if
`loadEffectiveLimits` stops resolving through `resolveEffectiveLimits`, if
`enforce.ts` stops reading through `./limitSettings.js`, or if the early lot
cap in `tradeAction/guards.ts` gets its own number again.

The reviewed exceptions start at 33 (new guard, nothing to compare with).
Each carries a `why` in the guard and a category:

- **Audited writers (5):** `riskGovernor/riskEvents`, `riskGovernor/riskProfile`,
  `risk/userRiskSettings`, `routes/meRiskGovernor`, `routes/adminTrading`.
- **(a) Stricter-only pre-checks before the governor (4):**
  - `adminTrading/orderGuard` step 6 runs before its own `pre_trade_risk`
    step and only adds refusals (`NO_RISK_LIMITS_CONFIGURED`, operator max
    lot, symbol / direction / account type, trades per day);
  - `autopilot` (in-memory session rules; every order goes through
    `oms.placeOrder` → `enforcePreTradeRisk`);
  - `live/liveCommandPipeline` (the arming-time confirmed max lot at draft
    time, before the governor pre-gate at dispatch);
  - `live/liveArming` (arming checklist: confirmed max lot ≤ 1.0).
- **(b) Display, report, alert, advisory (21):** `readiness/traderReadiness`,
  `assistant/tools`, `assistant/coachTools`, `alerts/ruleEngine`,
  `reportBuilder`, `meDashboard`, `health`, `meAccountShell`,
  `portfolioRisk`, `pendingOrderDraft`, `adminAllocations`, `riskProfile`
  (route), `risk` (older page, audit report, size calculator),
  `executionConfirmations`, `liveIntent`, `propChallenges`, `ruleContracts`,
  `marketDataLayer` (advisory `evaluateRisk`), `missionRiskState` (facts),
  `paperSession/manager` (status route), `riskAudit` (report half; see (c)).
- **(c) Duplicate decisions on a different basis (3, plus `riskAudit`):**
  `mt5` (legacy `/mt5/execute`), `permission`, `tradeDecision`.

Tests:

- `test:single-risk-limit-source` runs the guard on the real tree plus 78
  fixture assertions (each rule, aliases, type-only use, the write chain,
  readers inside vs outside the governor, `loadEffectiveLimits` not flagged,
  `??` / `!` / `as` unwrapping, stale detection, rule-scoped allowlisting,
  and the authority shape).
- Existing suites rerun on this branch: `test:risk-governor-*` (automation,
  discipline, journal, per-user-limits, pipelines, rules),
  `test:risk-pre-gates`, `test:pre-gate-wave4`, `test:user-settings-cap-writer`,
  `test:alert-rule-ownership`, `test:limit-layers`, `test:one-limit-store`
  (api-server); `test:pre-trade-guard`, `test:objective-sizing`,
  `test:realized-pnl-guard`, `test:cooldown-race-db`, `test:risk-correlation`,
  `test:single-risk-authority`, `test:single-limit-store` (scripts). `test:rg`
  passes its 20 source checks; its two HTTP scenarios (21, 22) need a
  running server.

## Behaviour changes

None. Every moved read is the same query on the same rows with the same
"no row" handling (`null` where the caller used `rows[0] ?? null`, an empty
list for an empty `IN`). `routes/health.ts` reports
`riskGovernor.configured` from `row != null` instead of `rows.length > 0`,
which is the same value. The early lot cap is the same number. No Risk
Governor rule, default, gate, table, column, migration or RLS policy
changed.

## What remains

### Survey: limit logic outside the governor

The survey covered `artifacts/api-server/src` (every reader of the two
tables and every comparison against a limit-named property) and the pure
engines in `lib/domain`.

**(a) Stricter-only pre-checks** (run before the governor, only add refusals):

| Where | Limit | Notes |
|---|---|---|
| `tradeAction/guards` step 8 | platform lot ceiling | now reads `PLATFORM_RISK_CEILINGS.maxLotSize` |
| `adminTrading/orderGuard` step 6 | operator lot, symbols, direction, account type, trades per day | trades per day counts `trade_command_audit_log` APPROVED rows over a rolling 24h; the governor counts today's trades on its own activity basis. Symbols match exactly here (the governor trims and upper-cases). A different basis, so not unified |
| `live/liveCommandPipeline` | arming confirmed max lot, governance `maxLotPerTrade` / `maxOpenPositions` / `maxDailyLossUsd`, master live access caps, `arx_live_user_settings` per-market lot | the live lane's own stores; the open-position cap counts `UNCLOSED` live rows plus in-flight commands (same `UNCLOSED` basis as the governor) |
| `live/instantTrade` | Ruby open-position cap | `UNCLOSED` basis |
| `selfTrade/executionGate` | `maxConcurrentPositions` | round 5 (owner decision 6): counts on `RISK_COUNT_BASIS` (`UNCLOSED`), the governor's basis; floating P/L stays on `EXPOSURE` |
| `liveTrading/limits` + `guard` | micro-live hard-coded caps (lot 0.01, risk 0.25%, daily 0.5%, ...) | constants, guarded by `live-order-risk-limits` |
| `autopilot` | session max open positions / max trades | in-memory session rules; orders go through `oms.placeOrder` |

**(b) Display / report / alert** (never gate an order). Several show the
trader's SAVED value rather than the limit in force, or use their own
defaults or formulas. Moving them to `loadEffectiveLimits` would change
what they show, so they stay listed:

- `alerts/ruleEngine`: the RISK_LOCK alert uses the trader's own
  `max_daily_loss_percent` only. It ignores the operator USD cap and the
  daily-loss on/off switch, so it can fire when the governor would not
  block, or stay quiet when an operator cap is tighter.
- `portfolioRisk`: defaults 2 open / 2% daily / 0.5% per trade where the
  governor's defaults are 3 / 3% / 1%.
- `readiness/traderReadiness`: a "$50 per 1%" daily-loss proxy (its own
  formula).
- `meAccountShell`: master-live-access caps first, then the trader's saved
  values (its own precedence).
- `meRiskGovernor` `/me/risk/status`, `/daily-status`: the trader's saved
  caps against `paper_trades` history. The limits in force are
  `/me/risk-limits/layers`.
- `meDashboard`, `reportBuilder`, `health`, `riskProfile`, `risk` (older
  page), `executionConfirmations`, the assistant tools: show or score
  against the saved row.
- `pendingOrderDraft`: reads a `minRiskRewardRatio` field the row does not
  have (the column is `min_reward_risk_ratio`), so it never applies an R:R
  floor. The governor's own R:R rule still runs on the order. Wiring the
  real column would add refusals, so it is listed, not fixed.
- `propChallenges`, `ruleContracts`, `paperSession/manager`,
  `missionRiskState`, `marketDataLayer`: compare against their own stores
  (prop challenge config, accountability contracts, paper-session rules,
  mission budget, caller input), not the governor's limits.

**(c) Duplicate decisions on a different basis** (not unified):

- `riskAudit` (`computeRiskAudit`), used by `/risk/audit` and the legacy
  `/mt5/execute` gate (`routes/mt5.ts`): daily / weekly loss, trade count,
  open trades and losing streak from the legacy `trades` table (not
  scoped to the user), against the trader's saved values. Legacy `trades`
  vs `paper_orders` P/L is an **owner decision**. Commands on `/mt5` are
  stored BLOCKED and no governor runs on that path.
- `routes/permission.ts`: the paper permission verdict
  (`evaluatePermission`, `@workspace/domain/safety-permission`) uses the
  trader's saved values, not the effective limits (operator caps and the
  daily-loss switch are not applied). Unifying would change the verdict.
- `routes/tradeDecision.ts`: an advisory orchestrator. Open trades
  (`paper_orders` OPEN), trades today and losing streak against the saved
  values. It adds blocker lines and places nothing.
- `meRiskGovernor.postPaperCloseRiskHooks`: warning-level
  `consecutive_losses_hit` / `cooldown_started` events from `paper_trades`
  history. The governor's discipline rule decides on its own activity facts
  (`paper_trades` vs `paper_orders` basis: **owner decision**).

**Pure engines in `lib/domain`** (not scanned by the guard): about 19 files
compare against limit-named inputs (`risk-governor/*`, `execution-gate`,
`safety-permission`, `execution-safety/checklist`, `risk/riskGates`,
`risk/drawdownGuard`, `portfolio-risk`, `profit-mission/*`,
`self-trade/quotaPressure`, `pipeline/approveStage`, `agents`, `ai-agents`,
`confidence-gate`, `execution-pyramid`, `live-inputs`,
`strategy-constitution`). They read no settings; they decide on the
numbers their caller passes. Of those, the server imports
`safety-permission` (`permission.ts`, listed in (c)), `execution-safety`
(`executionConfirmations.ts`, advisory), `portfolio-risk` (`portfolioRisk.ts`,
report), `risk-governor` (the stateless `/risk/guards/*` calculators, request
input only; `cognitive` imports a type only), `risk` (`lotForRisk`, used by the
governor's own position sizer and the scalp engine) and `self-trade`. A
server caller that feeds these engines the trader's saved row is caught by
the `raw_reader` rule.

### Owner decisions (round 4 list; decided 2026-10-25, see "Round 5")

1. Open-position count basis for the self-trade concurrent cap
   (`EXPOSURE`) vs the governor (`UNCLOSED`). **Decided (owner decision 6):
   `UNCLOSED` for both.**
2. Legacy `trades` vs `paper_orders` (and `paper_trades`) as the P/L and
   streak basis for `riskAudit`, `/mt5/execute`, `/me/risk/status` and the
   post-close hooks.
3. Whether the (b) and (c) readers above should show / decide on the
   limit in force (`loadEffectiveLimits`) instead of the saved value. Each
   switch changes what a trader sees or which advisory blockers appear.
4. Whether `pendingOrderDraft` should apply the real `min_reward_risk_ratio`
   (adds refusals).
5. Whether the order guard's trades-per-day count (audit log, rolling 24h)
   should follow the governor's basis.

## Honest limits

- `limit_eval` sees a comparison only when one side is a property access
  with a listed name. `lots > cap` with `const cap = s.maxLotSize` on an
  earlier line, an element access (`s["maxLotSize"]`), a renamed field or
  a `Math.min` clamp is not seen. The `raw_reader` and `table` rules catch
  where such a value comes from when it comes from the limit stores.
- Lane-specific stores (live settings, master live access, governance,
  self-trade settings, micro-live constants, session / mission / contract
  rules) are separate limits by design; the guard lists their comparisons
  but does not route them through the governor.
- `lib/domain` engines are not scanned (see above).
- QA fixtures (`__qa__`, `*.test.ts`) and operator scripts
  (`src/scripts`) are exempt, as in the other Tier 1 guards.
- The guard proves who reads and compares; it does not prove the (a)
  pre-checks are stricter than the governor. That is argued per entry in
  the allowlist `why`, and the governor still runs after each of them.

## Round 5: owner decisions 6, 10, 9, 8 and 7

Base: `2a0b3f6` (PR #48). Stacked branches `r5/risk-1` .. `r5/risk-4`, one
commit per decision group. These decisions intentionally change behaviour;
every change is listed under its decision and covered by a regression test.

### Decision 6: one conservative count basis for risk caps (`r5/risk-1`)

> Keep UNCLOSED as the governor's conservative position-count basis. An
> IGNORED or EXTERNAL reconciliation label is not broker-confirmed closure.
> Align the self-trade risk cap with this conservative basis. Do not exclude
> DEMO stop/target-hit rows merely because of their label when closure is
> unconfirmed.

What `UNCLOSED` includes, confirmed in code:

| Venue | `UNCLOSED` predicate | Counts | Does not count |
|---|---|---|---|
| LIVE (`arx_live_positions`) | `closed_at IS NULL` | open rows; operator labels `IGNORED`, `EXTERNAL`, `IMPORTED` (`routes/adminBridgeControl.ts` sets only `reconcile_state`) | a stamped `closed_at`: the live pipeline's broker close, and `RECONCILED_BROKER_ABSENT` (the broker-absence reconciler stamps `closed_at` only after the required run of reliable broker snapshots without the ticket) |
| DEMO (`live_positions`) | `status <> 'CLOSED'` | `OPEN`, `SYNC_PENDING`, `PARTIALLY_CLOSED`, `BROKER_ERROR`, `STOP_LOSS_HIT`, `TAKE_PROFIT_HIT`, `MANUALLY_CLOSED` | `CLOSED`, which only the execution reconciler writes from the broker's close result |

The DEMO SL/TP-hit statuses come from the price evaluator
(`routes/livePositions.ts`, `evaluateLivePosition`), which also stamps
`closed_at` on them; the broker has not confirmed those closes, and
`UNCLOSED` ignores `closed_at` for DEMO, so they keep counting. The basis
already met the decision; it was **not** changed.

- `lib/positions/openPositions.ts` exports `RISK_COUNT_BASIS = "UNCLOSED"`
  (a two-line, additive diff; the read model is shared with the Position
  Guardian work). The Risk Governor (`enforce.ts`) and the self-trade gate
  both count with it.
- `lib/selfTrade/executionGate.ts` `computeAgentDailyPnlUsd`: the
  `openPositionsCount` fed to `MAX_CONCURRENT_POSITIONS` now counts the
  agent's FILLED tickets on `RISK_COUNT_BASIS`. Floating P/L is a separate
  read and stays on `EXPOSURE` (a ghost carries no live exposure).
- Display and advisory bases stay separately named in the read model:
  `EXPOSURE` (exposure totals, unified feed, wallet and pool views, Guardian)
  and `CONFIRMED_OPEN` (advice and open-trade lists).
- `reconciled-ghost-exposure` now pins this split: the gate's P/L read must
  be `EXPOSURE`, its count must be `unclosed.length` from a
  `basis: RISK_COUNT_BASIS` read, the read model must export
  `RISK_COUNT_BASIS = "UNCLOSED"`, and the governor must count with it.

Behaviour changes (decision 6):

- The self-trade concurrent cap counts a FILLED execution whose live row is
  labelled `IGNORED` / `EXTERNAL` / `IMPORTED` and not closed. An agent can
  therefore be refused `MAX_CONCURRENT_POSITIONS` where it was permitted
  before. Daily P/L is unchanged.

Tests: `test:risk-count-basis` (new, real DB, wired into `ci:integration`):
LIVE `IGNORED` / `EXTERNAL` / `IMPORTED` count, closed and
`RECONCILED_BROKER_ABSENT` do not; DEMO `STOP_LOSS_HIT` / `TAKE_PROFIT_HIT`
with a stamped `closed_at` count, `CLOSED` does not; the governor's
`buildRiskContext` counts the same rows for LIVE and DEMO; tenant isolation
with colliding tickets. `reconciledGhostExposureDbTest` (in-process
integration lane) now seeds REAL, IGNORED, EXTERNAL, broker-absent and closed
rows with FILLED executions and asserts count 3, P/L +10.

**TIER 1 NOT COMPLETE**
