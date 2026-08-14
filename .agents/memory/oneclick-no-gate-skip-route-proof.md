---
name: One-click fast-trade "no gate skipped" route proof
description: How to prove (in a DB-backed route test) that the one-click toggle never bypasses a backend live gate, including the positive "routes through the pipeline" case.
---

# One-click fast-trade: proving the toggle skips no backend gate

`POST /api/me/one-click/submit-live` is the fast-path live submit. The toggle
(`liveOneClickEnabled` OR `oneClickArmed`) is **consent, never approval**. Two
companion suites lock it:

- pure 18-gate suite (`oneClickDispatchGate.test.ts`) — per-gate dispatch chokepoint.
- DB-backed route suite (`oneClickFastTradeRoute.test.ts`) — route wiring end-to-end.

## The positive "no gate skipped" proof (the hard one)

You **cannot** drive a real fully-passing live dispatch in dev/integration (no
live bridge). So prove the route HANDS OFF into the pipeline and a deeper server
gate — one the route itself never checks — still fires:

- Seed a **HUMAN** trader (`isSystemUser:false`). With `isSystemUser:true` the
  activation gate short-circuits to `BOT_AGENT_NOT_ALLOWED` (the existing
  route-test users are all `isSystemUser:true`, so add a dedicated user).
- Satisfy every route-level precondition: master-live APPROVED (so route 403
  passes) + consent toggle ON (so route 412 passes) + **armed**
  (`arx_live_arming.isArmed=true`, kill switch off → preflight arming passes).
- Do **NOT** fully activate (leave `live_confirmation_required=true`). Then
  `evaluateLiveExecutionActivationGate` returns `LIVE_EXECUTION_ACTIVATION_GATE`,
  which `preflight` (in `liveCommandPipeline.ts`) maps to refusal reason
  **`LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE`**. This gate runs in preflight
  **before** the shared master-pool gate, so it is deterministic regardless of
  whether the shared integration DB has a pinned master bridge.

**Why not fully-activate to reach the master-pool gate?** The integration DB is
shared and may (this env does) have a pinned live master bridge, so the deep
reason would vary (`MASTER_BRIDGE_NOT_PINNED` vs `USER_ALLOCATION_EXHAUSTED`
etc). Stopping at the activation gate keeps the exact reason deterministic.

## Assertions that actually prove it (not just "blocked")

- status **409**, `body.stage==="draft"` — refused at a pipeline STAGE, not the
  route's 412/403. This is the signal it entered `createLiveDraft`.
- `body.reason` starts with `LIVE_BLOCKED:` (robust) AND equals the exact gate.
- A new `LIVE_DRAFT_REFUSED` row exists in `live_trading_audit` — concrete
  evidence the request reached `createLiveDraft`'s preflight (the route's own
  403/412 never write this). `userId` lives **inside `metadata` jsonb** (no
  column, no FK) → query `metadata->>'userId'` and use a **baseline-delta**
  count, never count==0; never delete (append-only safety evidence).
- `arx_live_commands` count 0 (preflight refusal inserts no row) and
  `mt5_commands` count 0 (never reached the EA mailbox).

Run: `pnpm --filter @workspace/api-server run test:one-click-route` (integration
lane, needs DATABASE_URL). One lane at a time (OOM caution).
