# Tier 1: Risk Governor, one source for the risk limits

> Current follow-up: [Tier 1 completion](TIER1_COMPLETION.md) records the latest
> implementation and verification. Sections below retain their named round's
> history. Use [Scorecard v2](../scripts/arx-scorecard/README.md); the missing
> original scorecard is retired and must not be requested again.

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
| `adminTrading/orderGuard` step 6 / 6b | operator lot, symbols, direction, account type; 6b operational rate cap | round 5 (owner decision 9): the rolling-24h count of `trade_command_audit_log` APPROVED rows is gate 6b `operational_rate_cap` (`OPERATIONAL_RATE_CAP_REACHED:<n>_APPROVED_COMMANDS_PER_ROLLING_24H`); the daily-trade limit is the governor's (9b). Symbols match exactly here (the governor trims and upper-cases) |
| `live/liveCommandPipeline` | arming confirmed max lot, governance `maxLotPerTrade` / `maxOpenPositions` / `maxDailyLossUsd`, master live access caps, `arx_live_user_settings` per-market lot | the live lane's own stores; the open-position cap counts `UNCLOSED` live rows plus in-flight commands (same `UNCLOSED` basis as the governor) |
| `live/instantTrade` | Ruby open-position cap | `UNCLOSED` basis |
| `selfTrade/entryReservation` | agent max lot, concurrent and daily entry capacity | atomic additive admission under the agent row lock; validates fresh settings/owner/funding and reserves pending headroom. Every accepted entry still runs the shared Trade Engine/Risk Governor. It does not read or replace effective user/operator/platform limits. |
| `selfTrade/executionGate` | `maxConcurrentPositions` | round 5 (owner decision 6): counts on `RISK_COUNT_BASIS` (`UNCLOSED`), the governor's basis; floating P/L stays on `EXPOSURE` |
| `liveTrading/limits` + `guard` | micro-live hard-coded caps (lot 0.01, risk 0.25%, daily 0.5%, ...) | constants, guarded by `live-order-risk-limits` |
| `autopilot` | session max open positions / max trades | in-memory session rules; orders go through `oms.placeOrder` |

**(b) Display / report / alert** (never gate an order). Several show the
trader's SAVED value rather than the limit in force, or use their own
defaults or formulas. Moving them to `loadEffectiveLimits` would change
what they show, so they stay listed:

- `alerts/ruleEngine`, `portfolioRisk`, `readiness/traderReadiness`,
  `meAccountShell`: round 5 (owner decision 8) moved them onto the limits
  in force (`loadEffectiveLimits` / `effectiveLimitViews`, the governor's
  `dailyLossCapAmount`); no longer allowlisted. See "Decision 8".
- `meRiskGovernor` `/me/risk/status`, `/daily-status`: round 5 shows the
  limits in force (`effective`) next to the saved preference. Its activity
  is still `paper_trades` history (owner decision 7, see below).
- `meDashboard` (trade-quality score only; its caps moved in round 5),
  `reportBuilder`, `health`, `riskProfile`, `risk` (older page),
  `executionConfirmations`, the assistant tools: show or score against the
  saved row.
- `pendingOrderDraft`: round 5 (owner decision 10) reads the floor in force
  (`loadEffectiveLimits().discipline.minRewardRiskRatio`) and applies the
  governor's `checkRewardRiskFloor`; no longer allowlisted.
- `propChallenges`, `ruleContracts`, `paperSession/manager`,
  `missionRiskState`, `marketDataLayer`: compare against their own stores
  (prop challenge config, accountability contracts, paper-session rules,
  mission budget, caller input), not the governor's limits.

**(c) Duplicate decisions on a different basis** (not unified):

- `riskAudit` (`computeRiskAudit`), used by `/risk/audit` and the legacy
  `/mt5/execute` gate (`routes/mt5.ts`): daily / weekly loss, trade count,
  open trades and losing streak from the legacy `trades` table (not
  scoped to the user), against the trader's saved values. Commands on
  `/mt5` are stored BLOCKED and no governor runs on that path. Round 5
  (owner decision 7): left on `trades` (legacy history / DEMO), not a PAPER
  decision; see "Decision 7".
- `routes/permission.ts`: the paper permission verdict
  (`evaluatePermission`, `@workspace/domain/safety-permission`) uses the
  trader's saved values, not the effective limits (operator caps and the
  daily-loss switch are not applied). Unifying would change the verdict.
- `routes/tradeDecision.ts`: an advisory orchestrator. Open trades and
  losing streak against the saved values; trades today from the governor's
  PAPER activity since round 5 (decision 9); open trades and the streak
  read through the paper book's read side since round 5 (decision 7). It
  adds blocker lines and places nothing.
- `meRiskGovernor.postPaperCloseRiskHooks`: warning-level
  `consecutive_losses_hit` / `cooldown_started` events from `paper_trades`
  history. Round 5 (decision 7): these follow the trader's hand-entered
  journal on purpose; the governor decides on `paper_orders`.

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
   post-close hooks. **Decided (owner decision 7): `paper_orders`, through
   the paper book's read side, for automated PAPER facts; `paper_trades`
   stays the journal, `trades` legacy history.**
3. Whether the (b) and (c) readers above should show / decide on the
   limit in force (`loadEffectiveLimits`) instead of the saved value. Each
   switch changes what a trader sees or which advisory blockers appear.
   **Decided (owner decision 8): status views show the limit in force, with
   the saved preference separately and the override reason.**
4. Whether `pendingOrderDraft` should apply the real `min_reward_risk_ratio`
   (adds refusals). **Decided (owner decision 10): yes, with the
   governor's calculation.**
5. Whether the order guard's trades-per-day count (audit log, rolling 24h)
   should follow the governor's basis. **Decided (owner decision 9): the
   daily-trade limit is the governor's; the rolling count stays as a
   separately named operational rate cap.**

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

### Decision 10: the pending-order R:R floor (`r5/risk-2`)

> Fix the dead pending-order R:R hook. Read the real configured
> min_reward_risk_ratio through the risk authority. Apply the same
> calculation and refusal semantics as the governor, including
> missing/invalid inputs.

- `preTrade.ts` now owns the one R:R calculation: `measureRewardRisk` and
  `checkRewardRiskFloor(floor, side, ref, sl, tp)`. Rule 13 calls it
  (unchanged result: same formula, same "not measured" cases, same text).
- `routes/pendingOrderDraft.ts` reads the floor in force,
  `loadEffectiveLimits(userId).discipline.minRewardRiskRatio`: the saved
  `min_reward_risk_ratio`, or the governor's default 1.5 when the trader has
  no row; 0 switches it off. If the limits cannot be read the draft is
  refused (`rg_rr_limits_unavailable`), as the governor refuses when it
  cannot load its context.
- `enforceTradeTicketRules` applies `checkRewardRiskFloor` to the ticket's
  effective entry (the same reference price the draft passes to the
  governor preview), stop and target:
  - below the floor: refused, `rg_rr_ratio_min`, "Blocked by your trading
    rules: reward:risk X is below your minimum of F.";
  - not measurable (no stop or target, stop or target on the wrong side,
    non-finite price): not refused by the floor, exactly as in rule 13. The
    stop / take-profit rules and ticket validation decide those;
  - no floor (null, 0, negative, NaN): no check.
- The floor now applies in every mode, `SIMULATED` included, as rule 13
  does. The old hook skipped `SIMULATED`.
- One honest difference: in rule 13 an R:R below the floor is a "soft"
  failure that blocks together with a second soft failure; at the draft's
  ticket step it refuses on its own. That is the refusal the owner asked to
  add (a stricter-only pre-check before the governor preview, which still
  runs). The value compared is the unrounded ratio, as in the governor; the
  old hook compared a ratio rounded to 2 decimals. Binary floating point can
  put a ratio typed as exactly the floor a hair below it (for example entry
  1.1000, stop 1.0900, target 1.1150 is 1.4999999999999891); the governor has
  always compared it this way.
- `single-risk-limit-source`: `pendingOrderDraft` left the allowlist (33 →
  32 reviewed exceptions). The authority shape now also fails if rule 13 or
  the ticket check stop calling `checkRewardRiskFloor`, or the draft stops
  reading `loadEffectiveLimits(userId).discipline.minRewardRiskRatio`.

Behaviour changes (decision 10):

- Pending-order drafts whose R:R is below the trader's effective floor are
  refused (`rg_rr_ratio_min`), including traders with no settings row (the
  1.5 default) and `SIMULATED` drafts. Before, no floor ever ran there.
- A draft is refused when the trader's limits cannot be read.

### Decision 9: daily-trade limit vs operational rate cap (`r5/risk-2`)

> Use the governor's authoritative trading-day definition and activity
> source for the daily-trade limit. Preserve the existing rolling-24-hour
> approved-command restriction as a separately named operational rate cap,
> with its own clear reason.

- `preTrade.tradingDayStart(now)` is the governor's trading day: the UTC
  calendar day containing `now`. `summarizeActivity` and the governor's
  "today" P/L use it. `enforce.loadTradingActivity(userId, venue)` returns
  the governor's own rule-13 activity facts for a venue (PAPER: the active
  paper account's `paper_orders`; DEMO: `trades`; LIVE: `arx_live_positions`),
  for views and advisory checks that show or apply the daily-trade limit.
- Order guard (`lib/adminTrading/orderGuard.ts`): the rolling-24h count of
  this trader's APPROVED `trade_command_audit_log` rows moved out of gate 6
  into its own gate 6b, `operational_rate_cap`, with its own reason
  `OPERATIONAL_RATE_CAP_REACHED:<n>_APPROVED_COMMANDS_PER_ROLLING_24H`
  (`operationalRateCapCheck`, `operationalRateCapRefusal`). It still reads
  the operator's `max_trades_per_day` and still runs at the same point in
  the chain, so it refuses exactly when it did before; only the code and
  name changed. The daily-trade limit itself (strictest of trader and
  operator caps, on the trading day) is the governor's, at gate 9b. Neither
  replaces the other.
- `routes/tradeDecision.ts` (advisory): "trades today" for its daily-trade
  blocker is now the governor's PAPER activity (`loadTradingActivity`),
  not paper orders opened today among the trader's last 20 orders. If the
  activity cannot be read it adds a blocker saying so (no active paper
  account = nothing to count, not a blocker).
- `lib/riskAudit.ts` (legacy `/risk/audit`, `/mt5/execute`): "today" (trade
  count and daily P/L) starts at the governor's trading day (UTC) instead of
  server-local midnight. Its source is still the legacy `trades` table (see
  "What remains").
- `single-risk-limit-source` fails if the order guard names its rolling
  count `TRADES_PER_DAY` again, drops the `operational_rate_cap` gate or its
  reason, or `tradingDayStart` disappears.

Behaviour changes (decision 9):

- Order guard refusal code `MAX_TRADES_PER_DAY_REACHED:<n>` is now
  `OPERATIONAL_RATE_CAP_REACHED:<n>_APPROVED_COMMANDS_PER_ROLLING_24H`, from
  gate `operational_rate_cap` (the audit snapshot's gate list gains that
  name). Same condition, same position. No caller matched on the old code.
- Trade-decision blocker "Daily trade cap hit (n / m)" is now "Daily trade
  limit reached (n / m trades today, UTC)", counted from the governor's
  PAPER activity (closed on the trading day plus opened on it and still
  open, active paper account), so `n` can differ from before.
- `/risk/audit` and the legacy `/mt5/execute` risk check count "today" from
  UTC midnight. On a server running in UTC nothing changes.

Tests: `test:risk-governor-rr-daily` (new, real DB, wired into
`ci:integration`): `checkRewardRiskFloor` boundaries (at the floor passes,
below refuses, BUY and SELL, missing stop / target / reference / side,
wrong-side geometry, NaN, floor off); the ticket rule in all three modes;
the draft route against a saved floor of 2, the 1.5 default with no row and
a saved 0; the UTC trading-day boundary (a close at 23:59:59.999 is
yesterday); the rate cap's rolling window (inside / outside 24h, REJECTED
rows, another trader, no cap, reason text never says "per day"); and both
caps at 00:30 UTC (yesterday 23:50 is outside the governor's day but inside
the rate window). `check-single-risk-limit-source.test.ts` gains 8 shape
assertions.

### Decision 8: status views show the limit in force (`r5/risk-3`)

> Status views show the effective limit enforced by the Risk Governor
> (loadEffectiveLimits), with the saved preference shown separately and the
> reason an override applies. Remove contradictory display defaults and
> duplicate calculations. Editing endpoints keep editing the preference.

New in the risk authority (reads and explains only; decides nothing):

- `limitSettings.loadEffectiveLimitsMany(userIds)`: the limits in force for
  several traders (two batched reads, `resolveEffectiveLimits` per trader).
- `limitLayers.effectiveLimitViews(rows)`: per limit, `{ effective,
  preference, source, winner, overriddenBy, reason }`. `overriddenBy` is
  `account` (operator stricter), `platform` (ceiling stricter), `default`
  (nothing saved, the governor's default applies), `disabled` (the trader
  switched it off) or `null` (the saved value is what is enforced). Covers
  every limit of `explainLimitLayers` plus the streak, cooldown and minimum
  R:R.
- `preTrade.dailyLossCapAmount(L, equity)`: the daily loss in money at which
  rule 7 blocks, the stricter of the enforced amount and the enforced
  percent of equity; `null` when no daily-loss limit applies (or only a
  percent applies and equity is unknown). Rule 7 itself is unchanged.

Views moved:

- `routes/meRiskGovernor.ts`: `/me/risk/status` adds `effective` (all
  views) and `activitySource`; its cooldown uses the enforced cooldown
  (none when switched off). `/me/risk/daily-status` returns the enforced
  `maxTradesPerDay`, `maxDailyLossPercent` and `maxConsecutiveLosses`
  (`null` = no limit), adds `preference` (the saved values), `effective`
  (views for those three), `tradingDay: "UTC"` and `activitySource`. The
  settings endpoints (`GET/POST/PATCH /me/risk-settings`, reset) are
  unchanged: they edit the preference.
- `routes/portfolioRisk.ts`: the engine gets the enforced max open trades,
  daily-loss percent, risk per trade, open-risk cap
  (`maxPortfolioRiskPercent`) and the governor's daily-loss cap in money.
  The 2 / 2% / 0.5% display defaults are gone; an anonymous read uses the
  governor's defaults (`resolveEffectiveLimits({})`). The persisted
  `inputsSnapshot.settings` records the enforced values and their sources.
  `@workspace/domain/portfolio-risk` gains two optional inputs
  (`maxOpenRiskPct`, `dailyLossCapAmount`); without them it computes as
  before.
- `lib/readiness/traderReadiness.ts`: max open paper trades is the enforced
  value; the daily-loss limit is `dailyLossCapAmount` against the active
  paper account's equity instead of "$50 per 1%". Both are `null` when no
  limit is enforced, and the checks that use them skip. (Its paper P/L
  status filter is decision 7.)
- `lib/alerts/ruleEngine.ts` (NEAR_DAILY_LOSS_LIMIT): the cap is
  `dailyLossCapAmount` of the trader's limits in force, against the
  recorded end balance. The operator USD cap counts, the trader's off
  switch is respected, and an amount cap is checked even without an end
  balance.
- `routes/meAccountShell.ts`: each risk number is the stricter of this
  account lane's cap (master live access, or governance when Owner Live
  Control is on) and the governor's enforced value; the trader's saved
  values no longer stand in for a missing lane cap. `requireStopLoss` is
  true when the lane or the governor requires it. `availableRiskAmount`
  uses the enforced per-trade percent (and amount). Additive:
  `risk.preference` (saved values) and `risk.limits` (views with reasons).
- `routes/meDashboard.ts`: `/me/dashboard/cards` (risk card trades-today
  and losses caps, warning status), `/me/dashboard/intelligence` (cooldown,
  new `risk.effective` views; `risk.settings` stays the saved row) and
  `/me/session-health` (`riskUsage`, cooldown, the approaching-cap
  recommendation) use the limits in force. The trade-quality score still
  grades against the saved risk % and R:R (a score of the trader's own
  plan, not a limit display; listed under "What remains").
- Dashboard: `my-paper-trades` shows the enforced streak and cooldown with
  "Enforced limit" / "Not enforced" and the reason; `my-account` adds a
  "limits in force" note listing operator / platform overrides. Types are
  additive (optional fields).
- `single-risk-limit-source`: `traderReadiness`, `ruleEngine`,
  `meAccountShell` and `portfolioRisk` leave the allowlist (32 → 28). The
  shape check fails if `dailyLossCapAmount` disappears, if portfolio risk,
  readiness or the alert stop using it, or if the account shell stops using
  `effectiveLimitViews`.

Behaviour changes (decision 8):

- `/me/risk/daily-status`: `maxTradesPerDay`, `maxDailyLossPercent`,
  `maxConsecutiveLosses` are the enforced values (were the saved values)
  and may be `null`; `dailyTradeCapHit` / `consecutiveLossCapHit` follow
  them. `/me/risk/status` cooldown follows the enforced cooldown.
- Portfolio-risk snapshot (and the trade-plan validate hook that uses it):
  limits are the enforced ones (defaults 3 / 3% / 1% instead of
  2 / 2% / 0.5%; operator caps count), the open-risk cap is the enforced
  `maxPortfolioRiskPercent`, and the daily rule uses the governor's cap in
  money (percent of equity, or the amount). With no daily-loss limit
  enforced the daily rule does not run. Levels and warnings can differ.
- Trader readiness: `metrics.dailyLossLimit` and
  `metrics.maxOpenPaperTrades` are the enforced values (`number | null`);
  `DAILY_LOSS_LIMIT_EXCEEDED`, `DAILY_LOSS_NEAR_LIMIT`,
  `MAX_OPEN_PAPER_TRADES_EXCEEDED` and the matching score deductions use
  them and do not apply when no limit is enforced. The AACI snapshot reads
  the nullable value safely.
- NEAR_DAILY_LOSS_LIMIT alert: can fire on an operator USD cap, no longer
  fires for a trader who switched daily-loss blocking off (without an
  operator cap), applies the governor's 3% default to a trader with no saved
  row, and checks an amount cap without an end balance.
- `/me/account-shell` `risk.maxLotSize`, `maxOpenTrades`,
  `maxDailyLossAmount`, `requireStopLoss`, `availableRiskAmount`,
  `dailyLossRemaining` are the limits in force (can be stricter than
  before); new `risk.preference`, `risk.limits`.
- Dashboard cards / intelligence / session health: caps, cooldown, the
  "warning" status and the approaching-cap recommendation follow the
  enforced values (an operator cap shows; a switched-off streak or cooldown
  shows as no limit).

Tests: `test:risk-governor-effective-views` (new, real DB, wired into
`ci:integration`): the views (operator override with reason, default,
switched off), `dailyLossCapAmount`, the portfolio engine's new inputs,
`/me/risk/status` and `/daily-status` (enforced, preference, reason),
`PATCH /me/risk-settings` still editing only the preference, the dashboard
cards and intelligence, the portfolio snapshot without 2 / 2 / 0.5, trader readiness (enforced values, off → no
daily-loss block), the alert (operator cap fires at 90 of 100; off switch
quiet) and the account shell. `check-single-risk-limit-source.test.ts`
gains 4 assertions. `test:account-shell-route`, `test:alert-rule-ownership`,
`test:limit-layers` and `test:one-limit-store` pass unchanged.

### Decision 7: paper_orders for automated PAPER facts (`r5/risk-4`)

> Use paper_orders, through the paper-book authority, for automated PAPER
> P/L, activity, losing streaks and risk decisions. paper_trades remains a
> manually entered journal. trades remains historical legacy data. Do not
> mix these sources or double-count them. Missing historical coverage must
> not silently reset losses or restore a risk budget. Do not change DEMO
> accounting as a side effect.

Survey first (what each automated PAPER reader used before this branch):

| Reader | Before | Now |
|---|---|---|
| Risk Governor PAPER facts (`enforce.loadPaperFacts`, `loadTradingActivity`) | `paper_orders` of the active paper account, own queries | the same rows through the read side |
| `tradeDecision` open trades / losing streak | `paper_orders` direct (all accounts); streak from fill prices over the last 20 orders by id | read side; streak = governor's measure over all accounts, at least the governor's (see below) |
| `traderReadiness` daily / weekly P/L, win rate, drawdown, decision win rate | `paper_orders` filtered on status `CLOSED`, which the venue never writes, so every P/L read 0 | read side; settled = `CLOSED_SL` / `CLOSED_TP` / `CLOSED_MANUAL` (and a venue-settled `CANCELLED`) |
| Autopilot daily P/L and open caps (`paperAutopilot`) | `paper_orders` direct (owner + EE strategy) | read side, same scope |
| Build EE eligibility open count (`paperExecutionService`) | `paper_orders` direct (account) | read side |

Not PAPER facts, so unchanged: `riskAudit` / `/mt5/execute` (legacy
`trades`), `permission.ts` (the live / broker execution permission verdict;
reads `trades`, the DEMO ledger), the governor's DEMO facts (`trades`) and
LIVE facts (`arx_live_positions`). `meRiskGovernor` `/me/risk/status`,
`/daily-status` and the post-close hooks follow `paper_trades` on purpose:
they are the hand-entered journal's discipline view (`activitySource:
"paper_trades"` says so), not automated PAPER facts.

The read side, `lib/tradeEngine/paperBookReader.ts` (reads only, next to
the venue that writes the book):

- scopes: one account (the governor), one trader (all accounts), the
  autopilot owner + strategy (owner `null` = ownerless rows), the
  operator's whole install;
- `readActivePaperAccount`, `readOpenPaperOrders`,
  `readPaperOrdersOpenedSince`, `countPaperOpenedSinceStillOpen`,
  `sumPaperRealizedSince`, `readPaperCloses`, `readPaperOrders`,
  `isSettledPaperStatus`, `realizedOf`;
- "settled" = status not `OPEN` with a `closed_at` (a voided order never
  counts); realized = `profit_loss` (`realizedOf` reads the sign from the
  fills if a settled row ever lacks it; the column is `NOT NULL DEFAULT 0`
  today, so this is defensive only).
- It never reads `paper_trades` or `trades`; nothing sums across tables.

Conservative handling:

- The governor's PAPER facts read exactly the rows they read before (same
  scope, statuses and time bounds); only the query moved.
- `tradeDecision` losing streak (`paperLosingStreak`, exported for tests):
  the governor's streak measure (`summarizeActivity`) on settled
  `paper_orders` P/L over every paper account of the trader, and never
  shorter than the governor's own active-account streak. Like the old
  calculation it spans every account, so switching paper accounts cannot
  reset it; unlike it, the order is by close time (not by order id) and the
  sign is the recorded P/L (not the raw price move).
- Readers fail closed as before: a read error in the governor blocks
  (unchanged); `tradeDecision` adds its "activity could not be read"
  blocker; readiness reports `paper_orders` under `missingDataSources`.
- No coverage gap needed a legacy carry: every automated PAPER reader
  already read `paper_orders`; none read `paper_trades` or `trades` for
  PAPER, so there is no historical P/L to carry over and no budget is
  restored.
- `single-risk-limit-source` shape check: the five reader files above may
  not reference `paperOrdersTable` (read through the read side) or
  `paperTradesTable` (the journal is not a paper fact), and must import the
  read side. `check-single-risk-limit-source.test.ts` gains 4 assertions.

Behaviour changes (decision 7):

- Trader readiness: `dailyPnl`, `weeklyPnl`, `winRate30d`, `sampleSize`,
  `maxDrawdown` and `decisionToWinRate` now reflect settled paper orders
  (they were 0 / empty because of the `CLOSED` filter). With PR3's enforced
  limits, `DAILY_LOSS_LIMIT_EXCEEDED` / `DAILY_LOSS_NEAR_LIMIT` and the
  readiness score can now trigger on real paper losses.
- Trade decision revenge guard: the losing streak counts settled paper
  orders by close time across all the trader's paper accounts (P/L sign
  from `profit_loss`, not the price move; order by close time, not order
  id), and is never shorter than the governor's streak. The count can
  differ from before when orders closed out of id order.
- DEMO: none. LIVE: none. Governor PAPER decisions: none (same rows).

Tests: `test:risk-governor-paper-facts` (new, real DB, wired into
`ci:integration`): no double count (the governor's PAPER P/L and readiness
P/L exclude a journal loss and a legacy `trades` loss on the same day),
the read side's settled / open / realized per scope (voided order ignored,
ownerless strategy rows), missing coverage stays conservative (account
switch keeps the streak; never shorter than the governor's), tenant
isolation (another trader's losses never count), and DEMO unchanged (DEMO
activity and P/L still from `trades`, untouched by paper rows).

What remains (decision 7):

- Analytics readers of `paper_orders` (`performanceCC`, coach, analytics
  and debrief routes, notifications ingest) still query the table directly.
  They are reports, not P/L-driven risk decisions; moving them onto the
  read side is mechanical. `notifications/ingest.ts` matches closed
  statuses (`CLOSED`, `TP_HIT`, `SL_HIT`, `MANUAL_CLOSED`) the venue does
  not write (it writes `CLOSED_SL` / `CLOSED_TP` / `CLOSED_MANUAL`); not
  changed here.
- `riskAudit` and `/mt5/execute` stay on legacy `trades`, unscoped by user.

**TIER 1 NOT COMPLETE**
