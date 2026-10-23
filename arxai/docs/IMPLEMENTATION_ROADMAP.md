# High Roll Trading AI — Master Implementation Roadmap

Version: 1.0
Last updated: 2026-05-10

## Guiding Rules

1. Foundation must stabilize before Intelligence.
2. Intelligence must stabilize before Learning + Validation.
3. Learning + Validation must stabilize before Optimization + Evolution.
4. Auto-execution (LIVE mode) cannot unlock until all validation milestones (Layer 3) are complete and signed off.
5. UI complexity must remain controlled — every new layer adds at most one primary surface and reuses existing card / banner patterns.
6. Performance and reliability take priority over adding features. A regression on either blocks merge.
7. Build modularly with strict boundaries between layers. Cross-layer calls go through Ports / typed verdicts only — never reach into a sibling subdomain's internals.
8. Preserve current app stability during implementation: each phase ships behind a flag, with the previous behavior intact as the default until the phase's success criteria are met.

## Layer Map

| Layer | Phases | Outcome |
|---|---|---|
| 1. Foundation | F1 – F4 | Stable infra, data plane, state machine, resilience |
| 2. Intelligence | I1 – I4 | Agents, strategies, risk, execution intelligence |
| 3. Learning + Validation | L1 – L4 | Vault, replay, stress, audit, LIVE-mode unlock |
| 4. Optimization + Evolution | E1 – E4 | Meta-learning, evolution, resource governance, continuous improvement |

---

## Layer 1 — Foundation

Goal: a rock-solid base — typed contracts, persistence, market data, state machine, resilience. No trading intelligence yet.

### Phase F1 — Platform Baseline

- **Purpose**: Lock down the monorepo, build, and deploy contract so every subsequent phase ships on a stable spine.
- **Dependencies**: none.
- **Required files**:
  - `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`
  - `lib/api-spec/openapi.yaml` (contract source of truth)
  - `lib/api-client-react/`, `lib/api-zod/` (codegen targets)
  - `artifacts/api-server/`, `artifacts/trading-dashboard/`
- **Required engines**: none (infra phase).
- **Required data**: Postgres provisioned, `DATABASE_URL` set, `SESSION_SECRET` set.
- **Required UI**: Empty dashboard shell with sidebar + topbar; placeholder routes.
- **Testing plan**: `pnpm run typecheck` clean; smoke test `/api/healthz`; preview pane loads dashboard shell.
- **Validation plan**: CI runs typecheck + build + lint on every PR; pre-merge gate.
- **Performance**: API cold start < 2 s; dashboard FCP < 1.5 s on preview.
- **Failure conditions**: typecheck red, build red, dashboard blank, healthcheck non-200.
- **Rollback**: revert to previous green commit; checkpoints handle this automatically.
- **Success criteria**: green CI + green preview + healthcheck 200 for 24 h continuous.

### Phase F2 — Domain Foundation

- **Purpose**: Lay down the typed domain layer — strict subdomain boundaries, Zod v4 schemas, structured `reasons[]`/`blockers[]`.
- **Dependencies**: F1.
- **Required files**:
  - `lib/domain/src/<subdomain>/*.types.ts`, `*.engine.ts`, `index.ts`
  - `lib/domain/package.json` (per-subdomain exports map)
  - `lib/db/src/schema/` (initial tables: trades, signals, sessions)
- **Required engines**: foundational subdomains — `data-vault`, `compliance-log`, `black-box-vault`.
- **Required data**: `trades`, `signals`, `bot_status`, `vault_events` tables.
- **Required UI**: read-only Trade Logs view backed by real persistence.
- **Testing plan**: unit tests per pure engine; round-trip `INSERT → SELECT` for each table; Zod schema parse + reject tests.
- **Validation plan**: 100 % engines pure (no `Date.now`, no `Math.random`); all IO behind Ports.
- **Performance**: typecheck full repo < 30 s; engine call p99 < 1 ms.
- **Failure conditions**: cross-subdomain imports detected; impure engine; Zod parse silently coerces.
- **Rollback**: revert subdomain folder; engine swap is single-file scope.
- **Success criteria**: 25+ subdomains pass architect review, no cross-imports, full typecheck green.

### Phase F3 — Market Data + Sensors

- **Purpose**: Real-time candle / tick ingestion + first-pass market sensors (volatility, trend, regime).
- **Dependencies**: F2.
- **Required files**: `lib/domain/src/market-state/`, `artifacts/api-server/src/routes/marketData.ts`, `lib/domain/src/research-ai/` (sensor scaffolding).
- **Required engines**: `marketStateEngine`, `regimeDetector`, `volatilityClassifier`, `trendStrengthEngine`.
- **Required data**: `candles_1m`, `candles_5m`, `candles_h1` tables; rolling 14-day window per symbol.
- **Required UI**: Market Scanner panel showing live regime + volatility per symbol.
- **Testing plan**: deterministic replay of recorded ticks → expected regime; live feed integration test against synthetic feed.
- **Validation plan**: regime classification accuracy ≥ 80 % on labeled historical sample.
- **Performance**: tick ingest p99 < 5 ms; regime recompute per cycle < 50 ms across 5 symbols.
- **Failure conditions**: missing candles, time-skew > 1 s, regime flip-flopping (≥ 6 flips/min).
- **Rollback**: disable feed flag → revert to stored synthetic candles (current demo mode).
- **Success criteria**: 7-day continuous live feed with < 0.1 % gap rate and stable regime classification.

### Phase F4 — Global State Machine + Resilience

- **Purpose**: One source of truth for system mode + automatic safety responses.
- **Dependencies**: F2, F3.
- **Required files**:
  - `lib/domain/src/global-state/` (already shipped — 6 files)
  - `lib/domain/src/resilience/` (already shipped — 8 files)
  - `lib/domain/src/system-integration/controlTowerIntegration.engine.ts`
- **Required engines**: `runStateMachine`, `runControlTowerIntegration`, `heartbeatMonitor`, `failover`, `degradedMode`, `safeShutdown`, `dataIntegrity`.
- **Required data**: `state_transitions` table; heartbeat history; integrity-check ledger.
- **Required UI**: persistent global banner reflecting current state (NORMAL → SAFE_SHUTDOWN); state-history drawer.
- **Testing plan**: scripted scenario tests — kill data feed → DEGRADED_MODE; force `marketDanger=0.9` → PRESERVATION_MODE; force `judgeDisagreement=0.8` → DEFENSIVE_MODE.
- **Validation plan**: every transition logged to Black Box Vault with severity; LOCKDOWN / SAFE_SHUTDOWN cannot be exited without forced authority.
- **Performance**: full state-machine cycle < 10 ms; heartbeat loss detection < 5 s.
- **Failure conditions**: state stuck in non-NORMAL > 10 min without triggering source still active; missing transition log.
- **Rollback**: hard-pin state to NORMAL via env flag and revert state machine wiring; existing UI continues to work.
- **Success criteria**: chaos test (kill DB, kill feed, spike disagreement, spike danger) leaves system in correct restrictive mode every time, with clean logs.

### Layer 1 Exit Gate

- 7 days continuous green operation.
- All F1–F4 success criteria met.
- Architect sign-off on subdomain boundary discipline.
- No regressions in dashboard FCP or API p99.

---

## Layer 2 — Intelligence

Goal: turn the stable base into something that can *think* — agents, strategies, risk gating, execution intelligence. Still no live trading.

### Phase I1 — Specialist Agents

- **Purpose**: Per-domain agents (trend, mean-revert, breakout, volatility, defensive) producing typed proposals.
- **Dependencies**: Layer 1 complete.
- **Required files**: `lib/domain/src/research-ai/`, `lib/domain/src/strategy-pipeline/`, `lib/domain/src/system-integration/agentSystemIntegration.engine.ts`.
- **Required engines**: 5 specialist agents, agent-context bundler, proposal-aggregator.
- **Required data**: `agent_proposals` table; per-agent telemetry (proposals/cycle, accepted rate).
- **Required UI**: Agent panel showing per-agent status and last-cycle proposal count.
- **Testing plan**: deterministic input → expected proposal set per agent; replay 1000 cycles, assert no exception.
- **Validation plan**: every proposal carries `reasons[]`; no agent can produce a proposal without a regime + microstructure context.
- **Performance**: full agent fan-out per cycle < 100 ms.
- **Failure conditions**: agent throws; agent emits proposal with empty reasons.
- **Rollback**: disable specialist agents flag; system falls back to current 5-strategy `runStrategyScan()` path.
- **Success criteria**: 72 h continuous operation, < 0.01 % agent error rate, deterministic replay reproducible.

### Phase I2 — Strategy Engines + Risk Governor

- **Purpose**: Lock down the 5 strategies + the risk gate that hard-blocks unsafe trades.
- **Dependencies**: I1.
- **Required files**: `artifacts/api-server/src/lib/strategyEngine.ts`, `lib/domain/src/system-integration/riskGovernorIntegration.engine.ts`, `lib/domain/src/survival/`.
- **Required engines**: `runStrategyScan`, `runRiskGovernorIntegration`, `capitalPreservation`, `drawdownResilience`, `survivalScore`.
- **Required data**: `risk_settings`, `risk_decisions` tables.
- **Required UI**: Risk Settings page (already exists — extend with composite-risk gauge); Strategy Settings toggles.
- **Testing plan**: unit tests for each of 5 risk sources at threshold boundaries; integration test: any single source ≥ 0.85 → HARD_BLOCK.
- **Validation plan**: no trade may bypass the risk governor; gate runs server-side only.
- **Performance**: risk decision per intent < 5 ms.
- **Failure conditions**: HARD_BLOCK rate > 50 % over 1 h (mis-tuned thresholds); APPROVED rate during NEWS_RISK > 0.
- **Rollback**: revert thresholds to previous values via env-driven config.
- **Success criteria**: 100 % of replayed historical "bad" trades blocked; 0 false-positive blocks on hand-labeled "good" sample.

### Phase I3 — Red Team / Blue Team + Judge

- **Purpose**: Adversarial review of every candidate trade before it reaches risk + execution.
- **Dependencies**: I2.
- **Required files**: `lib/domain/src/red-team/`, `lib/domain/src/blue-team/`, `lib/domain/src/decision-intelligence/` (judge).
- **Required engines**: `redTeamEngine`, `blueTeamEngine`, `judgeEngine`, `disagreementScorer`.
- **Required data**: `trade_critiques` table — red/blue arguments per intent.
- **Required UI**: per-trade-card "Why was this approved/blocked?" expandable section.
- **Testing plan**: golden-set of 200 historical trades with known outcomes — assert judge agreement matches expert label ≥ 75 %.
- **Validation plan**: `judgeDisagreement01 ≥ 0.7` always emits a `DEFENSIVE_MODE` demand to the state machine.
- **Performance**: red+blue+judge per intent < 30 ms.
- **Failure conditions**: judge agrees blindly with one side > 90 % of the time; disagreement-mode never triggers under known disagreement scenarios.
- **Rollback**: disable red/blue/judge flag — risk governor still gates trades.
- **Success criteria**: golden-set agreement ≥ 75 %; disagreement-mode triggers correctly on synthetic high-conflict scenarios.

### Phase I4 — Execution Intelligence (Microstructure + Cognitive + Attention + Explainability)

- **Purpose**: The 7 upgrade layers come online and start influencing decisions and the UI.
- **Dependencies**: I3, plus Layer 1 state machine.
- **Required files**: 7 upgrade subdomains (already shipped) + `lib/domain/src/system-integration/uiIntegration.engine.ts`.
- **Required engines**: every engine in execution-microstructure, attention, complexity-governor, explainability, resilience, cognitive, stress-lab; plus `runUIIntegration`.
- **Required data**: per-symbol microstructure history; per-cycle cognitive snapshot; vault events.
- **Required UI**: Dashboard cards re-prioritized by attention engine; danger banners; plain-English explanation drawer per trade.
- **Testing plan**: scenario test — induce wide spreads, assert exec-micro severity = DANGER and attention puts that symbol HERO; induce trader-fatigue inputs, assert size multiplier drops.
- **Validation plan**: complexity governor never disables ESSENTIAL agents; stress-lab outputs always carry `isSimulationOnly: true`.
- **Performance**: full upgrade-layer pass per cycle < 80 ms.
- **Failure conditions**: attention card variant doesn't match danger flag; explainability summary empty for an approved trade.
- **Rollback**: feature flag per upgrade layer; default off; UI returns to flat layout.
- **Success criteria**: 7 days continuous operation with all 7 layers active, no regressions in agent throughput, explanations rated "clear" on a 50-trade hand sample.

### Layer 2 Exit Gate

- All I1–I4 success criteria met.
- Risk governor blocks every replayed historical loser-trade in the curated set.
- Architect sign-off on adversarial review pipeline.
- No regression in cycle latency vs Layer 1 baseline.

---

## Layer 3 — Learning + Validation

Goal: build the institutional memory and the gates that allow the system to graduate to LIVE trading.

### Phase L1 — Black Box Vault + Replay Lab

- **Purpose**: Every signal, decision, and transition is durably logged and bit-exact replayable.
- **Dependencies**: Layer 2 complete.
- **Required files**: `lib/domain/src/black-box-vault/`, `lib/domain/src/replay-lab/`, `lib/domain/src/system-integration/blackBoxVaultIntegration.engine.ts`, `lib/domain/src/system-integration/replayValidationIntegration.engine.ts`.
- **Required engines**: `runBlackBoxVaultIntegration`, `buildReplayBundle`, `runValidationGate`.
- **Required data**: `vault_events` (already from F2), `replay_bundles`, `replay_results` tables.
- **Required UI**: Replay Lab page — pick a date / strategy → re-run → see diff vs original outcome.
- **Testing plan**: take 1 trading day, capture all events, replay → assert byte-equal decision sequence.
- **Validation plan**: replay determinism = 100 % across 30 random sample days; vault retention ≥ 90 days enforced.
- **Performance**: replay 1 trading day < 60 s; vault append < 2 ms per event.
- **Failure conditions**: replay diverges; vault drops events under load.
- **Rollback**: keep current append path; disable replay UI.
- **Success criteria**: 30/30 sample days replay byte-exact; vault load test passes (10× peak event rate for 1 h).

### Phase L2 — Validation Pipeline + Stress Lab

- **Purpose**: Every candidate strategy passes a multi-dimensional validation gate before it can be considered for promotion.
- **Dependencies**: L1.
- **Required files**: `lib/domain/src/validation-pipeline/`, `lib/domain/src/validation-efficiency/`, `lib/domain/src/stress-lab/` (already shipped).
- **Required engines**: validation-pipeline orchestrator + 5 stress scenarios (flash crash, fake breakout, liquidity collapse, slippage storm, news chaos).
- **Required data**: `strategy_versions`, `validation_runs`, `stress_results` tables.
- **Required UI**: Strategy → Validation tab showing pass/fail per check + stress equity curves.
- **Testing plan**: validation gate must reject any strategy that fails ≥ 1 of 5 stress scenarios at default thresholds.
- **Validation plan**: every promote decision in the audit log includes the validation report ID.
- **Performance**: full validation suite per strategy < 5 min on default hardware.
- **Failure conditions**: a strategy promoted without a validation report; stress scenario emits non-deterministic output for the same seed.
- **Rollback**: hard-disable promotion (manual-only); validation runs continue read-only.
- **Success criteria**: 100 % of promotions in last 30 days carry a passing validation report; stress determinism per seed verified.

### Phase L3 — Audit AI + Compliance Log

- **Purpose**: Independent audit agent reviews every promotion + every LIVE decision; compliance log captures everything.
- **Dependencies**: L2.
- **Required files**: `lib/domain/src/audit-ai/`, `lib/domain/src/compliance-log/`.
- **Required engines**: `auditAiEngine`, `complianceLogEngine`.
- **Required data**: `audit_findings`, `compliance_events` tables.
- **Required UI**: Audit drawer per strategy; compliance log search page.
- **Testing plan**: inject 50 known-bad promotions → audit AI flags ≥ 95 %; tamper test against compliance log.
- **Validation plan**: compliance log is append-only; deletion/modification rejected at the storage layer.
- **Performance**: audit per promotion < 10 s; compliance event append < 2 ms.
- **Failure conditions**: audit AI silent on a known-bad promotion; compliance log accepts mutation.
- **Rollback**: keep audit AI read-only; do not gate promotions.
- **Success criteria**: ≥ 95 % flag rate on injected bad set; compliance integrity hash chain verifies daily.

### Phase L4 — Auto-execution Unlock (LIVE mode)

- **Purpose**: The single place where the system becomes capable of real-money trading. Behind a multi-step confirmation.
- **Dependencies**: L1, L2, L3 all green for ≥ 30 days continuous; F4 state machine showing zero stuck-state incidents.
- **Required files**: `artifacts/api-server/src/routes/trades.ts`, `artifacts/api-server/src/lib/mt5Bridge.ts`, MT5 EA bridge config.
- **Required engines**: existing risk governor + state machine + MT5 bridge client; no new domain engines.
- **Required data**: `live_unlock_events` table — who unlocked, when, with which validation report.
- **Required UI**: LIVE toggle with multi-step confirmation, requiring an active validation report ID + acknowledgement of current global state.
- **Testing plan**: end-to-end paper-broker test against a sandbox MT5; 1-week shadow mode where LIVE intents are computed but not sent.
- **Validation plan**: LIVE unlock requires `globalState ∈ {NORMAL, HIGH_VOLATILITY, TREND_EXPANSION}` and a fresh passing validation report < 7 days old; MT5 bridge token must be set.
- **Performance**: order round-trip latency p99 < 500 ms.
- **Failure conditions**: any HARD_BLOCK overridden; bridge token missing; state machine in restrictive mode.
- **Rollback**: kill switch reverts to mock mode instantly; all open positions closed via SAFE_SHUTDOWN flow.
- **Success criteria**: 30-day shadow mode with 0 LIVE-vs-mock divergences; sign-off on chaos test (DB kill, feed kill, bridge kill) all leading to safe close.

### Layer 3 Exit Gate

- All L1–L4 success criteria met.
- Auto-execution capability proven safe across chaos tests.
- Compliance log hash chain intact for ≥ 30 days.
- Architect sign-off on the LIVE unlock procedure.

---

## Layer 4 — Optimization + Evolution

Goal: continuous self-improvement. Only valid once Layer 3 is stable, because evolution requires a trustworthy validation gate.

### Phase E1 — Meta-Learning + Performance Analytics

- **Purpose**: System learns which strategies / agents perform under which states.
- **Dependencies**: Layer 3 complete.
- **Required files**: `lib/domain/src/meta-learning/`, `artifacts/trading-dashboard/src/pages/PerformanceAnalytics.tsx`.
- **Required engines**: `metaLearner`, `performanceAttribution`, `regretEngine` (already shipped).
- **Required data**: `performance_attribution`, `meta_learning_signals` tables; long-window history (≥ 180 days).
- **Required UI**: Analytics page — equity curve, daily P&L, per-strategy breakdown, per-state win-rate matrix.
- **Testing plan**: backtest meta-learner recommendations against a held-out month; measure improvement vs static weights.
- **Validation plan**: meta-learning recommendations fed into adaptive weighting only via the validation pipeline (never bypass).
- **Performance**: nightly meta-learning run < 30 min on default hardware.
- **Failure conditions**: meta-learner recommends a strategy that fails validation; analytics view loads > 3 s.
- **Rollback**: pin strategy weights to last known-good config.
- **Success criteria**: held-out improvement ≥ 5 % in Sharpe vs static; analytics p95 load < 2 s.

### Phase E2 — Strategy Lifecycle + Evolution

- **Purpose**: Strategies are born, promoted, demoted, retired automatically based on evidence.
- **Dependencies**: E1.
- **Required files**: `lib/domain/src/strategy-lifecycle/`, `lib/domain/src/evolution/`, `lib/domain/src/strategy-constitution/`.
- **Required engines**: `lifecycleManager`, `evolutionEngine`, `constitutionGate`.
- **Required data**: `strategy_lineage`, `lifecycle_events` tables.
- **Required UI**: Strategy Lineage view (tree of mutations, who descended from whom, win rate per generation).
- **Testing plan**: simulate 100 generations against 6 months of data — assert population fitness improves monotonically (with tolerance).
- **Validation plan**: every birth + promotion + retirement is gated by validation pipeline; constitution rules cannot be bypassed.
- **Performance**: per-generation evaluation < 10 min.
- **Failure conditions**: a strategy promoted that violates the constitution; population collapses to a single strategy (loss of diversity).
- **Rollback**: freeze evolution; population snapshot reverts to last sign-off.
- **Success criteria**: 90-day continuous evolution with monotonic-with-tolerance fitness curve and ≥ 5 active strategies maintained.

### Phase E3 — Resource Management + Complexity Governor

- **Purpose**: Cap compute, memory, and agent count without breaking essentials.
- **Dependencies**: E2.
- **Required files**: `lib/domain/src/resource-management/`, `lib/domain/src/complexity-governor/` (already shipped).
- **Required engines**: `resourceManager`, `runComplexityGovernor` (already exists), `aiEconomy` allocator.
- **Required data**: `agent_resource_usage`, `complexity_decisions` tables.
- **Required UI**: Resources page — per-agent CPU/RAM, compute budget gauge, "essential agents" lock indicator.
- **Testing plan**: induce compute over-budget → assert non-essential agents disabled and ESSENTIAL agents NEVER disabled.
- **Validation plan**: complexity governor's `forcedDisableAgentIds` is asserted to never include ESSENTIAL tier (already implemented as a hard guard).
- **Performance**: budgeting decision per cycle < 5 ms; cycle latency p99 stays under Layer 1 baseline.
- **Failure conditions**: ESSENTIAL agent ever disabled; cycle latency drifts up after governor activates.
- **Rollback**: governor → soft-mode (advise only, never enforce); revert to manual agent toggles.
- **Success criteria**: 30-day operation with governor enforcing, zero ESSENTIAL-disable incidents, latency baseline preserved.

### Phase E4 — Continuous Improvement Loop

- **Purpose**: Close the loop — every cycle's outcomes feed Replay Lab → Validation → Meta-Learning → Evolution → Resource Management automatically.
- **Dependencies**: E1, E2, E3.
- **Required files**: `lib/domain/src/orchestrator/`, `lib/domain/src/control-tower/`, plus existing wiring.
- **Required engines**: `orchestratorEngine`, `controlTowerEngine` running on a scheduler.
- **Required data**: improvement-loop telemetry table — cycles, suggestions accepted, suggestions rejected, attributable lift.
- **Required UI**: Control Tower page — system health overview, recent improvements, pending suggestions.
- **Testing plan**: 30-day end-to-end soak — measure attributable lift; assert no destabilization (no new stuck states, no validation gate regressions).
- **Validation plan**: every loop iteration's effect on weights / strategies / resources is logged and reversible.
- **Performance**: loop iteration < 1 min wall clock; nightly compaction < 1 h.
- **Failure conditions**: loop oscillation (same change reverted within 24 h, > 3 times/week); destabilization of state machine.
- **Rollback**: pause loop (read-only); manual weight pin.
- **Success criteria**: 90-day continuous operation with measurable, attributable lift and no regressions in any earlier-layer success criterion.

### Layer 4 Exit Gate

- All E1–E4 success criteria met.
- 90-day continuous operation with lift > 0 and zero regressions in Layer 1–3 metrics.
- Architect sign-off on the closed loop's safety properties.

---

## Cross-Cutting Constraints

### Modularity
- One subdomain per spec; no cross-imports.
- Cross-layer integration only via `system-integration` and `global-state` subdomains.
- Every new subsystem ships with a Port interface for IO.

### UI Discipline
- One new primary surface per phase, max.
- Reuse existing card / banner / drawer patterns.
- Attention engine governs prominence — no manual "always show this" overrides.
- Every new dataset gets a "loading", "empty", and "error" state on first ship.

### Performance Budget
- Cycle latency p99: ≤ 250 ms across all layers active.
- Dashboard FCP: ≤ 1.5 s on preview, ≤ 2.5 s on production.
- API p99: ≤ 200 ms for read, ≤ 500 ms for write.
- Each phase must not regress these budgets.

### Reliability Bar
- Auto-execution requires: state machine green, validation report fresh, compliance log intact, MT5 bridge healthy.
- One failed precondition = mock-mode fallback, no exceptions.
- Kill switch is always a single click and never depends on the loop being healthy.

### Rollback Posture
- Every phase ships behind a flag with the previous behavior intact.
- A phase is only "merged into the default path" after its success criteria are met for the stated duration.
- Checkpoint commits at the end of every merged phase.
