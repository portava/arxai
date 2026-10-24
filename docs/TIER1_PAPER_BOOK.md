# Tier 1: one paper book authority

Base: `516f13e` (PR #35). This change follows up item 3 of "What remains" in
`docs/TIER1_TRADE_ENGINE_MODES.md` ("Paper has three books"). Tier 1 is not
complete after it, and the published scorecard is unchanged.

## Survey: what the three books are

Before this change, eight runtime files wrote three paper tables. The survey
counted `insert`, `update` and `delete` calls on `paperOrdersTable`,
`paperTradesTable` and `tradesTable`, plus raw SQL, under
`artifacts/api-server/src`. Tests, `__qa__` and operator scripts were left out.

| Table | Writers before | What it is | Readers (runtime files) |
|---|---|---|---|
| `paper_orders` (+ `paper_trade_events`) | `lib/tradeEngine/paperVenue.ts`, `lib/paperExecution/paperExecutionService.ts`, `lib/paperExecution/paperExecutionMonitor.ts`, `routes/autoDebrief.ts` | **The canonical simulated-position book.** It holds the simulator's open and closed orders, and the paper account balance is recomputed from it. | 27, including the Risk Governor's PAPER book facts, auto-debriefs, the autopilot caps and performance views |
| `paper_trades` | `routes/mePaperTrades.ts` | **The paper trade journal.** The trader types in the prices. Rows are governed by `lib/riskGovernor/journal.ts`, never filled and never booked into the venue. | 18 (journal views, coach, performance) |
| `trades` | `routes/trades.ts` (`/execute-trade`), `routes/bot.ts` (emergency stop), `lib/trades/paperBook.ts` (Position Guardian) | **The legacy simulated-trade record.** No broker order is placed. | 20, including the Risk Governor's non-LIVE realized-P/L and activity facts |

Decisions:

- **`paper_orders` is the paper book**, and `lib/tradeEngine/paperVenue.ts`
  is its only writer. It already was the pipeline's PAPER venue.
- **`paper_trades` stays a separate concept.** It is not a derived copy of
  `paper_orders`: the trader enters its prices, and no fill produces it.
  Deriving it from the venue would change the product (the journal would stop
  accepting trader-typed trades). It already had one writer, and that is now
  enforced.
- **`trades` stays, with every column.** Its writers are now confined to
  `lib/trades/paperBook.ts`. Its status is described honestly below.

## What changed

All `paper_orders` and `paper_trade_events` writes now happen in
`lib/tradeEngine/paperVenue.ts`. Three functions existed already; four are
new:

| Function | Caller | Risk Governor |
|---|---|---|
| `openPaperOrder` / `modifyPaperOrder` / `closePaperOrder` (unchanged) | `lib/tradeEngine/pipeline.ts` only (trader's ticket, `submitTrade` mode PAPER) | OPEN / MODIFY / CLOSE, venue PAPER |
| `openPaperFill` (new) | Build EE `executePaperFromDecision`, operator `POST /auto-debrief/test` | OPEN, venue PAPER, before the insert; the caller's origin, quote and audit context are passed through unchanged |
| `closePaperFill` (new) | Build EE `closePaperManually` (`POST /paper-execution/close/:id`) | CLOSE, venue PAPER, before the update |
| `settlePaperOrder` (new) | `markToMarket` (inside the venue), the Build EE monitor (SL/TP hit), the auto-debrief fixture (forced result) | none. It is a venue fill of an order the governor already allowed, which is the rule `markToMarket` already followed |
| `voidPaperOrder` (new) | Build EE, when it loses the `paper_executions` idempotency race | none. It rolls back a row the same request booked moment earlier (status `CANCELLED`) |

Since Trade Engine round 3 (see `TIER1_TRADE_ENGINE_MODES.md`), the four
fill functions are called only by `lib/tradeEngine/pipeline.ts`
(`fillPaperTrade`, `settlePaperTrade`, `voidPaperTrade`). Build EE and the
auto-debrief fixture call those pipeline functions; the caller column above
names who reaches each function through them.

`lib/paperExecution/*` and `routes/autoDebrief.ts` still keep their own
eligibility, sizing, market-data pricing, `paper_executions` rows,
`paper_execution_logs` and auto-debrief triggers. They no longer write
`paper_orders` or `paper_trade_events`.

All `trades` writes now happen in `lib/trades/paperBook.ts`:

- `recordLegacyExecuteTrade`: the `/execute-trade` insert, moved verbatim
  from `routes/trades.ts`. The route keeps its own gates.
- `cancelOpenLegacyTrades`: the emergency-stop loop, moved verbatim from
  `routes/bot.ts`. It is owner-scoped and keeps the same per-row update.
- `applyPaperManagement`: unchanged signature. Only the Position Guardian exit
  door calls it (rule `trade-management`). `lib/positionGuardian/*` is not
  modified.

`lib/tradeEngine/pipeline.ts` is not modified.

### Behaviour

None is intended, and the code was moved, not rewritten. These are the small
mechanical differences:

- The Build EE manual close now scopes its `paper_orders` update by
  `id AND user_id`. Before, it scoped by `id` only. The order was already
  loaded by `id AND user_id`, so the same row is updated.
- Build EE's governor intent for an open is built by the venue. It has the
  same fields (`entryPrice: null`, origin, side, lots, stop and target) and
  the same options (`paperAccountId`, quote facts, `auditContext`). The same
  is true for the auto-debrief fixture (`origin: "system"`,
  `intentRef: "auto_debrief_test"`, no entry price).
- Event messages, statuses, P/L formulas, `.catch` best-effort behaviour and
  the auto-debrief triggers are unchanged. The new DB test pins the event
  text.

No tables, columns, migrations, RLS policies, Risk Governor rules or dispatch
gates were changed.

## Status of `trades` (honest)

- `/execute-trade` writes a row whose `mode` is `"LIVE"` when Safety Core
  reports LIVE and `"DEMO"` otherwise, including PAPER decisions. No broker
  order is placed in any mode. The `mode` column describes the Safety Core
  state, not a venue.
- The Risk Governor reads `trades` as the realized-P/L and activity ledger for
  every non-LIVE venue (`enforce.ts`, "DEMO uses the trades journal"). This
  includes PAPER intents. It is a second P/L source next to `paper_orders`.
  Changing that would change governor decisions, so it is left as it is and
  recorded here.
- Operator backfills in `scripts/src/backfill*` update `trades` P/L. They are
  one-off operator scripts, not runtime, and the guard does not scan them.

## Not changed: SIMULATED opens record no paper order

These paths still record no paper order:

- **Trade Action Center `SIMULATED`** actions (`lib/tradeAction/route.ts`):
  "no broker command", and no `paper_orders` row.
- **My Trades `SIMULATED` opens** (`POST /me/trades/open`, `placeOrder`): no
  `paper_orders` row.

Routing them into the PAPER venue would create simulated positions, P/L,
debriefs and Risk Governor book facts that do not exist today. That is a
user-visible product change and needs an owner decision. It is not made here.

## Enforcement

`single-paper-book` (`scripts/src/ci/check-single-paper-book.ts`) runs in
`ci:guards` (82 guards). It uses the TypeScript AST, so it follows import
aliases, destructuring, element access and raw SQL. It fails when:

1. A runtime file other than the owner writes a paper table:
   - `paper_orders` and `paper_trade_events`: only `paperVenue.ts`;
   - `paper_trades`: only `routes/mePaperTrades.ts`;
   - `trades`: only `lib/trades/paperBook.ts`.
2. A book function is called from an unlisted file (per-function caller
   list). For example, `openPaperOrder` may only be called from the pipeline,
   and `applyPaperManagement` only from the guardian exit door.
3. A venue function that writes `paper_orders` is neither governed nor a
   listed settlement:
   - a governed function must call `enforcePreTradeRisk` with venue `"PAPER"`
     and the expected action, before its first write;
   - a settlement may only `update`, and only `status`, `closedAt`,
     `exitPrice`, `profitLoss` and `updatedAt`;
   - a write that sits outside a named function fails.
4. `applyPaperManagement(tradeId: number, step: PaperManagementStep)` changes
   signature, or the journal imports a booking module.
5. An owner or caller entry is stale.

Related guards were updated:

- `trade-engine-single-pipeline`: `PAPER_WRITERS` is down from 8 to 3. A
  `PAPER_FILL` entry group lists the Build EE service, the Build EE monitor
  and the auto-debrief fixture as producers. (Trade Engine round 3 removed
  those three: `PAPER_FILL` is now pipeline-only.)
- `execution-single-entry`: the paper venue is the one GOVERNED
  `paper_orders` writer.
- The source pins in `riskGovernorPipelines` and `postTradeDebriefSource`
  follow the moved code.

Verification on an isolated local PostgreSQL database (UTC):

- Library, API and scripts typechecks: pass.
- `ci:guards`: 82/82 pass.
- Guard fixtures:
  - `test:single-paper-book`: 53 (new; includes the main-branch writers
    failing and the real tree passing);
  - `test:trade-engine-single-pipeline`: 55;
  - also passing: `execution-single-entry`, `single-position-guardian`,
    `single-risk-authority`, `position-guardian-wired`.
- `test:paper-book` (new, wired into `ci:integration`): 6/6. It covers:
  - a governed fill with its audit row and event, and a refusal that writes
    nothing;
  - an owner-scoped governed close;
  - settlement and rollback that are not re-governed and change only
    status, exit and P/L;
  - the Build EE monitor's TP settle and governed manual close, with
    unchanged event text;
  - the owner-scoped `/execute-trade` record and emergency-stop cancel.
- Existing tests:
  - `trade-engine-pipeline` 6/6;
  - `risk-governor-pipelines` 25/25;
  - `risk-governor-automation` 2/2 (Build EE end to end);
  - `position-guardian-manage` 7/7;
  - `post-trade-debrief-source` 5/5;
  - `behavior-ownership-route` 16/16;
  - `account-ownership-route` 20/20;
  - `oms-governance` 8/8;
  - `risk-governor-journal` 12/12;
  - `build-dd-layer-removed` 12/12;
  - `snapshot-ownership` 3/3;
  - `platform-controls-route` 3/3;
  - `mission-risk-domain` 14/14.

## What remains

1. **Owner decision on SIMULATED opens.** Should Trade Action Center and My
   Trades `SIMULATED` opens book into the PAPER venue (through `submitTrade`
   mode PAPER)?
2. **Done (Trade Engine round 3): Build EE and the QA fixture call the
   pipeline.** The pipeline now has a caller-priced PAPER fill channel:
   `fillPaperTrade({ mode: "PAPER", intent: "OPEN" | "CLOSE" }, args)`,
   `settlePaperTrade(args)` and `voidPaperTrade(orderId)` in
   `lib/tradeEngine/pipeline.ts`. They pass the caller's arguments to
   `openPaperFill` / `closePaperFill` / `settlePaperOrder` / `voidPaperOrder`
   unchanged and return the venue's result unchanged, including the governor's
   full decision (`risk.primaryReason`, `blockedBy`, `auditEventId`) that
   Build EE writes into its rejection rows. The Build EE service and monitor
   and `routes/autoDebrief.ts` call them, and `check-single-paper-book` now
   lists only the pipeline as a caller of the four venue fill functions.
   What remains: this is a sibling channel of `submitTrade`, not a
   `submitTrade` intent. `submitTrade`'s `TradeResult` does not carry the
   governor's `EnforceResult`, and folding the fills into it would change the
   shape Build EE reads. The fills still run their own eligibility, sizing
   and pricing before they call the pipeline.
3. **Two P/L sources for paper.** The Risk Governor's non-LIVE realized P/L
   reads `trades`, while the paper account balance reads `paper_orders`.
   Unifying them changes governor decisions and needs its own change.
4. **`trades` is still a live table with a misleading `mode` column.**
   Retiring `/execute-trade` or relabelling its rows is a data and product
   decision. Nothing was dropped.
5. **No published score.** The scorecard tools and dashboard destination are
   still needed.

## Honest limits

- The guard is static source analysis. It cannot see a write built from fully
  dynamic identifiers, or a book function reached through an untyped
  indirection it cannot name.
- Settlements are trusted to be fills of governed orders. The guard proves
  they cannot change size, side, symbol, stop or target. It does not prove
  the caller's hit detection is correct.
- Operator scripts and test fixtures still write these tables directly, by
  design.

**TIER 1 NOT COMPLETE**
