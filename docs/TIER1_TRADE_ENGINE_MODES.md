# Tier 1: Trade Engine modes (LIVE / DEMO / PAPER)

Base: `c1b3b98` (PR #34). This change carries out the Trade Engine step of the
2026-10-24 handoff: DEMO and PAPER become modes of one execution pipeline
instead of separate execution paths. Tier 1 is not complete after it, and the
published scorecard is unchanged.

A second round (base `516f13e`, PR #35) added a staged contract to the
pipeline and moved the staged producers and `executeInstant` onto it. It is
described in [Round 2](#round-2-staged-contract) below. Sections marked
"round 1" describe PR #35.

A third round (base `18b1e01`, PR #40) made the pipeline the one entry every
producer calls: the one-click router and the caller-priced PAPER fills are
now reached only through it. It is described in
[Round 3](#round-3-one-entry-for-every-producer).

A fifth round (base `2a0b3f6`, PR #48) carries out the owner's Trade Engine
decisions 13, 14 and 15 of 2026-10-25. It is described in
[Round 5](#round-5-owner-decisions-13-14-15). These decisions intentionally
change behaviour; each change is listed there and covered by a test.

## Round 5: owner decisions 13, 14, 15

The owner decided (2026-10-25, verbatim in the round brief):

- **14.** Retire the legacy `/execute-trade` execution path. Inventory and
  migrate its callers to the canonical PAPER pipeline, then refuse the
  retired endpoint with an actionable response. Preserve historical `trades`
  rows and explain that their old `mode` field represented Safety Core state,
  not actual broker execution. Never silently convert a requested LIVE trade
  into PAPER.
- **13.** Confirmed SIMULATED opens in the Trade Action Center and My Trades
  create PAPER orders through the existing pipeline. Previews and drafts
  create nothing. Explicit simulated-mode labelling, normal risk checks,
  valid price provenance, retry-safe idempotency, no fabricated fills.
- **15.** My Trades DEMO opens go through the existing governed pipeline
  (mode, ownership, confirmation, readiness, sizing, Risk Governor). My
  Trades LIVE opens stay refused until broker validation passes and the
  owner separately authorizes that surface. Live trading is not turned on.

### Decision 14: `/execute-trade` retired

**Caller inventory** (searched `artifacts/`, `lib/`, `scripts/`,
`mt5-bridge-export/` for `execute-trade`, `executeTrade`, `useExecuteTrade`
and `execute_trade`):

| Caller | What it was | Action |
|---|---|---|
| `routes/trades.ts` `POST /execute-trade` | the endpoint itself | now refuses (below) |
| `lib/api-client-react` `executeTrade` / `useExecuteTrade`, `lib/api-zod` `ExecuteTradeBody` (generated) | generated client bindings | no runtime caller in the dashboard, server or scripts. The OpenAPI operation is marked `deprecated` with a 410 response and the clients were regenerated (`ExecuteTradeResponse` is gone) |
| `artifacts/trading-dashboard/src/pages/emergency.tsx` | user-facing copy only (no request) | copy now says the endpoint is retired and places nothing |
| `artifacts/api-server/tests/phase1.test.mjs`, `phase2.test.mjs`, `phase2-validation.test.mjs` | legacy server-dependent suites (`pnpm --filter @workspace/api-server run test`, not in `ci`); unauthenticated, so already refused with 401 since Phase-2 `requireUser` | header note added; they did not mean a simulated order, they drove the Safety Core through this endpoint, so there is nothing to migrate to PAPER |
| Ruby / assistant tools, scripts, mt5-bridge-export | none call it (only forbidden-pattern lists and comments name it) | unchanged |

No runtime caller meant a simulated trade, so nothing was migrated to
`submitTrade` mode PAPER by this decision; the paths that replace it are
`POST /api/paper/orders` (PAPER, already `submitTrade` mode PAPER) and the
Trade Action Center (DEMO / LIVE through the pipeline).

**The endpoint now** (`routes/trades.ts`): an unauthenticated call is still
refused first (401, `requireUser`). Every authenticated call returns **410**
with:

```json
{ "ok": false, "success": false, "code": "EXECUTE_TRADE_RETIRED",
  "executed": false, "converted": false,
  "instead": { "PAPER": { "path": "/api/paper/orders" }, "DEMO": { "path": "/api/me/trade-actions" }, "LIVE": { "path": "/api/me/trade-actions" } },
  "history": { "path": "/api/trades" } }
```

No gate runs, no `execution_confirmations` row is claimed or rejected, no
vault trade log is written and no `trades` or `paper_orders` row is created.
A body that asks for LIVE gets the same refusal: nothing is converted into a
simulated trade.

**Historical rows:** `trades` keeps every row and column. `GET /trades` and
`GET /trades/open` still return the caller's own rows. The `mode` column is
documented (schema comment in `lib/db/src/schema/trades.ts`, no column
change) as the Safety Core state at the time, not a broker execution.
`cancelOpenLegacyTrades` (bot emergency stop) and `applyPaperManagement`
(Position Guardian exit door) still manage existing rows.

**Guards:**

- `single-paper-book`: `recordLegacyExecuteTrade` is deleted from
  `lib/trades/paperBook.ts` and fenced: its `BOOK_API` entry now has no
  allowed caller, so any call fails. New: the legacy book may not insert into
  `trades` at all, even as the table's owner (drizzle or raw SQL); updates of
  existing rows stay allowed. 64 fixtures (was 60): the old passing
  `routes/trades.ts` caller fixture now fails, plus one more caller and three
  shape fixtures.
- `trade-engine-single-pipeline`: the `PAPER_WRITERS` reason for
  `lib/trades/paperBook.ts` now says it is closed to new rows.
- `single-safety-switch-source`: the `routes/trades.ts` single-stop entry
  (the `/execute-trade` TOCTOU re-check) is removed; that code is gone, so
  the entry would be stale. Owner decision 3 (legacy gates honour both stops)
  no longer applies to `/execute-trade`: it refuses everything.

**Tests:** `test:execute-trade-retired` (new, in `ci:integration`, 5 cases):
401 unauthenticated; 410 with the code and the replacement paths for a
normal, an empty and a low-confidence body, with no `trades` or `paper_orders`
row written; a LIVE body refused and not converted; a confirmation id left
`CONFIRMED`; historical rows still readable and owner-scoped.
`test:paper-book` inserts its legacy fixture rows directly now.

### Behaviour changes (round 5)

1. `POST /execute-trade` returns 410 `EXECUTE_TRADE_RETIRED` for every
   authenticated request (before: Safety Core gate, then 409 refusals or a
   200 with a new `trades` row). Nothing is recorded. *(decision 14)*

### What remains (round 5)

1. `tradeGate` in `lib/safetyCore.ts`, `claimConfirmationForExecution` /
   `markConfirmationExecuted` / `markConfirmationRejected` in
   `routes/executionConfirmations.ts`, and the vault trade loggers it used
   now have no runtime caller. They are left in place (no behaviour); the
   Pre-Trade Checklist confirmations no longer back any execution.
2. The Risk Governor still reads `trades` for non-LIVE realized P/L; owner
   decision 7 (paper P/L from `paper_orders`) belongs to the Risk Governor
   worker. Since nothing writes new `trades` rows, that source is now frozen
   history.
3. `docs/TIER1_PLATFORM_SAFETY_SOURCE.md` still lists the `/execute-trade`
   re-check among the legacy gates; that doc belongs to the Platform Safety
   worker.

## Round 3: one entry for every producer

### What changed in this round

The pipeline gained two channels next to `submitTrade` and the staged
contract:

```ts
submitInstantTrade(args)                                  // → lib/live/instantTrade.ts executeInstant
fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, args)   // → paperVenue.openPaperFill
fillPaperTrade({ mode: "PAPER", intent: "CLOSE" }, args)  // → paperVenue.closePaperFill
settlePaperTrade(args)                                    // → paperVenue.settlePaperOrder
voidPaperTrade(orderId)                                   // → paperVenue.voidPaperOrder
```

Like the staged contract, each one passes the caller's arguments through
unchanged and returns the delegate's result unchanged (the TypeScript types
are taken from the delegate). They add no gate and remove none.

- **One-click LIVE.** `executeInstant` keeps all of its own gates (Ruby
  authorization, one-click settings, master-live access, rate limit, symbol
  cooldown, the per-user lock, `prepareOnly`, its `one_click_audit` rows) and
  still reaches Phase B through the staged contract. The import cycle
  (`instantTrade` imports the staged contract from the pipeline) is broken by
  loading `instantTrade` lazily inside `submitInstantTrade`, the same way the
  pipeline already loads every venue queue.
- **Caller-priced PAPER fills.** The venue still runs the Risk Governor
  (venue PAPER, OPEN / CLOSE) before it books, and a refusal still returns
  the governor's full decision (`risk.primaryReason`, `blockedBy`,
  `auditEventId`). Build EE writes that detail into its rejection rows, so
  it had to survive the move exactly.
- **The guardian's stop restore** (`guardianRestoreStop` in the exit door) is
  now a `submitTrade({ mode: position.venue, intent: "MODIFY", target:
  { position } })`. With the position already resolved and the mode set to
  its own venue, the pipeline goes straight to
  `governedOps.submitGovernedModify` with the same arguments, so the
  semantics are identical. The pipeline's result is mapped back to the
  `GovernedOpResult` shape (`{ ok, commandId, reason }`) that `reconcile.ts`
  reads.

Producers moved onto the pipeline:

| File | Before | Now |
|---|---|---|
| `lib/missionExecution.ts` | `executeInstant` (default executor) | `submitInstantTrade` (default executor) |
| `lib/missionExitManager.ts` | `executeInstant` (default executor handed to the exit door) | no default of its own: the exit door's default (`submitInstantTrade`) applies. A guardian rule module may not import `tradeEngine/` |
| `lib/selfTrade/agentExecutor.ts` | `executeInstant` | `submitInstantTrade` |
| `routes/instantTrade.ts` | `executeInstant` (execute, close, close-all) | `submitInstantTrade` |
| `routes/meAssistant.ts` | `executeInstant` | `submitInstantTrade` |
| `lib/positionGuardian/manage.ts` | `executeInstant` (default executor), `submitGovernedModify` | `submitInstantTrade` (default executor), `submitTrade` MODIFY |
| `lib/paperExecution/paperExecutionService.ts` | `openPaperFill`, `voidPaperOrder` | `fillPaperTrade` OPEN, `voidPaperTrade` |
| `lib/paperExecution/paperExecutionMonitor.ts` | `closePaperFill`, `settlePaperOrder` | `fillPaperTrade` CLOSE, `settlePaperTrade` |
| `routes/autoDebrief.ts` | `openPaperFill`, `settlePaperOrder` | `fillPaperTrade` OPEN, `settlePaperTrade` |

Tests that inject an `executor` (the exit door's `guardianInstantManage`,
`dispatchApprovedDraft`, `manageMissionTradeExit`) work as before; only the
default changed.

Guards tightened in this round:

- `trade-engine-single-pipeline`:
  - `ENTRY_PRODUCERS` drops from 11 entries to 2: the pipeline and its
    `governedOps` leg. (`instantTrade.ts` owns `executeInstant` and calls only
    the staged contract, so it needs no entry.)
  - `LIVE_INSTANT` (`executeInstant`) and `PAPER_FILL` (the four venue fill
    functions) are now **pipeline-only**: any other runtime file that names
    them fails, including as a default executor value or through a dynamic
    import, and the message names the pipeline channel to use. A separate
    check refuses any `ENTRY_PRODUCERS` entry that grants a pipeline-only
    entry to another file, so the allowlist cannot be widened back.
  - The shape check requires the pipeline to export `submitInstantTrade`,
    `fillPaperTrade`, `settlePaperTrade` and `voidPaperTrade` and to delegate
    to `executeInstant`, `openPaperFill`, `closePaperFill`,
    `settlePaperOrder` and `voidPaperOrder`.
  - Stale-entry detection is unchanged. 113 fixtures, including failing
    fixtures for a new direct `executeInstant` caller and a direct
    `openPaperFill` caller, for each of the nine moved files.
- `single-paper-book`: the four fill functions' caller lists are now the
  pipeline only (60 fixtures).
- `single-position-guardian`:
  - `submitInstantTrade`, `fillPaperTrade`, `settlePaperTrade` and
    `voidPaperTrade` count as execution calls.
  - **Bug fixed:** the `EXECUTION_MODULES` pattern only matched a specifier
    that *ended* in `tradeEngine/`, so a rule module importing
    `../tradeEngine/pipeline.js` was not caught. It now matches any module
    under `tradeEngine/`. The tree was already clean under the stricter rule
    (29 fixtures).
- `position-guardian-wired`: `guardianRestoreStop` must submit a Trade
  Engine MODIFY on the governed position, checked inside that function's
  body only (the old pattern could be satisfied by a call later in the
  file), and the pipeline must still delegate MODIFY to
  `submitGovernedModify`. New fixtures cover both.
- `assistant-no-direct-execution`, `chart-trade-no-direct-execution`,
  `mission-no-direct-execution`: the required router anchor is now
  `submitInstantTrade` (a bare `executeInstant` call no longer satisfies it).
  The mission exit's anchor is the guardian exit door
  (`guardianInstantManage`). The mission planning/backtest isolation list
  also forbids `submitInstantTrade`, `submitTrade`, `guardianInstantManage`
  and `/tradeEngine/` imports. The chart-trade test now imports the guard's
  own required list instead of keeping a copy.
- `broker-hub-no-execution`, `backtest-no-live-execution`,
  `master-live-bridge-binding`, `master-live-user-access`,
  `scanner-selected-market`, `unified-readiness-no-dispatch`,
  `fix-agent-import-boundary`: their forbidden lists now also name
  `submitInstantTrade` (the last two also `fillPaperTrade`).

New database cases:

- `test:trade-engine-staged`: `submitInstantTrade` returns exactly
  `executeInstant`'s result and writes the same `one_click_audit` rows, for a
  demo-mode refusal and a refused live order (7 cases).
- `test:paper-book`: `fillPaperTrade` OPEN books the same row and event as
  `openPaperFill`; a governor refusal carries the same `blockedBy` and
  `primaryReason` and its own audit id; CLOSE is owner-scoped and returns the
  same P/L; settle and void are not re-governed; an unknown stage books
  nothing (7 cases).

### Behaviour changes in this round

- None for any valid request: same gates, same audit rows, same results,
  status codes and response shapes.
- Load order only: `missionExitManager`, `meAssistant` and the paper
  producers no longer import `instantTrade` / `paperVenue` statically. The
  pipeline loads them on first use (`await import`, cached after that).
- `guardianRestoreStop` now goes through two more in-process checks that it
  always passes: the mode is in `TRADE_MODES` and equals the position's venue
  (both by construction). A refusal from `submitGovernedModify` whose reason
  was `null` would now read `"REFUSED"`; every refusal path in
  `governedOps` returns a string reason, so this cannot happen today.
- `fillPaperTrade` with an unknown stage returns
  `{ ok: false, reason: "UNKNOWN_TRADE_MODE" }`, like the staged contract. No
  typed caller can reach it.

### What remains after this round

1. **Remaining allowlist (2 entries):** the pipeline and its `governedOps`
   leg. Both are internal to the Trade Engine.
2. **`submitInstantTrade` and the fill channel are siblings of
   `submitTrade`, not `submitTrade` intents.** `executeInstant` returns its
   own `InstantTradeResult` (HTTP status, Ruby refusals, `detail`), and the
   fills return the governor's `EnforceResult`. Folding them into
   `submitTrade`'s `TradeResult` would change the shapes their callers read,
   so they stay separate entries on the one module. The one-click gates still
   live in `instantTrade.ts`, not in the pipeline.
3. **The pipeline's own LIVE OPEN** (`submitTrade` mode LIVE) still uses the
   staged steps directly, without the one-click gates, as the Trade Action
   Center did before. Which entry a surface uses is unchanged.
4. Items 2 to 5 of the round 2 list (the public staged contract, untracked
   cancel/list/read calls, the My Trades DEMO close mailbox exception, paper
   books / SIMULATED paths / no published score) are unchanged.

## Round 2: staged contract

### What changed in this round

The pipeline now has a staged contract for flows that draft now and confirm or
dispatch later (often in a separate request), or that must hold a lock or
write attribution between the steps:

```ts
draftTrade({ mode: "LIVE", kind: "ENTRY" }, input)  // → createLiveDraft
draftTrade({ mode: "LIVE", kind: "OPS" }, input)    // → createLiveOpsDraft (close / modify a ticket)
draftTrade({ mode: "DEMO" }, input)                 // → createDraftCommand
confirmTrade({ mode: "LIVE" | "DEMO" }, args)       // → confirmLiveCommand | confirmCommand
dispatchTrade({ mode: "LIVE" | "DEMO" }, args)      // → dispatchLiveCommand | dispatchApprovedCommand
```

Each call passes the caller's input object to the venue queue unchanged and
returns the queue's own result unchanged. The TypeScript overloads keep the
queue's exact input and result types, so the refusal reasons, HTTP status
codes and response bodies built from them stay the same. The contract adds no
gate and removes none, and it writes nothing itself.

Producers moved onto the staged contract. Each one makes the same calls, in
the same order, with the same arguments, inside the same locks:

| File | Steps it uses |
|---|---|
| `routes/meLive.ts` (staged live API, close, close-all, modify, controlled test) | LIVE ENTRY / OPS draft, confirm, dispatch |
| `routes/meOneClick.ts` (one-click submit-live) | LIVE ENTRY draft, confirm, dispatch |
| `routes/tradesLiveShared.ts` (shared-master ticket, close, modify) | LIVE ENTRY / OPS draft, confirm, dispatch |
| `routes/meTrades.ts` (My Trades LIVE close) | LIVE OPS draft, confirm, dispatch |
| `routes/meDemoCommands.ts` (staged demo API) | DEMO draft, confirm (dispatch stays on its per-user demo endpoint) |
| `lib/live/emergencyClose.ts` (platform safety) | LIVE OPS draft, confirm, dispatch |
| `lib/live/liveTestCycle.ts` (platform safety) | LIVE ENTRY / OPS draft, confirm, dispatch (the dry-run preview still cancels its draft directly) |
| `lib/live/instantTrade.ts` (`executeInstant`) | LIVE ENTRY / OPS draft, confirm, dispatch |

`emergencyClose` and `liveTestCycle` were moved because the change is a
straight rename of three calls with the same arguments. The emergency close
still passes its CLOSE-only kill-switch bypass to `createLiveOpsDraft`
untouched.

**`executeInstant` is now a caller of the pipeline.** Its own gates still run
first and are unchanged: Ruby authorization, one-click settings, the
master-live access check, rate limit, symbol cooldown, the per-user submit
lock, the `prepareOnly` stop and its `one_click_audit` rows. It no longer
calls the live queue itself. Its callers (missions, self-trade, the
assistant, the instant-trade route and the Position Guardian exit door) still
call `executeInstant`. Its result shape and status codes are unchanged.

Guards tightened in this round:

- `trade-engine-single-pipeline`:
  - The 8 producers above were removed from the allowlist, which drops from
    16 to 8 entries. Any of them calling a queue directly now fails.
  - The guard checks that the pipeline exports `draftTrade`, `confirmTrade`
    and `dispatchTrade`, and that it delegates to all seven queue steps.
  - It checks, from the AST and in code only, that `executeInstant` drafts,
    confirms and dispatches through the staged LIVE contract.
  - 64 fixtures, up from 46.
- `single-position-guardian`: `submitTrade`, `draftTrade`, `confirmTrade` and
  `dispatchTrade` now count as execution calls. A guardian rule module, or an
  unregistered module that reads positions, cannot reach execution through
  the Trade Engine under a new name.
- `live-dispatch-cas`: counts the `dispatchTrade({ mode: "LIVE" })` sites in
  `meLive.ts` against its per-user lock scopes. It also requires the staged
  LIVE dispatch to delegate to `dispatchLiveCommand`.
- `one-click-arm-routes-through-gate`, `one-click-concurrency` and
  `qaOneClickConcurrency`: each requires a real staged LIVE dispatch call in
  code and requires it to delegate to `dispatchLiveCommand`. The old
  `one-click-concurrency` check also passed on a comment that only mentioned
  the name.
- `master-live-bridge-binding`, `master-live-user-access`,
  `unified-readiness-no-dispatch`, `fix-agent-import-boundary`,
  `scanner-selected-market`, `broker-hub-no-execution` and
  `backtest-no-live-execution`: their forbidden lists now also include the
  Trade Engine (`/tradeEngine/` imports, `submitTrade` and `dispatchTrade`).
  Before this change, these surfaces could have reached dispatch through
  `submitTrade` without these guards noticing.
- `modeScopeContractTest`: My Trades may use only the staged OPS draft and the
  LIVE dispatch. It may not use an ENTRY draft or `submitTrade`.

New database test `test:trade-engine-staged` (6 cases, wired into
`ci:integration`). It sends each staged step for LIVE ENTRY, LIVE OPS and
DEMO twice: once through the pipeline and once straight to the venue queue.
It checks that both return the same draft, confirm and dispatch results and
refusals and write the same rows. It also checks that an unknown stage is
refused. The trader is armed for neither venue, so nothing is dispatched and
the EA mailbox stays empty.

### Behaviour changes in this round

- None for any valid request: same gates, same audit rows, same results,
  status codes and response shapes.
- Load order only: `meOneClick`, `meTrades`, `emergencyClose` and
  `instantTrade` no longer import the live queue statically. The pipeline
  loads it on first use (`await import`, cached after that). Other modules
  load the queue at server start anyway.
- If the staged contract is called with an unknown `mode` or `kind`, it
  returns `{ ok: false, reason: "UNKNOWN_TRADE_MODE" }`. That matches
  `submitTrade`. No typed caller can reach this case.

### What remains after this round

Item 1 was addressed in Round 3: every `executeInstant` caller and the
guardian exit door now go through the pipeline, and the allowlist is down to
2 entries.

1. **Remaining allowlist (8 entries):**
   - The pipeline and its `governedOps` leg.
   - The five `executeInstant` callers: missions entry and protective exit,
     the self-trade agent, the instant-trade route and the assistant route.
   - The Position Guardian exit door.

   The `executeInstant` callers are still listed because `executeInstant` is
   a one-click front door with gates of its own, and it is not yet a mode of
   `submitTrade`. Folding it in (for example `submitTrade({ mode: "LIVE",
   oneClick })`) would move its gates and audit rows into the pipeline. That
   is a larger change and needs its own review.
2. **The staged contract is public, like `submitTrade`.** Any runtime file may
   call it, as it may call `submitTrade`, and all the venue gates still apply.
   The guard does not keep a list of staged callers. Surfaces that must never
   dispatch are fenced by the guards listed above.
3. **Calls that are not tracked entry points still go to the queues
   directly:** cancel, list and read (`cancelLiveCommand`, `cancelCommand`,
   `listMyLiveCommands`, and so on), and the demo consumer
   (`consumeApprovedCommand`). Cancel only reduces exposure. None of these
   creates exposure.
4. **The My Trades DEMO close mailbox exception stays,** unchanged and still
   pinned by the guard.
5. Items 3 to 5 of the round 1 list below (paper books, SIMULATED paths, no
   published score) are unchanged. The other engineers are working on the
   paper books and the position read models.

## What changed (round 1)

`artifacts/api-server/src/lib/tradeEngine/pipeline.ts` is the single entry:

```ts
submitTrade({ mode: "LIVE" | "DEMO" | "PAPER", intent: "OPEN" | "CLOSE" | "MODIFY", ... })
```

Each mode passes the request to the governed path that already existed. The
module adds no gate and removes none, writes no table, and returns every
refusal unchanged.

| Mode / intent | Delegates to | Gates that still run |
|---|---|---|
| LIVE OPEN | `liveCommandPipeline` createLiveDraft → confirm → dispatch | arming, kill switch, Risk Governor, dispatch gates (Phase B is still the only live writer) |
| DEMO OPEN | `demoCommandQueue` createDraftCommand → confirm → dispatch | demo queue gates, Risk Governor at consume |
| LIVE / DEMO CLOSE, MODIFY | `positions/governedOps` on the trader's own ARX-governed position | venue queue + Risk Governor; a position opened outside ARX, held by another user or held on the other venue is refused (`NOT_AN_ARX_GOVERNED_POSITION`, `POSITION_IS_<venue>`) |
| PAPER OPEN, CLOSE, MODIFY | `tradeEngine/paperVenue` (paper simulator book, `paper_orders`) | Risk Governor with venue `PAPER` on every step; owner scoping; SL/TP geometry |

Callers moved onto the pipeline:

- **Trade Action Center** (`lib/tradeAction/route.ts`): DEMO/LIVE opens and
  position operations now call `submitTrade`. The demo execution panel
  (`routes/demoExecution.ts`) reaches the pipeline through
  `routeConfirmedAction`. The shared-master live refusal stays the same.
- **Positions page** (`routes/livePositions.ts`): stop, target and close
  requests use `submitTrade` with the position they already resolved.
- **Paper trading** (`routes/paperTrading.ts`): order open, modify and close
  use `submitTrade({ mode: "PAPER" })`. The paper_orders writes, the
  governor calls and mark-to-market moved verbatim into
  `lib/tradeEngine/paperVenue.ts`. The route keeps account management and
  its HTTP envelope (same status codes and messages), and it re-exports
  `getMockPrice` for existing importers.

Existing guards were updated to match. In `execution-single-entry`, the
GOVERNED paper writer is now `paperVenue.ts` instead of the route.
`single-risk-authority` now treats `lib/tradeEngine/` as an order path. The
source pins in `riskGovernorPipelines` and `postTradeDebriefSource` follow the
moved code.

No tables, columns, migrations, RLS policies, Risk Governor rules or dispatch
gates were changed.

## What is enforced (round 1; see Round 2 for this round's changes)

`trade-engine-single-pipeline` runs in `ci:guards` (81 guards in total). It
uses the TypeScript AST, so it catches aliases, dynamic imports,
element-access calls and raw SQL. It fails when a runtime file:

1. Calls a venue entry point without being a listed producer. The tracked
   entry points are: demo queue draft/confirm/dispatch, live draft/ops-draft/
   confirm/dispatch, `executeInstant`, `submitGovernedClose`/`Modify`, and the
   PAPER venue functions.
2. Writes `paper_orders`, `paper_trades` or `trades` without being a listed
   paper writer.
3. Inserts into `arx_live_commands`, `mt5_demo_commands` or `mt5_commands`
   outside that table's owner.

The guard also checks that:

- `pipeline.ts` still dispatches all three modes to the delegates listed above
  and writes nothing itself.
- `paperVenue.ts` still governs OPEN, MODIFY and CLOSE with venue PAPER.
- The mailbox exception is still exactly one CLOSE insert, placed after its
  Risk Governor check.
- No allowlist entry is stale.

**Explicit exception, kept on purpose:** the My Trades DEMO close
(`routes/meTrades.ts`) still inserts a `CLOSE` into the legacy `mt5_commands`
mailbox. It only reduces risk, the Risk Governor checks it first, and LIVE
closes return earlier through Phase B. It is the only trade insert into the
mailbox outside Phase B's bridge mirror.

Listed producers are reviewed paths that existed before the pipeline. Round 2
moved every staged producer onto the pipeline and cut the list to 8 entries
(see Round 2). Round 1 listed:

- **LIVE (16 venue producers in total):** `instantTrade` (the `executeInstant`
  one-click entry, used by missions, self-trade, the assistant and the
  instant-trade route), `liveTestCycle`, `emergencyClose`, the shared-master
  live ticket, `meLive`, `meOneClick`, the My Trades LIVE close.
- **DEMO:** the staged demo command API (`meDemoCommands`).
- **Position Guardian:** the exit door (`positionGuardian/manage.ts`).
- **Paper / legacy books (8 writers):** the paper autopilot service and
  monitor (Build EE), the autoDebrief QA fixture, the `paper_trades` journal,
  legacy `/execute-trade` (`trades`), the bot emergency-stop cancel, and
  `lib/trades/paperBook.ts` (Position Guardian simulated-trade management).

Verification on an isolated local PostgreSQL database (UTC):

- Library and API typechecks: pass.
- `ci:guards`: 81/81 pass (with `DATABASE_URL` set).
- `test:trade-engine-single-pipeline`: 46 guard fixtures pass, including
  real-tree green.
- `test:trade-engine-pipeline` (new, wired into `ci:integration`): 6/6. It
  covers:
  - PAPER open, tighten and close, each audited once with venue PAPER;
  - governor and geometry refusals that write nothing;
  - cross-user account and order isolation;
  - DEMO/LIVE refusal of non-ARX, foreign and wrong-venue positions, with no
    live command and no mailbox row;
  - a governed DEMO close handed to the demo queue;
  - unknown-mode refusal.
- `test:risk-governor-pipelines` 25/25, `test:behavior-ownership-route` 16/16,
  `test:position-guardian-manage` 7/7, `test:position-guardian-reconcile`
  16/16, `test:position-ledger` 9/9, `postTradeDebriefSource` 5/5.
- Guard fixtures: `execution-single-entry`, `single-risk-authority`,
  `single-position-guardian` and `position-guardian-wired` pass.

## What remains (round 1)

Items 1 and 2 were addressed in Round 2: the staged producers are migrated,
and `executeInstant` reaches Phase B through the pipeline. Its callers are
still listed.

1. **Staged producers are listed, not migrated.** Callers that draft, confirm
   and dispatch in separate requests still call the venue queues directly:
   `meLive`, `meOneClick`, `meDemoCommands`, `tradesLiveShared`,
   `liveTestCycle`, `emergencyClose`, and the My Trades LIVE close. Moving
   them needs a staged contract on the pipeline (`draft` / `confirm` /
   `dispatch` by mode).
2. **`executeInstant` is a second LIVE entry.** Missions, self-trade, the
   assistant and the Position Guardian exit door reach Phase B through it,
   with its one-click gates. The pipeline's LIVE OPEN path uses
   `createLiveDraft` directly, as the Trade Action Center did before. Making
   `executeInstant` a LIVE sub-mode of `submitTrade` is follow-up work.
3. **Paper has three books.**
   - `paper_orders` is the pipeline's PAPER venue, but the Build EE autopilot
     service and monitor still write it directly. Both are governed, but they
     do not go through `paperVenue`.
   - `paper_trades` (the journal) is a separate book.
   - `trades` is the legacy `/execute-trade` record. It is not a broker order
     even when Safety Core reports LIVE. It is managed through
     `lib/trades/paperBook.ts`.

   Merging these books into one is a data and product decision that this
   change does not make.
4. **Some SIMULATED paths write nothing to paper.** Trade Action Center
   `SIMULATED` actions and My Trades `SIMULATED` opens still record no paper
   order, and My Trades DEMO/LIVE opens are still refused by the order guard.
   Routing them to PAPER/DEMO would change user-visible behaviour and needs an
   owner decision.
5. **No published score.** The scorecard tools/rubric and dashboard
   destination are still needed before a new score can be measured.

## Honest limits

- The guard is static source analysis. It cannot see a write built from fully
  dynamic identifiers or an entry point reached through an untyped
  indirection it cannot name.
- An allowlist entry records a reviewed path; it does not prove that path is
  correct. Each listed producer keeps the gates it already had, and their
  behaviour is covered by those producers' own tests, not by this change.
- The pipeline adds no new runtime checks. Its safety equals the safety of
  the governed paths it delegates to.

**TIER 1 NOT COMPLETE**
