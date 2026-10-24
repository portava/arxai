# Tier 1: trade-management engines become Position Guardian rules

Base: `269402d` (PR #33). This is the second Position Guardian step in the
2026-10-24 handoff. It does not complete Tier 1 or change the published
scorecard.

## Responsibility

Position Guardian is the one authority for managing an open position.

- `artifacts/api-server/src/lib/positionGuardian/rules.ts` registers every
  engine that reasons about an open position as a guardian rule, with its
  modules, its kind (ADVISORY or ACTING), the actions it may request and the
  route those actions take. It is pure data.
- `artifacts/api-server/src/lib/positionGuardian/manage.ts` is the one exit
  door. An acting rule reaches an execution path only through it. Each request
  is checked first: the rule is registered and acting, the action and route are
  the ones registered for it, and a stop move never widens. The request then
  goes to the existing governed path, which still runs the Risk Governor, kill
  switch and dispatch gates. The exit door writes no table, and no registered
  action opens a position or adds size.

| Rule | Kind | Actions | Route |
|---|---|---|---|
| `position-protection` (assess, reconcile) | acting | restore stop | governed ops |
| `protective-close` (lib/protectiveClose, monitor hook) | acting | partial close, close | Trade Action Center |
| `trade-monitor` (intelligence monitorWorker) | advisory | none | none |
| `mission-exit` (missionExitManager) | acting | move stop, move target, partial close, close | instant router |
| `self-trade-manage` (selfTrade livePositionManager) | acting | move stop, close | instant router |
| `trade-health` (tradeHealthService) | advisory | none | none |
| `scalp-manage` (scalpManage, scalpManageService) | advisory | none | none |
| `trade-management` (lib/tradeManagement, its route) | acting | move stop, partial close, close | simulated-trade book |

The handoff named six engines. The survey found a seventh,
`lib/selfTrade/livePositionManager.ts`, which moves stops and closes positions
for Self-Trade agents at autonomy L3+. It is registered and routed the same
way.

Simulated (`trades` table) management steps are persisted by
`lib/trades/paperBook.ts`, which only the exit door calls.

## Behaviour changes

All are risk-reducing refusals. No path that previously reached a broker
reaches it any differently.

- A mission exit or Self-Trade agent stop move that would widen the stop is now
  refused by the guardian before the router (HTTP 409 `STOP_WOULD_WIDEN` on the
  mission route). Before, the engines' own decision logic was trusted to only
  tighten.
- A simulated-trade partial close that would not reduce size (a 0.01-lot trade)
  now returns 409 instead of reporting a no-op as success.
- Refusals are logged (`[position-guardian] management request refused`). They
  are not yet written to `user_risk_events`.

## Enforcement and verification

`single-position-guardian` runs in `ci:guards` (80 guards). It fails when a
registered module is missing or listed twice; a rule module imports or calls an
execution entry (Trade Action Center draft or confirm, governed ops, the live
or demo queues, a direct call to the instant router, the paper book, or a
command or simulated-trade table write); an advisory rule imports the exit
door; an acting rule acts under another rule's id; any module other than the
exit door applies a simulated-trade step; or an unregistered runtime module
both reads open positions and executes a change. The order-entry surfaces that
legitimately do both (a trader's own close or modify buttons, the assistant's
trader-confirmed actions, the pipelines themselves, emergency close and the
operator live test cycle) are listed by name in the guard. Its fixtures cover
23 cases, and the test also asserts the repository passes.

`position-guardian-wired` now follows the correction through the exit door:
reconcile must call `guardianRestoreStop`, which must submit through
`submitGovernedModify`.

`test:position-guardian-manage` is wired into `ci:integration`: registry
invariants, refusals for unknown and advisory rules, unregistered actions and
routes, stop widening for both sides, intent mapping, the router hand-off with
a spy executor, and a database case for the simulated-trade book.

Validation on an isolated local PostgreSQL database (UTC):

- Library, API and scripts typechecks: pass.
- Architecture guards: 80/80 pass.
- Position Guardian assess 13/13, reconcile 16/16, manage 7/7; position ledger
  9/9; mission exit route 7/7.
- Self-Trade safety audit 57/57, execution domain 37/37; mission
  no-direct-execution 23/23.

## What remains

1. The engines keep their own decision logic and modules; they are now
   registered rules behind one exit door, not one merged engine.
2. Demo and paper as modes of the one Trade Engine pipeline (separate change).
3. Rescore with the original scorecard tools once they are available.
4. Owner actions from the handoff: the seven production migrations, the legacy
   owner user ID as an explicit deploy parameter, and `validate:broker` against
   a real demo bridge.
5. A physical merge of the two position tables, planned separately and last.

**TIER 1 NOT COMPLETE**
