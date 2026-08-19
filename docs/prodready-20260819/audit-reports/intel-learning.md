# LEARNING / REVIEW Stack Audit — ARX AI

Auditor scope: vision MEMORY/REVIEW (vision.md §§ "ARX MEMORY", "ARX REVIEW", "Validation Pipeline", "Strategy Arena", "Black Box") and encyclopedia functions **46–56** (Immutable Ledger, Trade Journal, Post-Trade Review, Ruby, Conversation Memory, Aggregate Learning, Research Lab, Replay & Determinism, Shadow/Demo Validation, Strategy Arena, Model/Edge/Config Registry).

Codebase root: `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai` (paths below are relative to this root; `api` = `artifacts/api-server/src`).

**Spec conflict noted up front:** the binding multi-broker spec declares "Core: Python 3.12" (`ARX_AI_MULTI_BROKER_IMPLEMENTATION.md:5`) and a Python package layout (§5, line 255). The codebase is a TypeScript pnpm monorepo (Express + Drizzle/PostgreSQL). All components were evaluated against the TypeScript equivalents; the spec's *behavioural* requirements (replay → shadow → demo → limited live rollout, `:21` and `:1232`; "Replay, shadow and demo stages pass before limited live is considered", `:1178`) were used as the contract.

---

## 1. Component grades with evidence

### 1.1 AACI (Autonomous AI Cohesion Intelligence) — **Grade: B+** (best-built learning component; genuinely wired)

Modules: `api/lib/aaci/` — `decisionService.ts`, `executionAdvisory.ts`, `snapshotService.ts`, `latencyMonitor.ts`, `reconciliationAudit.ts`, `manualAdvisory.ts`, `userAlerts.ts`; learning sub-package `api/lib/aaci/learning/` — `trustStore.ts`, `outcomeIngestion.ts`, `driftService.ts`, `weightService.ts`, `learningAudit.ts`. Pure math in `lib/domain/src/aaci/` (`learning.ts`, `scoring.ts`, `hardGate.ts`, `edgeDecay.ts`, `freshness.ts`, `conflicts.ts`).

What is real and working:

- **Decision composition** (`api/lib/aaci/decisionService.ts:127-263`): builds a full scored decision (hard gate, freshness, cohesion, edge decay, master score) from a Shared Truth Snapshot, persists to `aaci_decisions` (`:241-256`). Learned trust + drift sub-scores are folded in per symbol/timeframe/agent, taking the *most cautious* reading and failing open to neutral (L=50, D=70) (`:145-174`).
- **Outcome ingestion is evidence-honest** (`api/lib/aaci/learning/outcomeIngestion.ts:1-12, 75-84`): only `CLOSED` `self_trade_agent_executions` with a non-null `realizedPnl` (real broker close fills) feed trust; dispatch ≠ fill; timeouts stay unresolved. Idempotent per `(entity, sourceRef)` (`trustStore.ts:165-178`), per-execution transaction with a fail-closed audit row written inside the same tx (`trustStore.ts:195-236`). Quarantine lifecycle transitions get their own audit rows (`trustStore.ts:239-257`).
- **Bayesian trust math is bounded** (`lib/domain/src/aaci/learning.ts:30-62`): Beta(1,1) prior, η=0.05 learning rate, asymmetric safety penalty λ=0.15, weights clamped [0.5, 1.5], quarantine below 0.35 mean, drift bands at 10/20/35pp drops, regime-reset decay 0.5.
- **Drift detection** (`api/lib/aaci/learning/driftService.ts:26-27, 104-150`): recent-20 vs baseline win-rate comparison over real closed outcomes only; RECOMMEND-ONLY, idempotent per entity/severity/day; dimensions without per-trade evidence (module/signal/session) are honestly never scored (`:80-82`).
- **Adaptive weights are permission-gated** (`api/lib/aaci/learning/weightService.ts:1-13`): MAJOR (risk-increasing) changes are always recommend-only; admin approve/reject/rollback surface at `api/routes/adminAaciLearning.ts:327-373`.
- **Learning actually affects execution — additively:** `api/lib/aaci/executionAdvisory.ts:29` sets a dispatch floor of 70; `mapAaciDecisionToExecutionAdvisory` (`:52-120`) can defer, downgrade to prepare-only, or halve size (`:98-108`) but can never enable a trade. The executor consumes it (`api/lib/selfTrade/agentExecutor.ts:183-225, 345-347`) and records an `AACI_DEFERRED` outcome status.
- **Tests exist and are meaningful:** pure-math tests (`api/lib/aaci/__qa__/learning.test.ts`), real-DB integration tests covering idempotent ingest across every entity dimension and the propose→approve CAS lifecycle (`api/lib/aaci/__qa__/learning.integration.test.ts:1-40`), and execution-gate tests (`executionGate.test.ts`).

Weaknesses:

- Trust is global-scope (`userId: 0` throughout, e.g. `decisionService.ts:166`) — fine for a single-operator fleet, not multi-tenant.
- Strategy-trust vocabulary mismatch is acknowledged in-code but unresolved: ingestion keys strategy trust by decision `setupType`, while decisions ask by `AaciStrategyKind`, so strategy trust is written but deliberately never read (`decisionService.ts:150-154`).
- The loop advances only when an admin triggers a cycle (see §2).

### 1.2 globalLearning.ts — **Grade: C−** (well-designed, dormant scheduler)

`api/lib/globalLearning.ts`. Privacy-conscious aggregation of opted-in users' closed imported trades into `global_signal_edges` cohorts with a `MIN_SAMPLE_SIZE = 10` contributor surfaceability gate (`:219`), run bookkeeping in `global_learning_runs` (`:119, 257-264`).

- **`scheduleGlobalAggregation()` is exported but never called anywhere** — grep over all of `api/` finds only its definition (`globalLearning.ts:314-326`). The 6-hour cron described in the header comment does not exist at runtime. Aggregation runs only when an admin manually POSTs (`api/routes/mePrivacy.ts:150`).
- The only consumer is the Ruby insights read (`mePrivacy.ts:110` → `getGlobalInsightSummary`).
- Aggregates only `importedTradesTable` (broker CSV imports) — despite the header naming paper trades, `paperTradesTable` is imported (`:22`) but never queried in `runGlobalAggregation` (`:144-187`).

### 1.3 shadowMode.ts + lib/shadowPersistence.ts + shadow_predictions — **Grade: D** (validation theatre: synthetic data, volatile state, dead persistence)

- **Shadow decisions are generated from a synthetic random-walk simulator, not live market data.** `api/lib/shadowMode.ts:15` imports `marketSimulator`; `api/lib/marketSimulator.ts:3` says "This is a synthetic price generator" and prices come from `Math.random()` drift (`:45-49, 89`). `createShadowDecision` calls `runStrategyScan(symbol, candles, 50, "synthetic")` (`shadowMode.ts:61`). The vision's core claim for Shadow Mode — "ARX makes real-time decisions without sending orders, allowing predicted behavior to be compared with actual market outcomes" (vision.md:185) — is not met: outcomes are compared against the same synthetic walk that generated the signal. Every derived surface (forward tests `:178-252`, tournament `:263-314`, confidence calibration `:317-352`, AI readiness `:440-474`, shadow journal `:477-492`) is measuring noise.
- **Everything is in-memory and lost on restart:** decisions in a module-level `Map` (`shadowMode.ts:41`), promotion/demotion gates in another `Map` (`:359`), forward/tournament state in module vars (`:173-176, 267-268`). The promotion ladder TESTING→PAPER_APPROVED→DEMO_APPROVED→LIVE_INTENT_APPROVED (`:355-419`) evaporates on every deploy.
- **The durability layer exists but is dead code:** `lib/shadowPersistence.ts` (repo root `lib/`, not inside any workspace package) implements `persistShadowDecision` / `updateShadowOutcome` / `persistRubyChatPrediction` against `shadow_predictions` (`lib/shadowPersistence.ts:20-121`), with relative imports (`./logger.js`, `./shadowMode.js`, `:14-15`) that only resolve if the file lived in `api/lib/` — it was evidently misplaced and orphaned. **No file anywhere in `artifacts/` imports it, and no code inserts into `shadowPredictionsTable` at all** (repo-wide grep: zero writers). The `shadow_predictions` table (`lib/db/src/schema/shadowPredictions.ts`) is permanently empty.
- Saving grace: all shadow surfaces are honestly labeled `dataSource: "SHADOW"` and are admin/OWNER-only (`api/routes/shadowMode.ts:20-24`), so shadow noise cannot reach users as live truth.

### 1.4 learningModelVersions — **Grade: D+** (registry exists; promotion pipeline is deadlocked; nothing consumes it)

Schema `lib/db/src/schema/learningModelVersions.ts` implements the 4-gate design (DATA_VALIDATED / WALK_FORWARD_PASS / SHADOW_VALIDATED / ADMIN_APPROVED, `liveAllowed` default false, rollback fields; `VERSION_GATES` thresholds at `:79-84`). Routes at `api/routes/adminLearningVersions.ts`.

- **The gate computation reads the permanently-empty `shadow_predictions` table** (`adminLearningVersions.ts:64-77`). `shadowSampleSize` is always 0 < `MIN_SHADOW_SAMPLE` (20), so `shadowValidated` is always false, and approval hard-requires all technical gates (`:208-215`). **No learning version can ever be approved.** Fail-closed, but the promotion path is structurally broken, not merely strict.
- **The "walk-forward" gate is a proxy with a correctness bug:** it takes "the most recent 50%" as `shadowRows.slice(0, halfPoint)` of a select with **no ORDER BY** (`:65-88`) — an arbitrary half of an arbitrary ordering, described as out-of-sample accuracy.
- **Nothing consumes the registry at decision time.** `learningModelVersionsTable` is referenced only inside this one route file (repo-wide grep). Ruby recommendations, scanner scoring, and AACI never check `isActive`/`liveAllowed`. Encyclopedia #56's "records exactly which versions made each decision" is absent: `aaci_decisions` rows carry no code/model/config hash, and no service stamps a version id onto decisions.

### 1.5 Decision ledgers: tradeDecisionLogs / aiDecisionLog / agentGovernanceTraces — **Grades: B− / F / C+**

- **tradeDecisionLogs (B−):** append-only orchestrator log with full decision JSON for replay/review (`lib/db/src/schema/tradeDecisionLogs.ts:5-13`), honest `syntheticData` (default true) and `operationalMode` (default PAPER_TRADING) flags (`:35-37`). Real writers across the paper pipeline: `api/lib/paperExecution/paperExecutionService.ts`, `api/lib/riskGovernor/governor.ts`, `api/lib/autoDebriefService.ts`, performanceCC aggregators, traderCoach. No update/delete callers found — behaviourally append-only (not DB-enforced).
- **aiDecisionLog (F):** the schema promising "what the brain saw, what risk said, what was done, how it ended" (`lib/db/src/schema/aiDecisionLog.ts:5-7`) has **zero writers and zero readers** in `api/` (repo-wide grep for `aiDecisionLogTable` / `ai_decision_log` returns only the schema). Dead table.
- **agentGovernanceTraces (C+):** written by the Governance Court wiring (`api/lib/agentEcosystem/governance.ts:24, 302` records disagreements; traces persisted via `agentGovernanceTracesTable`), consumed by chart benchmark scoring (`api/lib/chart/benchmarkScore.ts`). Advisory-only by design (`governance.ts:8-16`: can only lower rankings, fail-open, never touches execution).
- Related black-box surfaces that DO work: `vault_events` (written broadly, e.g. `api/routes/backtestRuns.ts:48-55`; no update/delete callers) and the fail-closed `writeSelfTradeAudit` invocation audit that aborts an autonomous cycle if the audit insert fails (`api/lib/selfTrade/autonomousCycle.ts:70-84`).

### 1.6 rubyQuality/ + outcomeWorker — **Grade: A−** (the model implementation of the post-trade review pattern)

`api/lib/rubyQuality/` (tracker, resolver, selfReview, aggregator, tuning, investorHooks, outcomeWorker).

- **Actually started at boot:** `api/app.ts:189` `startRubyOutcomeWorker()`; 60s unref'd interval (`outcomeWorker.ts:50, 167-174`).
- **Fail-closed, evidence-only resolution** (`resolver.ts:1-11`): a PENDING signal outcome resolves only on a matched closed trade (per-user scoped, `:87-110`) and/or real observed candle movement (`observeCandleMove`, `:56-84` — real MFE/MAE percent from `getMarketData`); "elapsed time alone NEVER grades" and the resolver leaves rows PENDING without evidence (`:142-166`). R-multiples derive only from the trade's own SL/TP geometry and only when `pnlStatus === "COMPUTED"` (`:117-130`).
- **Self-reviews are append-only and idempotent** per outcomeId (`selfReview.ts:33-38, 89-97`), with plain-language user summary separated from admin-only detail (`:6-9`) — exactly encyclopedia #48's "LLM narrative separated from deterministic facts".
- **Threshold tuning is audited fail-closed in one transaction** (`tuning.ts:75-107`: threshold update + `admin_action_audit_log` row commit together, values clamped by the pure domain).
- Gap: this covers *Ruby signal* outcomes only. Self-trade agent executions get trust ingestion (§1.1) but no structured review row; live/manual trades get none of this.

### 1.7 replaySim — **Grade: C** (honest, deterministic toy; certifies nothing about production)

`api/lib/replaySim/` (engine, scenarios, strategyLab).

- The engine deliberately does **not** run production algorithms: `engine.ts:7-20` documents that `aaReplayDecide()` and `sniperFilter()` are isolated stand-ins for the live AA orchestrator/FF autopilot, with the future hook named ("replace the body of `aaReplayDecide` with … `evaluateForReplay(input)` once such a function is exported by Build AA" — it never was; grep finds no `evaluateForReplay`). What replays is a toy SMA5/SMA20 crossover (`engine.ts:67-116`).
- Within its sandbox it is careful: conservative ambiguous-bar SL-first rule (`:236`), forced end-of-run close (`:308-322`), full persistence to `replay_runs`/`replay_trades`/`replay_logs`/`replay_reports` (`:355-375, 431-439`), and recommendations explicitly capped at "needs live paper validation, not live money" (`:415`).
- Scenario candles are seeded-PRNG synthetic (`scenarios.ts:30-73`); the default seed for ad-hoc scenarios is time-derived (`scenarios.ts:96` `Date.now() & 0xFFFF`) so unseeded scenario *generation* is not reproducible, though persisted scenarios replay stably.

### 1.8 backtestRuns — **Grade: B** (deterministic, honest about data provenance; separate from the production signal path)

`api/routes/backtestRuns.ts` + `lib/db/src/schema/backtestRuns.ts` + `@workspace/domain/backtest`.

- Deterministic seed defaults to the `strategy|symbol|timeframe` tuple so identical configs reproduce identical results (`backtestRuns.ts:118-119, 207`).
- **Real-history path:** loads real closed bars from `broker_candles` deduped per open instant (`:138-183`); with an explicit range and insufficient bars it records an honest `INSUFFICIENT_DATA` run and **never silently substitutes synthetic data** (`:243-259`); `dataSource` is recorded per-run (`backtestRuns.ts` schema `:33-37`).
- Focus-lock enforcement before any run (`:196-202`), vault BEHAVIOR audit per run (`:48-55`), verification gate by sample size (`isVerified`, schema `:39-41`).
- Limitation: strategies come from a dedicated `backtestStrategyRegistry` (7 rule-based strategies), not the production decision pipeline — so backtests validate the registry, not what will trade.

### 1.9 Testing-lab backend (Profit Mission Phase 9) — **Grade: B** (the most complete promotion loop in the codebase)

`api/lib/missionTestingLabService.ts` + `api/lib/missionPromotionService.ts` + `@workspace/domain/profit-mission`.

- BACKTEST results labelled historical/simulated; FORWARD results aggregate **the mission's own real executed-and-closed drafts** (`missionTestingLabService.ts:1-15`); results append-only in `mission_test_results`.
- **Fail-closed promotion:** automation level advances only when every required gate passes AND within the user's guardrail ceiling; live-auto additionally requires explicit user enablement + accepted certificate + platform live gates, none of which the service can fabricate; mutations lock the row FOR UPDATE and are journalled + audited (`missionPromotionService.ts:1-45`). Drift detection and a learning loop are composed in (`:29-31`).
- Well-tested: mission-domain and route tests across `api/lib/__qa__/mission*.test.ts` and `api/routes/__qa__/mission*.test.ts`.
- Scope limitation: this promotes *a user mission's automation level*, not *a strategy's capital allocation* — it is the pattern the Strategy Arena needs, applied to a different object.

### 1.10 lib/discovery + lib/features + lib/validation — **Grade: F** (ghost packages: type declarations with no code)

- All three directories contain **only `dist/*.d.ts` + sourcemaps — no `src/`, no `package.json`, no `.js` whatsoever** (verified by listing and `find -name "*.js"` → empty). They are not valid workspace packages (pnpm-workspace globs `lib/*` but there is no manifest to link) and **zero imports** of `@workspace/discovery|features|validation` exist anywhere in `artifacts/` or `scripts/`.
- The declarations show what was intended and lost: `lib/validation/dist/index.d.ts` re-exports CPCV, Deflated Sharpe, PBO, null-oracle, strategy families, stats; `lib/discovery/dist/pipeline.d.ts` declares pre-registered hypothesis hashing, FDR-charged trials, a `ValidationPort` and a `REFUSING_VALIDATION_PORT` that rejects everything when Phase 7 isn't wired; `lib/features/dist/index.d.ts` declares `LookaheadError`, bitemporal `PointInTimeReader`, and `FEATURE_SET_ID = "fset_v1"` lineage. This matches the memory note that P1 Discovery Stages 0/1 live on a branch — on this main snapshot only compile residue exists.
- Consequence: encyclopedia #52 (Research Lab: purging/embargo, walk-forward, holdout) has **no runnable implementation on main**. The nearest runtime relative, `@workspace/domain/validation-pipeline`, is real pure code but its HTTP surface is a **stateless calculator**: every stage endpoint takes `metrics` and `state` from the request body and persists nothing (`api/routes/validationPipeline.ts:103-115, 207, 284, 314, 348, 396`) — promotion gates that grade whatever numbers the caller types in.

### 1.11 Strategy Arena precursors — **Grade: C** (pieces exist; the feed and the allocation are both missing)

- **agentPredictions / agentPredictionReviews:** the Layer-2 review engine resolves and scores locked predictions fail-closed (`api/lib/agentEcosystem/reviewScoring.ts:1-21`), and the opt-in background lifecycle runner drives it with an advisory lock, live-command deferral, and recommend-only promotion board (`api/lib/agentEcosystem/lifecycleRunner.ts:1-31`). **But nothing ever inserts into `agentPredictionsTable`** — the only references are reads/updates inside `reviewScoring.ts` (`:98-115`); repo-wide grep finds no writer. The review engine permanently scans zero rows.
- **agentDisagreements (Agent Court):** wired — recorded fire-and-forget from governance (`governance.ts:302`), persisted (`layer3.ts:172`), resolvable via routes (`api/routes/agentEcosystem.ts:53, 627`), fail-closed PENDING until real outcome evidence (`layer3.ts:10-12`).
- **In-memory tournament/leaderboard** (`shadowMode.ts:263-314`) computes expectancy/PF/risk-discipline rankings — over synthetic data, volatile (§1.3).
- **Allocation shifting within caps** (vision.md:175-177, encyclopedia #55) **does not exist anywhere**: no code adjusts capital allocation from evidence. Agent ledgers track allocation, and profit missions gate automation levels, but no arena moves capital between strategies.

---

## 2. Is the trade→case-file→review→promotion loop actually closed anywhere?

**Yes — in three narrow, honest places. Not for the platform's live-strategy promotion path, which is the loop the vision describes.**

Closed loop #1 — **Self-trade agent fleet (the strongest):**
real dispatch → broker fill/close reconciliation (`agentExecutor.ts:410-486`, realizedPnl only when ingestible `:486`) → ledger posting (`autonomousCycle.ts:297`) → Bayesian trust ingestion, idempotent per execution (`autonomousCycle.ts:305`) → drift re-eval per touched entity (`:308-316`) → learned trust/drift consumed by the *next* AACI decision (`decisionService.ts:162-184`) → which can defer/downgrade/half-size the next dispatch (`executionAdvisory.ts:88-108`). Caveats: (a) the cycle only advances when an admin POSTs `/self-trade-ai/run-autonomous-cycle` (`api/routes/selfTradeAi.ts:161-181`) — there is deliberately no always-on loop; (b) learning is advisory-caution-only by design — it can never expand risk (a correct safety posture, but it means "promotion" never happens through this loop, only demotion-like caution).

Closed loop #2 — **Paper AA→BB→CC loop:**
AA decision persisted to `trade_decision_logs` → paper close triggers Build BB auto-debrief (`api/lib/paperExecution/paperExecutionMonitor.ts:142`, also mark-to-market at `api/routes/paperTrading.ts:105`) → BB invokes Build CC learning (`api/lib/autoDebriefService.ts:397-399`) → CC updates bounded per-cohort `strategy_edges` (±4 edge, clamped ±15 confidence/risk, idempotent per debrief; `api/lib/learningEngine.ts:28-46`) → future AA decisions read the learning view with bounded adjustments (`api/routes/tradeDecision.ts:417-445`). Caveats: paper-only; the paper monitor is manually triggered (routes), not a boot worker (`app.ts:184` starts the UX4 intelligence monitor, not `paperExecutionMonitor`).

Closed loop #3 — **Profit missions:** own real closed drafts → testing-lab forward record → fail-closed promotion of the mission's automation level within a guardrail ceiling (§1.9).

**Not closed:** the vision's institutional loop. There is no unified immutable per-trade case file (before/during/after — vision.md:99-105); evidence for one trade is scattered across `trades`, `ruby_signal_outcomes`, `self_trade_agent_executions`, `trade_decision_logs`, `vault_events`, and `aaci_decisions` with no shared correlation id. Post-trade review exists only for Ruby signals (§1.6) and paper debriefs. Strategy-level promotion is either in-memory-on-synthetic-data (§1.3), deadlocked (§1.4), or a stateless calculator (§1.10). No promotion decision anywhere consumes statistically validated evidence from stored real outcomes.

---

## 3. Replay determinism status

**Not achieved in the encyclopedia #53 sense ("same evidence and versions produce the same ordered decisions" of production algorithms). What exists is deterministic simulation of stand-in strategies.**

| Requirement (#53) | Status | Evidence |
|---|---|---|
| Runs *production* algorithms over recorded evidence | ❌ | `replaySim/engine.ts:7-20` explicitly replays a toy SMA stand-in; the named integration hook (`evaluateForReplay`) was never built |
| Frozen tick/candle archive | ◐ | `broker_candles` real closed bars exist and feed backtests (`backtestRuns.ts:138-183`); no tick archive; shadow evidence never persisted (§1.3) |
| Code commit / model package / config hash pinned to decisions | ❌ | No version stamping on `aaci_decisions`, `trade_decision_logs`, or anywhere; `learning_model_versions` records no commit hash and is consumed by nothing (§1.4) |
| Deterministic comparison report; divergence blocks promotion | ❌ | No comparison harness exists |
| Deterministic seeds for simulation | ✅ | Backtests: seed defaults to config tuple (`backtestRuns.ts:118-119`); replay scenarios: seeded LCG (`scenarios.ts:30-36`), though the ad-hoc default seed is time-derived (`scenarios.ts:96`) |

Also relevant: production decision *inputs* are not persisted — `decisionService.ts:241-256` stores the composed decision but not the Shared Truth Snapshot it was computed from, so even a bit-exact re-run is impossible today.

---

## 4. Dependency-ordered upgrade plan to close the loop

Ordered so each step only depends on the ones before it.

**Step 0 — Plumbing repairs (unblocks everything downstream):**
0a. Move `lib/shadowPersistence.ts` into `api/lib/` and call `persistShadowDecision`/`updateShadowOutcome` from `createShadowDecision`/`trackOutcomes` (`shadowMode.ts:92-94, 97-119`). This is the single cheapest fix with the widest blast radius: it un-deadlocks the learning-version gates (§1.4) and gives shadow data durability.
0b. Fix the walk-forward proxy: order `shadow_predictions` by `predictedAt` before slicing (`adminLearningVersions.ts:65-88`) — or better, gate on a real chronological holdout.
0c. Decide dead schemas: delete `aiDecisionLog` or make the paper/live pipelines write it; add the missing writer for `agentPredictionsTable` (record the advisory outputs the scanner/scalp/chart surfaces already compute via `advisoryInfluence` — consumers exist at `api/lib/marketScanner.ts`, `api/lib/scalp/scalpService.ts`) so `reviewScoring.ts` has something to score.
0d. Wire `scheduleGlobalAggregation()` into `app.ts` next to `startRubyOutcomeWorker()` (`app.ts:189`) or delete the scheduler.

**Step 1 — Shadow mode on real data (prereq: 0a):** replace `marketSimulator` inputs with the real feed already used elsewhere (`getMarketData`, `api/lib/data/dataManager.ts` — the rubyQuality resolver proves the pattern at `resolver.ts:64`), keep `dataSource:"SHADOW"` labeling, move promotion-gate state from the in-memory `Map` (`shadowMode.ts:359`) into a DB table. Only after this do calibration/tournament/readiness numbers mean anything.

**Step 2 — Immutable case files (prereq: none, but consumes Step 1's persisted evidence):** introduce a `correlationId` minted at signal time and carried through decision → risk verdict → execution → fills → management → close; a `trade_case_files` view/table assembling: locked pre-trade snapshot (pattern already exists: rubyQuality's "locked at-signal snapshot is never rewritten", `resolver.ts:10-11`), during-trade MFE/MAE (already computed, `resolver.ts:56-84`), and post-trade facts. Enforce append-only at the DB level (revoke UPDATE/DELETE) for `vault_events`, `trade_decision_logs`, `aaci_decisions`, `self_trade_audit` — today immutability is only behavioural (no update callers found, but nothing prevents one).

**Step 3 — Post-trade review for the agent/live path (prereq: 2):** extend the rubyQuality worker pattern (`outcomeWorker.ts`) to `self_trade_agent_executions`: one idempotent review row per closed execution, separating setup/risk/execution/exit quality (encyclopedia #47), reusing `buildSignalSelfReview`-style pure grading. This gives AACI trust ingestion a human-auditable companion record.

**Step 4 — Version pinning + true replay (prereq: 2):** persist the input snapshot with each `aaci_decisions` row; stamp `codeVersion` (git SHA at build), config hash, and active `learning_model_versions.versionId` onto every decision row; export the side-effect-free `evaluateForReplay(input)` that `engine.ts:17-20` already names, and build the divergence-comparison harness over recorded snapshots. Divergence blocks promotion (encyclopedia #53 safety rule).

**Step 5 — Edge promotion gates wired to lib/validation (prereq: 1, 4):** rebuild `lib/validation` as a real package (source + package.json + tests) implementing what its `.d.ts` residue already specifies (CPCV, Deflated Sharpe, PBO, null oracle, FDR-charged families, pre-registration hashing — `lib/discovery/dist/pipeline.d.ts`). Then convert the stateless `validationPipeline` routes into a promotion *service* that pulls metrics from `backtest_runs` + `shadow_predictions` + case files instead of the request body, and persists `CandidateState` server-side. Keep the `REFUSING_VALIDATION_PORT` default so an unwired validator rejects everything.

**Step 6 — Arena allocation within caps (prereq: 3, 5):** generalize the profit-mission promotion pattern (`missionPromotionService.ts` — fail-closed gates, guardrail ceiling, FOR-UPDATE row locks, journalled changes) to strategy-level allocation: evidence ranking from case files (expectancy, PF, drawdown, calibration, sample size, regime splits — encyclopedia #55 inputs), proposals only, owner approval required, experimental strategies hard-capped, arena mathematically unable to raise global risk ceilings (cap enforcement in the risk kernel, not the arena).

---

## 5. Quick wins vs long builds

**Quick wins (hours–days each):**
1. Re-home + wire `shadowPersistence.ts` (§4 step 0a) — un-deadlocks two subsystems.
2. `ORDER BY predicted_at` in the walk-forward gate (`adminLearningVersions.ts:65`).
3. Start (or delete) `scheduleGlobalAggregation` (`globalLearning.ts:314`).
4. Delete dead `aiDecisionLog` schema, or wire it.
5. Insert `agentPredictions` rows from existing advisory surfaces so the already-running review engine has input.
6. Persist the AACI input snapshot alongside the decision row (`decisionService.ts:241-256`) — one column.
7. Move shadow promotion gates from in-memory Maps to a table (schema can mirror the existing `StrategyGate` shape, `shadowMode.ts:358`).
8. DB-level append-only grants on the ledger tables.

**Long builds (weeks+):**
1. Real-data shadow validation (Step 1) — needs feed fan-out, restart-safe outcome tracking against real candles.
2. Unified immutable case files + correlation ids across six tables (Step 2).
3. `evaluateForReplay` + determinism harness + version stamping (Step 4) — touches the production decision path; needs careful purity refactoring.
4. Rebuilding `lib/validation`/`lib/discovery`/`lib/features` from their type-residue specs with tests (Step 5) — this is effectively the P1 Discovery workstream; the branch work referenced in project memory should be reconciled with main rather than rebuilt blind.
5. Strategy Arena allocation engine (Step 6) — governance-heavy; last.

---

## Appendix: encyclopedia 46–56 scorecard

| # | Function | Verdict |
|---|---|---|
| 46 | Immutable Decision & Trade Ledger | Partial — vault_events/tradeDecisionLogs/selfTradeAudit real and behaviourally append-only; no correlation-id joined timeline; aiDecisionLog dead |
| 47 | Structured Trade Journal | Partial — rubySignalOutcomes is a real per-signal case file (locked snapshot, MFE/MAE); user journal routes exist (`api/routes/journal.ts`); no unified per-trade case file |
| 48 | Post-Trade Review | Good for Ruby signals (§1.6) and paper debriefs (BB); absent for agent/live executions |
| 49 | Ruby Assistant | Present (`api/lib/assistant/`, `meAssistant.ts`) — outside this audit's depth; quality loop audited in §1.6 |
| 50 | Private Conversation Memory | Present (`arxAssistantMemory` schema) — not deeply audited here |
| 51 | Anonymous Aggregate Learning | Built with the right privacy gates, dormant scheduler (§1.2) |
| 52 | Research Lab | Missing on main — ghost packages only (§1.10) |
| 53 | Replay & Determinism | Not met (§3) |
| 54 | Shadow & Demo Validation | Shadow is synthetic + volatile (§1.3); demo path exists in execution stack (out of scope here) |
| 55 | Strategy Arena | Precursors only; no allocation engine (§1.11) |
| 56 | Model/Edge/Config Registry | Schema exists; deadlocked and unconsumed (§1.4) |
