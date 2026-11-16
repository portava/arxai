# Audit gaps, round 3, 4 November 2026

Base: round 2 (`claude/audit-gaps-r2-20261103`, PR #106) on
`codex/chart-anchor-drag-20261102`. Closes the items the first two rounds left
for the owner, on the owner's "proceed" of 4 November 2026. Nothing here
deploys, migrates the owner's database, arms live trading or talks to a
broker. The only schema change is three column DEFAULTs (see below).

## Decisions taken

| Item | Decision | Where |
|---|---|---|
| Advisory "Build" routers (H5) | Replay runs, their trades, reports, logs and active runs are owned by the session user who started them; onboarding progress and acknowledgements are one row per user. Both require sign-in. Scenarios stay a platform-shared library. The remaining routers (ecosystem, agents, execution preview, validation, personal edge, replay lab, signals, strategies) hold no per-user state and are platform output; the ecosystem envelope says `scope: platform_shared` | `routes/replay.ts`, `lib/replaySim/engine.ts`, `routes/onboarding.ts`, `lib/onboarding/state.ts`, `routes/ecosystem.ts` |
| H4 one execution price source | The market data router is the only execution price. The Risk Governor prices on the trader's own bridge partition of the router's MT5 store (the terminal that will fill a broker order), else the router's serving quote; the paper venue fills on the router's serving quote. The never-written `arx_symbol_specs` bid/ask snapshot, the assistant provider and the old `marketDataService` path are no longer execution prices. A mock provider, a missing feed or a quote older than 60 s is no price, and the governor blocks on it before the venue is reached | `lib/riskGovernor/enforce.ts` (`loadQuote`, `EXECUTION_PRICE_SOURCE`), `lib/tradeEngine/marketQuote.ts` |
| H7 broker-time candle open times | Bar times are NOT rewritten: the Truth contract (`candleTimeBasisEvidence.ts`) does not accept a current offset as a historical UTC conversion, and the forming bar and stored history share the broker clock. Instead every EA bar now carries `timeBasisEvidence` with basis BROKER_SERVER plus the pushing bridge's broker-clock offset measured from its own ticks (`brokerClockOffsetMs`, `brokerClockOffsetMeasuredAt`), so a reader can show UTC (bar time minus offset) and age the bar honestly. The chart's evidence resolver keeps the measured offset and still makes no UTC claim | `lib/bridgeV2/ingest.ts`, `lib/data/providers/mt5Provider.ts` (`getMt5BridgeClockOffset`), `lib/data/candleTimeBasisEvidence.ts` |
| Default trading posture | A fresh install fails closed: platform mode OFF, demo and live disabled, paper simulator available, emergency stop released, live execution not armed. The seed writes these values explicitly and the schema defaults match; an existing install's row is not changed. Replaces the 24 October trading-on default (decision card posted to the owner) | `lib/safety/platformSwitches.ts`, `lib/db/src/schema/adminTrading.ts`, `lib/db/migrations/2026-11-04_global_trading_settings_fail_closed.sql` |
| Per-user `mt5_state` rows | Each bridge user's EA (heartbeat, sync-account, sync-positions) writes that user's own row, created on first contact; the first user on an upgraded install adopts the legacy unowned row. A second user's EA no longer overwrites the first user's account, balances or positions. The platform read (operators, safety core, broker health) is the most recently heartbeating EA | `routes/mt5.ts` (`loadOrCreateState`), `lib/brokerHub/mt5StateReader.ts` |

## Tests

- `test:audit-gaps-r3-20261104` (offline, root `ci`): execution price source
  parity between governor and venue; broker-clock evidence on EA bars.
- `test:audit-gaps-r3-db-20261104` (integration lane): replay and onboarding
  ownership over HTTP; per-user `mt5_state` rows and the platform read.
- Updated to the new behaviour: `platformSwitches` (fail-closed defaults),
  `mt5StateReader` (freshest-heartbeat platform read), `simulatedOpen` and
  `riskGovernorPipelines` (router price, bridge tick fixture).

## Evidence

- Root `pnpm run typecheck` exit 0; `ci:guards` 87/87.
- Offline: round-3 suite 7/7; mt5TickTimeBase 3/3; sourceUnification 13/13;
  bridge-v2-liveness 34/34; data-provenance-envelope 5/5.
- Disposable PostgreSQL: round-3 DB suite 6/6; round-2 suite 35/35;
  audit-fixes suite 12/12; platformSwitches 19/19; mt5StateReader 3/3;
  mt5StateUnattributedReaders 7/7; mt5StateScope 5/5; simulatedOpen 11/11;
  riskGovernorPipelines 25/25; preTradeRules 40/40; pipeline 6/6; paperBook
  9/9; journalGovernor 12/12; omsGovernance 8/8; legacyGatesActionAware 3/3;
  eaUpdateGateInputs 9/9.

## Not done

- The `paperExecution` module (`paperExecutionService`, `paperExecutionMonitor`)
  still reads `marketDataService`; it is not on the Trade Action or My Trades
  path. Switching it is a follow-up.
- Signals and strategies routes return bare arrays, so they carry no scope
  label; they hold no per-user state.
