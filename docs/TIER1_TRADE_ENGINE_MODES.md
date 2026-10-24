# Tier 1: Trade Engine modes (LIVE / DEMO / PAPER)

Base: `c1b3b98` (PR #34). This change carries out the Trade Engine step of the
2026-10-24 handoff: DEMO and PAPER become modes of one execution pipeline
instead of separate execution paths. Tier 1 is not complete after it, and the
published scorecard is unchanged.

A second round (base `516f13e`, PR #35) added a staged contract to the
pipeline and moved the staged producers and `executeInstant` onto it. It is
described in [Round 2](#round-2-staged-contract) below. Sections marked
"round 1" describe PR #35.

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
