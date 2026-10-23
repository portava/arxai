# ARX AI — Analyze. Risk. eXecute.

The AI trading fortress built for disciplined decisions: an AI-powered trading
dashboard with a modular strategy engine, risk governor, signal generation,
simulator/shadow workflows, per-user MT5 demo execution, and Phase B
runtime-gated live broker execution (default-deny).

- Name **ARX AI** · Short **ARX** · Tagline **Analyze. Risk. eXecute.**

> **This file is the lean, current pointer.** Completed-phase logs, the full
> Phase B live-execution write-up, the environment live-testing posture,
> operator-control detail, EA install detail, superseded notes, and the full QA
> history are archived in
> [`docs/history/replit-history.md`](./docs/history/replit-history.md). The
> invariants, active rules, and safety gates in **this** file remain authoritative.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/trading-dashboard run dev` — run the frontend (port 24210)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned)
- Optional env: `ARX_LIVE_BROKER_EXECUTION_ENABLED` — Phase B master switch
  (code default `false`; set `"true"` in THIS environment for controlled
  owner/admin live testing — rationale in the [history archive](./docs/history/replit-history.md))
- MT5 EA bridge auth is **per-user only**: every EA-facing endpoint requires a
  per-user bridge token (`X-MT5-Bridge-Token`) generated from MT5 Setup
  (`POST /api/me/mt5-connections`). The legacy server-wide `MT5_BRIDGE_TOKEN`
  env value is **rejected** everywhere and must not be configured. (Full
  endpoint list in the [history archive](./docs/history/replit-history.md).)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite + Tailwind CSS + shadcn/ui + Recharts
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Database tables (Drizzle ORM)
- `artifacts/api-server/src/routes/` — Express route handlers
  (`mt5.ts`, `mt5Live.ts`, `meLive.ts`, `meAssistant.ts`, …)
- `artifacts/api-server/src/lib/strategyEngine.ts` — All 7 trading strategies
- `artifacts/api-server/src/lib/mt5/` — Demo arming, dispatch gate, command queue, consumer
- `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` — Phase B dispatch pipeline
- `artifacts/trading-dashboard/src/` — React frontend
- `lib/api-client-react/src/generated/` — Generated React Query hooks
- `lib/api-zod/src/generated/` — Generated Zod schemas
- `lib/domain/src/safety-contracts/executionMode.ts` — Inviolable safety contracts
- `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` — 18-gate evaluator
- `mt5-bridge/`, `mt5-bridge-export/` — EA source (in-project tops at v1.54; live bridge runs operator-managed v1.55 — see EA install section + history archive)

## Gotchas

- After editing `openapi.yaml` run `pnpm --filter @workspace/api-spec run codegen`,
  then `pnpm run typecheck:libs` to rebuild DB declarations after schema changes.
- Market-scanner data honesty (real-OHLC-or-empty), the assistant composite
  provider chain, and the **Resend** verified-sender-domain caveat are detailed in
  the [history archive](./docs/history/replit-history.md).
- Economic calendar is provider-agnostic behind the central
  `getEconomicCalendarResult` seam. Provider is chosen by
  `ECONOMIC_CALENDAR_PROVIDER` + the matching key: Trading Economics
  (`TRADING_ECONOMICS_KEY`) takes precedence, else **FRED** (`FRED_API_KEY`,
  `ECONOMIC_CALENDAR_PROVIDER="fred"`). FRED returns release **dates only** — a
  curated `release_name` classifier maps to factual `{currency,country,impact}`,
  unrecognized releases are dropped, and forecast/actual/clock-time stay `null`
  (never fabricated). THIS environment runs FRED. The Path-B economic-calendar
  **page** (`/economic-calendar/events` in `newsCalendar.ts`,
  `economicCalendarProvider.ts`) now routes through the same provider-agnostic
  `getEnrichedCalendarEvents` → `getEconomicCalendarResult` seam, so it shows
  real FRED events with honest empty/not-configured/fetch-error states. The TE
  adapter functions (`teEventToRaw`, etc.) remain intact for config-driven
  provider selection — never hardcoded to one provider.

## Architecture & Safety Documentation

- [`docs/ARCHITECTURE_MAP.md`](./docs/ARCHITECTURE_MAP.md) — single source of truth for every page, route, service, table, and data flow
- [`docs/ALGORITHM_MAP.md`](./docs/ALGORITHM_MAP.md) — what the trading algorithm decides (flame scalp, scanner truth caps, agent advisory/governance, Ruby copy discipline, data-routing honesty) + the deterministic test locking each behavior
- [`docs/SAFETY_NOTES.md`](./docs/SAFETY_NOTES.md) — inviolable invariants, untouchable surfaces, live-trading sensitivity, broker-credential gates
- [`docs/IMPLEMENTATION_ROADMAP.md`](./docs/IMPLEMENTATION_ROADMAP.md) — phased build plan (Layer 1–4)
- [`docs/ARX_NATIVE_CHART_AUDIT.md`](./docs/ARX_NATIVE_CHART_AUDIT.md) — ARX Native Chart Level 0 audit + chart "do not touch" list
- [`docs/PRUNING_MAP.md`](./docs/PRUNING_MAP.md), [`docs/BUILD_AUDIT.md`](./docs/BUILD_AUDIT.md), [`docs/PHASE_HISTORY.md`](./docs/PHASE_HISTORY.md) — pruning map + historical build/phase audits
- [`scripts/src/ci/README.md`](./scripts/src/ci/README.md) — Build A CI guards reference
- [`docs/SYNTHETIC_LIVE_FLOOR_SMOKE_RUNBOOK.md`](./docs/SYNTHETIC_LIVE_FLOOR_SMOKE_RUNBOOK.md) — operator/scheduled way to run the live-fire Deriv-synthetic LIVE-floor smoke against the deployed environment (default-deny; needs `QA_ALLOW_DB_MUTATION` + `QA_ALLOW_PROD_SMOKE`)
- [`docs/history/replit-history.md`](./docs/history/replit-history.md) — completed phases, full Phase B build-out, EA install detail, operator bridge controls, environment posture, per-suite QA history, and the archived prior `replit.md`

**Before modifying** `lib/safetyCore.ts`, vault tables, MT5 routes,
`strategyEngine.ts`, anything under `lib/domain/src/safety-contracts/`,
or the Phase B live pipeline, read [`SAFETY_NOTES.md`](./docs/SAFETY_NOTES.md).
Run `pnpm run ci` before committing.

---

## Non-negotiable invariants

These hold across every phase, every endpoint, every response. Tests in
`scripts/src/ci/` and `scripts/src/*Test.ts` enforce them at build time and
runtime.

- `liveLocked = true` at the legacy Build TT chokepoint
  (`lib/liveTrading/placeLiveOrderGuarded()` stays locked; Phase B runs in
  parallel in `lib/live/`).
- `allowOrderExecution = false`
- `commandExecutionAllowed = false`
- `brokerPlacementImplemented = false` — legacy literal still appended to Phase B
  `blockReasons` while the switch is unset/false (so grep + audit + CI guards
  continue to see it).
- `ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults to `false` in code — Phase B
  server master switch (gate #1 of 18). Resolution is env `AND` db, never OR
  (`resolveLiveBrokerExecutionEnabled`); ON only lets the 18-gate evaluator
  *consider* PASSing and bypasses nothing. Live dispatch still requires the DB arm
  flag `globalTradingSettings.liveBrokerExecutionArmed`, all 18 gates, and
  per-user approval. **This environment** sets it `"true"` for controlled
  owner/admin live testing (rationale in the history archive).
- `autoCloseMode = "ALERT_ONLY"`
- `sharedMt5RoutingBlocked = true`
- Per-user isolation: every query that reads MT5/demo/live/assistant data is
  scoped by `userId`. No row from user A is ever returned to user B.
- Legacy server-wide `MT5_BRIDGE_TOKEN` env value is **rejected** on every EA
  endpoint. Only per-user tokens issued from MT5 Setup are accepted. Server stores
  SHA-256 hashes only; raw tokens are shown exactly once at creation and never
  re-served.
- No endpoint ever returns: raw bridge tokens, `apiKeyHash`, `SESSION_SECRET`,
  `MT5_BRIDGE_TOKEN`, IP addresses or account numbers (except to OWNER/ADMIN
  sessions on operator endpoints), or `safetyGateSnapshot` blobs to anonymous
  callers.
- AI assistant (Ruby) is a **permission-bounded executor, never a second
  execution path**; it can never modify connections or read another user's data.
  Ruby's *reported* safety state is **derived per-user** (`getEnvelope()` /
  `deriveAssistantEnvelope`, fail-closed), never hardcoded. Read/advisory surfaces
  force `readOnlyMode: true`; the genuinely read-only `draw-setup` / `draft-read`
  surfaces keep the forced `READ_ONLY_PAPER_ENVELOPE`. Ruby may place/manage a
  **live** trade ONLY with explicit `rubyExecutionAuthority = AI_ASSISTED`, and
  even then routes through the SAME instant-trade router → live pipeline → 18-gate
  dispatch as a manual trade (skips only the extra app-side confirm, never a
  backend gate / approval / allocation / kill-switch). `AI_AUTO` is defined but
  **not enabled**. (Detail: "Ruby behavior rules" below.)
- Live market data is never substituted by simulator data. Providers return empty
  + honest `safetyNote` when not configured.

## Active ARX AI trading rules

- The demo path runs by default. MT5 demo execution requires the user to be
  **VERIFIED_DEMO** by `runDemoVerificationGate()` AND **armed** via MT5 Setup →
  Demo Execution Control. Arming is per-user, never global.
- The live path (Phase B) is **default-deny**. Even with the master switch on, all
  18 gates must individually PASS or the dispatch refuses with
  `LIVE_BLOCKED:<primaryReason>`.
- All EA-facing endpoints are guarded by `bridgeAuthPerUserOnly` (heartbeat,
  command poll/result, account/position sync, live poll/result, sync-live).
- The `mt5_demo_commands` queue has a partial unique index on
  `(user_id, fingerprint)` while a command is in
  `('SENT_TO_MT5_DEMO','DEMO_APPROVED')`; `arx_live_commands` has a partial unique
  index on `idempotencyKey` to block duplicate live dispatch.
- Auto-close is **ALERT_ONLY**. The system never closes a position on the user's
  behalf; it only emits an alert.

## Scanner priority (active)

Scanner is priority #1, trade placement #2. The Scanner page renders an
interactive chart (`components/scanner/ScannerChartPanel.tsx`) for the
bus-selected symbol (`useChartSymbol`) over `GET /api/data/candles`, with the
real-time signal scanner below it. All chart trade actions (place, Close, partial
close, break-even, Reverse, Cancel) route through the Global Instant Trade Router
(`executeInstantTrade`), which re-runs the full 18-gate evaluator + kill switch +
per-user allocation server-side. There is **no** frontend-only trade path; PAPER
mode renders **no** trade buttons. Candles are real or an honest empty state —
never fabricated/simulator data, never master-account data.

## Ruby (assistant) behavior rules (active)

Ruby is a **permission-bounded AI-Assisted executor**. Default execution
authority is `OFF` (read-only); a user may raise `rubyExecutionAuthority` to
`ADVISE_ONLY` (still read-only) or `AI_ASSISTED` (may place/manage live trades).
**There is NO second execution path**: when authorized, every Ruby trade action
(OPEN / CLOSE / CLOSE_ALL / MODIFY_SL_TP / MOVE_SL_TO_BREAKEVEN / PARTIAL_CLOSE
plus the MONITOR/WATCH single-fire engines) routes through the EXISTING
instant-trade router → live command pipeline → 18-gate Phase B dispatch (source
`ruby_text`/`ruby_voice`), exactly like a manual trade. `AI_ASSISTED` skips only
the extra app-side confirmation, never any backend gate, per-user approval,
allocation, or kill-switch. Actions are bounded by per-action permissions,
per-Ruby caps (`maxRubyLotPerTrade` / open-positions / daily-trades), and a
symbol/asset-class allowlist, recorded in the append-only `ruby_commands` ledger
(pending-dedupe + idempotency; watches fire EXACTLY ONCE via CAS). `AI_AUTO` is
defined but **not enabled**.

Ruby's *reported* account live-state is **derived** from the per-user envelope on
every reporting surface (conversational replies, `getTradingMode` /
`getPaperSafetyStatus`, the Scanner Ruby chart read, explain-signal, the
realtime-voice bootstrap, the system prompt) and forces `readOnlyMode: true`; the
genuinely read-only `draw-setup` / `draft-read` surfaces keep the forced
`READ_ONLY_PAPER_ENVELOPE`. Admins observe via
`GET /api/admin/ruby-execution/commands` (redacted) and override authority via
`POST /api/admin/ruby-execution/users/:userId/authority` (audited; `AI_AUTO`
rejected).

## QA commands

- `pnpm run typecheck` — full workspace typecheck (must be green)
- `pnpm run ci` — canonical pre-commit gate: typecheck + invariant guards +
  realised-P/L, live-cycle close, and performance-aggregate P/L-quality tests
- `pnpm run ci:guards` — invariant guards only

The full per-suite QA command list and last-known pass counts are in the history archive.

## Current safety gates (Phase B, 18 total)

Live broker dispatch is runtime-gated and **default-deny**; the chokepoint is the
18-gate decision in `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`,
and the env master switch (gate #1) resolves env `AND` db (never OR). The legacy
`lib/liveTrading/` Build TT chokepoint (`placeLiveOrderGuarded()`) stays locked;
Phase B runs in parallel in `lib/live/`. Full Phase B build-out narrative (domain
gate, pipeline, schema, EA-facing and user-facing live endpoints) is in the
[history archive](./docs/history/replit-history.md).

1. `LIVE_BROKER_EXECUTION_ENABLED` (server master switch)
2. User armed for live
3. Admin-approved
4. Global live not killed
5. Kill switch not triggered (re-checked at dispatch — TOCTOU guard)
6. `accountType` reported as `live`/`real`
7. Heartbeat age ≤ 15s
8. EA version ≥ `1.27`
9. EA input `EnableLiveExecution=true`
10. EA input `ReadOnlyMode=false`
11. `terminalConnected=true`
12. `algoTradingAllowed=true`
13. Symbol in user allowlist
14. Lot ≤ per-symbol max
15. Daily realised + floating loss within cap
16. Stop-loss required and present (`MISSING_STOP_LOSS`)
17. Take-profit present (`MISSING_TAKE_PROFIT`) — **governance-conditional**:
    enforced only when per-user `requireTakeProfit` is on and
    `adminAllowNoTakeProfit` is off; ops close/modify commands bypass
18. Live-trading risk disclosure accepted (`DISCLOSURE_NOT_ACCEPTED`) —
    append-only row in `live_risk_disclosure_acceptances`

ANY single gate failing → `LIVE_BLOCKED:<exact gate reason>`. No code path can
dispatch live without a positive PASS on all 18.

## EA install (MQL5) — v1.55 live (remote-managed)

The live master bridge in THIS environment runs operator-built, remote-managed
**EA v1.55** (`mt5_connection` reports `ea_version=1.55`, `account_type=live`,
fresh heartbeat + account/position sync). The in-project EA source tops out at
**v1.54** (`mt5-bridge/ARX_AI_Universal_Agent_v154.mq5`), covering all 21 native
MT5 timeframes. The Phase B `EA version ≥ 1.27` gate is unchanged. **Common-tab
"Allow Algo Trading" caveat:** all three MT5 AutoTrading switches must be ON or
`OrderSend` returns retcode `10027` even when every server gate passed (the
Common-tab checkbox is not in the heartbeat; the EA's `brokerMessage` names it).
Full install steps, capability negotiation, remote-config/self-update, the
nested-`eaInputs` heartbeat shape, and producer build-out are in the
[history archive](./docs/history/replit-history.md).

## Known issues

- **MT5 broker market-data feed is ACTIVE.** Accepted, fresh (non-`STALE`)
  `CANDLE`/`TICK` on `POST /api/bridge/v2/ingest` feed `mt5Provider` after the
  trace row commits, and `lib/data/marketDataRouter.ts` serves the `mt5_broker`
  slot (durable `broker_candles` preferred when fresh+sufficient); a `STALE`,
  duplicate, or out-of-sequence message is traced **but never fed**. Telemetry
  only — no execution path, `arx_live_*` table, balance, fill, or 18-gate
  involvement. Backstory + validation tests in the history archive.
- **EA-side `ReadOnlyMode` defaults to `true`.** Until the operator flips it to
  `false` in MT5 → EA Inputs, every live (and demo) dispatch returns
  `REJECTED_READ_ONLY_MODE_ACTIVE` from the EA. By design (safe default).
- **`ARX_LIVE_BROKER_EXECUTION_ENABLED` is `"true"` in THIS environment** for
  controlled owner/admin live testing — it satisfies only gate #1, not the DB arm
  flag, per-user approval, or the other 17 gates; normal users stay on the demo
  path, and it must not be reset here. Full rationale in the history archive.
