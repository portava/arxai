# Master Build Roadmap — AI Trading Operating System

> **Purpose of this document.** This is the canonical, sequenced implementation
> plan for the trading OS. It is **not** an architecture document — every
> capability listed here is already specified elsewhere in the codebase. This
> roadmap exists to:
>
> 1. Lock the **build order** (no skipping phases).
> 2. State, per phase, what "done" looks like and what would force a rollback.
> 3. Give a single source of truth for current implementation status.
>
> No new architecture ideas may be added without first being captured here.

---

## Global Rules (apply to every phase)

| # | Rule |
|---|------|
| G1 | **No unrestricted live auto-execution** until all safety, validation, and risk systems are complete (Phases 1, 2, 7, 8, 9). |
| G2 | **Evolution never touches live money directly.** Mutations only run inside the sandbox (Phase 10/11). |
| G3 | **Risk Governor and Control Tower outrank every AI system.** No agent, vote, or evolution can override them. |
| G4 | **Every important decision must be logged into the Black Box Vault** (Phase 2). |
| G5 | **Every AI decision must be explainable, replayable, and auditable** (Phases 2, 6, 8). |
| G6 | **Do not proceed to the next phase until current phase tests pass.** Tests are the only acceptance signal. |
| G7 | All advisory routes must return `{canPlaceTrades:false, mode, generatedAtIso}`. The downstream Risk Governor / Control Tower retains final authority. |

---

## Phase Status Snapshot

| Phase | Name | Tests | Status |
|------:|------|------:|--------|
| 1 | Foundation Safety Core | `phase1.test.mjs` | ✅ shipped |
| 2 | Black Box Vault | `phase2.test.mjs`, `phase2-shadow.test.mjs`, `phase2-data-quality.test.mjs`, `phase2-validation.test.mjs` | ✅ shipped |
| 3 | Agent System V2 | `phase3*.test.mjs` (3 files) | ✅ shipped |
| 4 | Execution Intelligence | `phase4-execution.test.mjs`, `phase4b-execution-intelligence.test.mjs` | ✅ shipped |
| 5 | Trader DNA + Cognitive Intelligence | `phase5*.test.mjs` (4 files) | ✅ shipped |
| 6 | Replay Lab + Counterfactual Simulation | `phase6-replay-lab.test.mjs`, `phase6b-replay-simulation.test.mjs` | ✅ shipped |
| 7 | Validation Command Center | `phase7-validation-pipeline.test.mjs`, `phase7plus-*.test.mjs` (3 files) | ✅ shipped |
| 8 | Decision Intelligence | `phase8-decision-intelligence.test.mjs`, `phase8-decision-governance.test.mjs` | ✅ shipped |
| 9 | Portfolio Manager | `phase9-portfolio-manager.test.mjs` | ✅ shipped |
| 10 | AI Economy + Evolution Sandbox | `phase10-ai-economy.test.mjs`, `phase11-ecosystem.test.mjs` | ✅ shipped (Phase 11 extends 10) |

**Total acceptance tests today: 498 / 498 passing.** Run with:

```bash
VAULT_OVERRIDE_TOKEN=phase2-test-token pnpm --filter @workspace/api-server run test
```

---

## Phase 1 — Foundation Safety Core

- **Components:** Control Tower · Risk Governor · Global State Machine · System Modes · Kill Switch · Recovery Mode · Resilience Engine.
- **Purpose.** Establish the floor under everything else: a system mode FSM (`SAFE → SHADOW → LIVE → RECOVERY → HALTED`), a Risk Governor that can freeze capital, a Kill Switch that overrides every other authority, and a Resilience Engine that can degrade gracefully.
- **Dependencies.** None. This phase is the prerequisite for every other phase.
- **Files / folders.**
  - `lib/domain/src/global-state/`, `lib/domain/src/state/`
  - `lib/domain/src/risk-governor/`, `lib/domain/src/control-tower/`
  - `lib/domain/src/kill-switch/`, `lib/domain/src/resilience/`
  - `artifacts/api-server/src/routes/system.ts`, `risk.ts`
  - UI: `artifacts/trading-dashboard/src/pages/emergency.tsx`, `bot-control.tsx`
- **Implementation steps.**
  1. Define system-mode FSM and transitions (table-driven, no shortcuts).
  2. Implement Risk Governor (account / strategy / symbol freezes, hard caps).
  3. Implement Control Tower (the only place that can authorize mode changes).
  4. Wire Kill Switch as the highest-rank authority.
  5. Add Recovery Mode behavior (read-only, replay-friendly).
  6. Add Resilience Engine (graceful degradation when an upstream input is missing).
- **Tests.** `phase1.test.mjs` — FSM legality, Risk Governor freezes, Kill Switch override, Recovery Mode read-only, Resilience fallbacks.
- **UI requirements.** Big-red-button Emergency page; Bot Control with Demo / LIVE confirmation flow; mode badge visible on every screen.
- **Data requirements.** A persistent `system_state` row + an append-only `mode_transitions` log.
- **Success criteria.** Every test green; Kill Switch demonstrably halts trading from any mode; Risk Governor freeze is honored by every downstream gate.
- **Failure conditions.** Any path can mutate mode without going through Control Tower; Kill Switch can be bypassed; FSM allows an illegal transition.
- **Rollback plan.** Revert to the previous checkpoint; the system always boots into `SAFE` mode by default, so a partial revert leaves trading paused.

---

## Phase 2 — Black Box Vault

- **Components:** Event-sourced vault · Shadow audit mode · Data integrity · Replay-ready storage · Privacy guard · Training eligibility.
- **Purpose.** Make every important decision **explainable, replayable, auditable** (rule G5). All other phases write to the vault.
- **Dependencies.** Phase 1 (system mode gates whether writes are real or shadow-only).
- **Files / folders.**
  - `lib/domain/src/black-box-vault/`, `lib/domain/src/data-vault/`
  - `lib/db/src/schema/audit*.ts`
  - `artifacts/api-server/src/lib/auditVault.ts`, `routes/audit.ts`
- **Implementation steps.**
  1. Define `audit_events` table (append-only, integrity hash chain).
  2. Implement `shadowCapture({source, eventType, severity, payload})` — single ingress point.
  3. Add training-eligibility classifier (which events are safe to learn from).
  4. Add privacy guard (PII redaction at write time).
  5. Add a `VAULT_OVERRIDE_TOKEN` for tests so they can wipe vault between cases.
- **Tests.** `phase2.test.mjs`, `phase2-shadow.test.mjs`, `phase2-data-quality.test.mjs`, `phase2-validation.test.mjs`.
- **UI requirements.** Audit page that can filter by source / severity / event type; vault entry detail modal with payload JSON.
- **Data requirements.** Postgres `audit_events` + integrity-hash columns; index on `(source, event_type, created_at)`.
- **Success criteria.** Every state-changing route across all phases produces ≥1 vault event; Phase 11 acceptance test PE11_15 enforces this for the newest module.
- **Failure conditions.** A route mutates state without writing to the vault; vault accepts non-validated payloads; integrity chain breaks.
- **Rollback plan.** The vault is append-only — bad code can be reverted without erasing history; only the writer is rolled back, never the data.

---

## Phase 3 — Agent System V2

- **Components:** Sensors · Specialist agents · Red Team · Blue Team · Judge · Authority levels · Contracts · Versioning · Shadow comparison.
- **Purpose.** Replace ad-hoc signal generation with a contract-bound multi-agent system whose decisions are versioned and shadow-comparable.
- **Dependencies.** Phase 1 (mode gating), Phase 2 (vault for decisions).
- **Files / folders.**
  - `lib/domain/src/agents/`, `lib/domain/src/ai-agents/`, `lib/domain/src/agent-system/`
  - `lib/domain/src/agent-cascade/`, `lib/domain/src/red-team/`, `lib/domain/src/blue-team/`
  - `lib/domain/src/agent-promotion/`, `lib/domain/src/intelligence-v2/`
  - `artifacts/api-server/src/routes/agents.ts`, `intelligence.ts`, `brain.ts`
- **Implementation steps.**
  1. Define agent contracts (input schema, output schema, version, authority level).
  2. Implement specialist agents (sensors → specialists → judge cascade).
  3. Add Red Team (adversarial probes) and Blue Team (defensive checks).
  4. Wire a Judge that arbitrates conflicting opinions using authority levels.
  5. Add shadow comparison: run new agent versions in parallel with current.
- **Tests.** `phase3.test.mjs`, `phase3-contracts.test.mjs`, `phase3-agent-council.test.mjs`, `phase3-upgrade.test.mjs`.
- **UI requirements.** Brain Analysis page that shows agent cascade for the latest decision; Agents page listing version + reputation.
- **Data requirements.** Per-agent reputation snapshot + per-decision council record in vault.
- **Success criteria.** New agent versions can be promoted only via shadow comparison; contract breakage refuses the agent at the gate.
- **Failure conditions.** Agent decisions reach trading without contract validation; Judge can be bypassed; promotion happens without shadow evidence.
- **Rollback plan.** Versioned agents — pin the previous good version in config; the Judge will discard the new one.

---

## Phase 4 — Execution Intelligence

- **Components:** Slippage prediction · Spread behavior · Fill probability · Broker scorecard · Transaction cost analysis · Execution quality grading.
- **Purpose.** Score the *cost* of executing a trade before placing it; grade brokers and venues over time.
- **Dependencies.** Phases 1, 2, 3 (decisions feed in; vault stores grades).
- **Files / folders.**
  - `lib/domain/src/execution-realism/`, `lib/domain/src/execution-microstructure/`
  - `lib/domain/src/execution-intelligence/`, `lib/domain/src/execution-gate/`
  - `lib/domain/src/execution-pyramid/`, `lib/domain/src/order-execution/`
  - `artifacts/api-server/src/routes/execution.ts`, `executionIntelligence.ts`
- **Implementation steps.**
  1. Slippage model from book depth + recent prints.
  2. Spread regime classifier; fill-probability model.
  3. Broker scorecard rolling window; TCA per fill.
  4. Execution quality grade (A–F) attached to every executed trade.
- **Tests.** `phase4-execution.test.mjs`, `phase4b-execution-intelligence.test.mjs`.
- **UI requirements.** Execution intelligence panel inside Live Trades; broker scorecard widget on Dashboard.
- **Data requirements.** Per-fill TCA rows; per-broker rolling stats.
- **Success criteria.** Every advisory execution route returns a grade + cost estimate; gates can refuse trades when expected cost > expected edge.
- **Failure conditions.** Trades execute without TCA capture; broker scorecard ignores recent failures.
- **Rollback plan.** Set execution gate to `OBSERVE_ONLY` — system records grades but never refuses on them.

---

## Phase 5 — Trader DNA + Cognitive Intelligence

- **Components:** Personal baseline · Personal edge fingerprint · Behavior evidence · Recovery protocol · Temporal behavior · Contextual behavior · Personal risk prescription.
- **Purpose.** Model the *human* on the other side of the system — when to push, when to throttle.
- **Dependencies.** Phases 1, 2, 3, 4.
- **Files / folders.**
  - `lib/domain/src/trader-dna/`, `lib/domain/src/cognitive/`
  - `artifacts/api-server/src/routes/traderDNA.ts`, `cognitive.ts`, `personalEdge.ts`, `temporalIntelligence.ts`
- **Implementation steps.**
  1. Build personal baseline from journal + trade history.
  2. Personal edge fingerprint (where/when this trader actually wins).
  3. Behavior evidence pipeline; recovery protocol when behavior degrades.
  4. Temporal + contextual modulation; produce personal risk prescription.
- **Tests.** `phase5-trader-dna-cognitive.test.mjs`, `phase5b-personal-edge-behavior.test.mjs`, `phase5c-personal-risk-prescription.test.mjs`, `phase5d-temporal-contextual-intelligence.test.mjs`.
- **UI requirements.** Brain Analysis tab "Trader DNA"; Journal page with behavior evidence overlay.
- **Data requirements.** Per-user behavior snapshots + edge fingerprint table.
- **Success criteria.** Risk prescription is consumed by the Portfolio Manager (Phase 9) and the Decision Governor (Phase 8).
- **Failure conditions.** DNA outputs reach trading without the prescription gate; behavior evidence is computed on stale data.
- **Rollback plan.** Disable personal-prescription multiplier (set to 1.0) — system reverts to global risk policy.

---

## Phase 6 — Replay Lab + Counterfactual Simulation

- **Components:** Candle replay · Blocked-trade replay · Missed-trade replay · Decision-tree replay · What-if engine · Stress injection · Lesson confidence.
- **Purpose.** Make rule G5 ("every decision must be replayable") actually true; learn from blocked and missed trades, not just executed ones.
- **Dependencies.** Phases 1, 2, 3, 4, 5.
- **Files / folders.**
  - `lib/domain/src/replay-lab/`, `lib/domain/src/retrospective/`, `lib/domain/src/regret-engine/`
  - `artifacts/api-server/src/routes/replayLab.ts`, `replayLabSim.ts`
- **Implementation steps.**
  1. Candle replay against historical and synthetic data.
  2. Blocked-trade and missed-trade replay (counterfactual P&L).
  3. Decision-tree replay (re-run the agent cascade for any vault entry).
  4. What-if engine + stress injection.
  5. Lesson confidence scorer (only confident lessons feed Phase 10 reputation).
- **Tests.** `phase6-replay-lab.test.mjs`, `phase6b-replay-simulation.test.mjs`.
- **UI requirements.** Backtest / Replay Lab page; "Re-run this decision" action on any vault entry.
- **Data requirements.** Snapshot store keyed by vault event id.
- **Success criteria.** Any vault decision can be re-run deterministically; counterfactual P&L is reproducible across runs.
- **Failure conditions.** Replay drifts from original outcome (non-determinism); lessons promote without confidence threshold.
- **Rollback plan.** Mark replay outputs as advisory-only; Phase 10 reputation continues to flow from live evidence alone.

---

## Phase 7 — Validation Command Center

- **Components:** Staged validation · Out-of-sample · Walk-forward · Monte Carlo · Adversarial validation · Continuous validation · Strategy quarantine · System health.
- **Purpose.** A strategy or mutation is not promotable without passing every required validation stage.
- **Dependencies.** Phases 1, 2, 3, 4, 6.
- **Files / folders.**
  - `lib/domain/src/validation-pipeline/`, `lib/domain/src/validation-command-center/`
  - `lib/domain/src/adversarial-validation/`, `lib/domain/src/continuous-validation/`
  - `lib/domain/src/validation-efficiency/`
  - `artifacts/api-server/src/routes/validationPipeline.ts`, `validationCommandCenter.ts`, `adversarialValidation.ts`, `continuousValidation.ts`
- **Implementation steps.**
  1. Define stages (OOS, walk-forward, Monte Carlo, adversarial).
  2. Pipeline driver that records pass/fail per stage in vault.
  3. Quarantine gate: hard violations move strategy to QUARANTINE.
  4. Continuous validation re-runs on a cadence; system-health roll-up.
- **Tests.** `phase7-validation-pipeline.test.mjs`, `phase7plus-validation-command-center.test.mjs`, `phase7plus-adversarial-validation.test.mjs`, `phase7plus-continuous-validation.test.mjs`.
- **UI requirements.** Validation Command Center page (current stage per strategy, pass/fail history); System Health badge.
- **Data requirements.** Per-strategy validation history + quarantine ledger.
- **Success criteria.** Promotion is impossible without `passedRequiredValidation=true`; quarantine is enforced downstream by Phase 9 and Phase 10.
- **Failure conditions.** A strategy promotes without all stages green; quarantine state is ignored.
- **Rollback plan.** Force every strategy to QUARANTINE on rollback; restore from previous validation snapshot.

---

## Phase 8 — Decision Intelligence

- **Components:** Decision quality · Expectancy · Conviction · Strategic patience · No-trade quality · Future risk simulation · Decision governance.
- **Purpose.** Score *decisions* (including the decision **not** to trade) so that good no-trades count as good behavior.
- **Dependencies.** Phases 1, 2, 3, 5, 6, 7.
- **Files / folders.**
  - `lib/domain/src/decision-intelligence/`, `lib/domain/src/decision-qa/`
  - `lib/domain/src/do-nothing/`, `lib/domain/src/trade-court/`, `lib/domain/src/trade-advisor/`
  - `lib/domain/src/conditional-execution/`, `lib/domain/src/confidence-gate/`
  - `artifacts/api-server/src/routes/decisionIntelligence.ts`
- **Implementation steps.**
  1. Per-decision quality score (was the decision sound, given inputs available at the time?).
  2. Expectancy + conviction tracking; strategic patience meter.
  3. No-trade quality scoring (a correct skip is a positive event).
  4. Future risk simulation overlay; decision-governance gate that can refuse low-quality decisions.
- **Tests.** `phase8-decision-intelligence.test.mjs`, `phase8-decision-governance.test.mjs`.
- **UI requirements.** Decision quality panel on Dashboard; per-trade quality grade in Trade Logs.
- **Data requirements.** Per-decision quality row; conviction + expectancy rolling stats.
- **Success criteria.** Decision Governor can refuse a trade independent of risk + execution gates; rejected decisions are vault-logged with reasons.
- **Failure conditions.** Quality score is computed post-hoc with future information; governance bypassed.
- **Rollback plan.** Lower governance threshold to 0 (advisory only); other gates remain.

---

## Phase 9 — Portfolio Manager

- **Components:** Risk budget · Dynamic allocation · Capital climate · Reserve expansion · Capital efficiency · Portfolio health · Liquidity-aware deployment.
- **Purpose.** Single point that decides how much capital each strategy gets, conditioned on climate + health + ecosystem signals.
- **Dependencies.** Phases 1, 2, 3, 4, 5, 7, 8.
- **Files / folders.**
  - `lib/domain/src/portfolio-manager/`
  - `artifacts/api-server/src/routes/portfolio.ts`
- **Implementation steps.**
  1. Risk budget derivation (account, strategy, symbol, session caps).
  2. Capital climate classifier; reserve expansion in storm climates.
  3. Capital efficiency scoring; capital fatigue down-weighting.
  4. Liquidity-aware multiplier; portfolio-health roll-up.
  5. Ecosystem overlay (consumed from Phase 10/11) — multipliers cannot push past deployable cap.
- **Tests.** `phase9-portfolio-manager.test.mjs` (PM01..PM37).
- **UI requirements.** Portfolio page (allocations, climate, health, fatigue badges).
- **Data requirements.** Per-tick allocation snapshot; portfolio-health vault scope.
- **Success criteria.** Per-symbol cap binds AFTER ecosystem overlays (PM36); per-session cap binds across strategies sharing a session (PM37); Risk Governor ACCOUNT freeze short-circuits ecosystem (PM32).
- **Failure conditions.** Ecosystem multiplier pushes total risk past deployable; Risk Governor freeze leaks past Portfolio Manager.
- **Rollback plan.** Set ecosystem multipliers to 1.0 and lower deployable cap; Risk Governor / Control Tower remain authoritative.

---

## Phase 10 — AI Economy + Evolution Sandbox

> **Phase 11 (Ecosystem Evolution + Governance Intelligence)** extends this
> phase. It is built and tested under the Phase 10 umbrella; rollback below
> includes Phase 11.

- **Components.**
  - **AI Economy:** Agent reputation · Strategy reputation · Trust score · Lifecycle FSM · Promotion / Demotion / Quarantine / Retirement gates.
  - **Evolution Sandbox:** Mutation generation · Validation requirement · Sandbox-only execution.
  - **Phase 11 extension:** Ecosystem fitness · Evolution constitution · Sandbox ecosystem simulation · Mutation memory · Authority politics · Fraud detection · Strategy species · Ecosystem survival score.
- **Purpose.** Strategies and agents earn authority by ecosystem contribution, not isolated profit (rule G2). Evolution is sandboxed (G2). Mutations are constitutionally bounded.
- **Dependencies.** Phases 1, 2, 3, 6, 7, 8, 9.
- **Files / folders.**
  - `lib/domain/src/ai-economy/`, `lib/domain/src/strategy-lifecycle/`
  - `lib/domain/src/evolution/`, `lib/domain/src/resource-management/`
  - **Phase 11:** `lib/domain/src/ecosystem-fitness/`, `evolution-constitution/`, `evolution-sandbox/`, `evolution-memory/`, `ecosystem-politics/`, `evolution-fraud/`, `strategy-species/`, `ecosystem-survival/`
  - `artifacts/api-server/src/routes/economy.ts`, `ecosystem.ts`
- **Implementation steps.**
  1. Reputation engines (agent + strategy) with graded evidence and bounds [0,1].
  2. Trust score with discipline floor.
  3. Lifecycle FSM (12 stages, table-driven, no skips).
  4. Promotion / Demotion / Quarantine / Retirement engines.
  5. Sandbox-only mutation cycle + validation requirement.
  6. **Phase 11:** ecosystem fitness, constitution rulings, sandbox ecosystem simulation, mutation memory blacklist, authority hierarchy + emergency veto + governance vote, fraud detectors (fake edge, overfit, statistical illusion), species classification + monoculture flag, civilization stress test + survival composite.
- **Tests.** `phase10-ai-economy.test.mjs` (PE1..PE12), `phase11-ecosystem.test.mjs` (PE11_1..PE11_15).
- **UI requirements.** Strategy Settings → Lifecycle stage badge; Brain Analysis → Ecosystem fitness + survival gauges; Audit page filters for `EC_*` and `EE_*` event types.
- **Data requirements.** Reputation + lifecycle tables; collapse/adaptation history; mutation memory ledger; vault `EE_*` and `EC_*` events.
- **Success criteria.**
  - PE5: mutation REFUSED when mode ≠ SANDBOX.
  - PE6: mutated variants must enter validation before graduating.
  - PE9 / PE11_14: every advisory route returns `canPlaceTrades:false`.
  - PE10 / PE11_15: every state change emits a vault event.
  - PE11_2 / PE11_3: constitution refuses non-SANDBOX and forbidden-pattern mutations.
  - PE11_4: ecosystem simulation refused outside SANDBOX.
  - PE11_13: ecosystem survival composite drops below 0.3 in degenerate scenarios with explicit blockers.
- **Failure conditions.** A mutation reaches LIVE without sandbox + validation + constitution; reputation can be raised by isolated profit alone (without contribution); a low-rank authority emergency-vetoes a higher one.
- **Rollback plan.** Disable the `/api/economy/*` and `/api/ecosystem/*` routers in `routes/index.ts`. Phase 9 (Portfolio Manager) treats absent ecosystem inputs as multipliers = 1.0 and continues to function. The Risk Governor and Control Tower retain final authority regardless.

---

## Cross-phase enforcement matrix

| Concern | Authoritative phase | Consumed by |
|---------|--------------------|-------------|
| Mode + Kill Switch | Phase 1 | All phases |
| Vault writes | Phase 2 | All phases |
| Agent cascade | Phase 3 | Phases 6, 8, 10 |
| Execution grade | Phase 4 | Phases 8, 9 |
| Personal prescription | Phase 5 | Phases 8, 9 |
| Replayability | Phase 6 | Phases 7, 8, 10 |
| Validation pass | Phase 7 | Phases 9, 10 |
| Decision governance | Phase 8 | Phase 9 |
| Capital allocation | Phase 9 | Trading runtime |
| Ecosystem fitness / survival | Phase 10/11 | Phase 9 (advisory overlay) |

---

## Going-live checklist (G1 gate)

Live auto-execution remains disabled until **all** boxes are ticked:

- [ ] Phase 1: Risk Governor + Kill Switch + Control Tower verified end-to-end on staging.
- [ ] Phase 2: Vault integrity hash chain verified across at least 30 days of shadow data.
- [ ] Phase 4: Broker scorecard shows ≥ 3 weeks of stable grading.
- [ ] Phase 7: Every active strategy has `passedRequiredValidation=true` and a green continuous-validation cycle.
- [ ] Phase 8: Decision governance is in `ENFORCE` mode (not advisory).
- [ ] Phase 9: Portfolio Manager has run a full drawdown drill (storm climate + reserve expansion).
- [ ] Phase 10/11: Constitution refuses every red-team mutation in the canonical fixture; ecosystem survival composite ≥ 0.6 for at least 7 days of shadow operation.

Until every box is ticked, the bot remains in `SAFE` or `SHADOW` mode by default.
