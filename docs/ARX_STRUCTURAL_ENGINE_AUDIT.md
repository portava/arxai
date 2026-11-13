# ARX Structural Intelligence — Stage 0 audit

## Local implementation audit — 2026-11-12

Scope: repository source inventory (7,043 tracked files), relevant consumers,
contracts and targeted offline baseline tests. This is not a production audit.
Checkout: PR #150 at `21ccdbb85dd768b01e89d0fa4a87b6ace8acb7f0`.
Both `main` and `feature/structural-research-phase1-20261112` resolve to
`76cdbdc9525a2da1eec8113cb3c5fe9b63cf2325`; the PR adds nine documentation files.
The two structural branches were found through GitHub branch search; a formula
branch search returned none. Local Codex filename searches found reports but no
V6.4–V6.7 runnable source. **The owner confirmed in this implementation chat that
there is no code, asked for a new implementation, and confirmed that it must be
a working ARX feature rather than a research-only prototype.** Accordingly the
implementation will be versioned as a new V6.7 implementation, not represented
as a byte-for-byte reproduction of unavailable experiments. Coefficients must
be fitted from data. New choices must be explicit and tested.

### Evidence-based reuse and gap matrix

Classifications apply to the named scope, not production certification.

| Area | Exact existing paths | Finding / class | Minimum action |
|---|---|---|---|
| Data routing and history | `artifacts/api-server/src/lib/data/{marketDataRouter,candleHistoryService,candleCache,types}.ts`, `providers/{derivProvider,mt5Provider}.ts` | **B/E**: real provider routing, provenance and pagination exist; historical service needs isolated DB for baseline | Reuse routing; never introduce a second broker transport |
| Closed/forming bars | `artifacts/api-server/src/lib/data/chart/{chartDataService,candleNormalization,candleTruthEngine,formingBarComposer,timeframes}.ts` | **A** for targeted offline finality/provenance tests; production data unverified | Consume `NormalizedChartCandle` with explicit finality/open/close time; add strict contiguous M1 forecast input boundary |
| Features | `lib/features/src/index.ts`, `artifacts/api-server/src/lib/features/featureSnapshot.ts` | **A** for existing sigma and point-in-time tests; **D** for V6.7 pressure/geometry feature schema | Keep existing feature engine; add one versioned shared structural feature path used by training and inference |
| Structure / patterns | `artifacts/api-server/src/lib/patternSync/{patternSyncEngine,patternSyncComparator}.ts`, `strategyEngine.ts`, `lib/data/chart/chartIntelligence.ts` | **A** advisory Pattern Sync (15/15 baseline); **D** for frozen two-close competing-event observer | Retain advisory reads; implement separate experimental event labels with explicit publication times rather than change existing signal definitions |
| Scalp/scanner/intelligence | `artifacts/api-server/src/lib/{scalp/scalpEngine,marketScanner,signalIntelligence/signalIntelligenceService}.ts` | **A** for targeted scalp tests; **E** for full runtime | Do not replace or feed new forecasts into execution |
| Formula | `docs/arx-structural-intelligence/research/*` | **D**: no competing-risk/pre-break model implementation in source | Fit explicit softmax models, empirical baseline, independent gates and coherent probability reallocation |
| Ghost charts | `artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx`, `src/lib/chart-engine/{types,lightweightChartsAdapter}.ts` | **B**: real chart and overlay adapter exist, no three-scenario candlestick layer | Extend adapter and chart controls; validated training exemplars only, unavailable class stays unavailable |
| Immutable memory | `lib/db/src/schema/chartDecisionMemory.ts`, `artifacts/api-server/src/lib/chart/decisionReceipts.ts` | **B**: immutable receipt JSON and append-only outcome tables already exist; no structural PMF/evaluation contract | Reuse these tables, add typed structural payload and awaited save-before-return; no new database schema |
| Other predictions | `lib/db/src/schema/{agentPredictions,agentPredictionReviews,shadowPredictions}.ts`, `artifacts/api-server/src/lib/{shadowMode,shadowPersistence}.ts` | **B**: directional/trade-oriented journals, no joint structural event-time PMF | Reuse receipt architecture instead of extending mutable shadow outcome fields |
| Evaluation | `lib/validation/src/{cpcv,factory}.ts`, `lib/domain/src/validation-pipeline/` | **B**: strategy/P&L evaluation and purging exist; no structural Brier/log-loss calibration pipeline | Add chronological train/selection/gate/holdout protocol; reuse separation principle, avoid using P&L grades for forecast skill |
| Safety | `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`, `artifacts/api-server/src/lib/live/{liveCommandPipeline,killSwitchBypass}.ts`, `routes/mt5Live.ts` | **A** for 20/20 pure Phase B cases and targeted pre-gate tests; **E** broker E2E | Leave unchanged; new inference graph has no order/arming/dispatch imports |
| DB and deployment | `lib/db/src/schema/`, `lib/db/migrations/`, `scripts/release/` | **E** deployed state; no Supabase/functions tree in this checkout | Use existing PostgreSQL/Drizzle stores; no production mutations or deployment during implementation |

### Baseline, before implementation

Node v24.16.0, pnpm 10.26.1. Frozen offline install fails with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (workspace overrides differ from lockfile).
Local verification uses previously cached external dependencies, with **all
workspace package links explicitly remapped to this checkout**. A clean frozen
install is therefore a known repository baseline issue, not a passed check.

* Pattern Sync: `pnpm --filter @workspace/api-server test:pattern-sync`: 15 pass.
* API batch (`node --import tsx --test --test-force-exit`): Pattern Sync, feature
  snapshot, forming bar, forming tip source, provenance, fallback honesty, shadow
  persistence wiring, scalp engine, emergency kill pre-gate, risk pre-gates,
  trade-engine pipeline: **135 pass, 7 fail**. All seven failures belong to the
  DB-backed pipeline suite/hook, using intentionally unreachable localhost DB;
  they are environment-blocked, not evidence of working integration.
* `cd scripts && node --import tsx src/qaLivePhaseB.ts`: **20/20 pass**.
  The equivalent tsx CLI initially failed on sandbox IPC; using the Node loader
  executes the same test without that IPC dependency.
* `candleHistoryServiceTest.ts`: requires a disposable database; not passed.

### Follow-up verification after implementation

The initially unavailable disposable DB checks were subsequently run against a
separately created local test database: history service **33/33** and pipeline
**6/6** passed. The initial failures above remain the baseline record, not final
failures. New structural tests, HTTP and receipt integration, production builds,
real-feed experiments and limitations are in `ARX_STRUCTURAL_VERIFICATION.md`
and `ARX_REAL_MARKET_VALIDATION_REPORT.md`.

### Authority trace and minimum implementation order

Observed data enters Deriv/MT5 providers -> marketDataRouter -> normalized chart
truth -> existing advisory analysis. Confirmed trading intent separately passes
`tradeEngine/pipeline.ts` -> Risk Governor and platform safety ->
`live/liveCommandPipeline.ts` -> Phase B evaluator -> per-user EA poll in
`routes/mt5Live.ts` -> broker result/reconciliation. A structural forecast must
terminate at a saved receipt and display; it must not enter that command chain.

Stage 0 source audit is complete for the structural integration decision; the
explicit runtime/DB/production gaps remain E. Proceed in order: contracts and
architecture -> finality validation -> causal observer -> fitted/gated math ->
three-ghost adapter -> immutable receipts/evaluation -> chronological historical
and live-feed verification -> scorecard and operational limitations. No existing
working feature is scheduled for replacement. The original preliminary inventory
below is retained as provenance, not current test status.

---

**Audited:** 2026-11-13  
**Reference:** `main` at `76cdbdc9525a2da1eec8113cb3c5fe9b63cf2325`  
**Audit type:** **Initial read-only remote file/path inspection** (not a full code, CI or data audit)  
**PR:** #150, branch `codex/arx-structural-v67-kickoff-20261113`  
**Status:** **IN PROGRESS** — Codex has not yet executed repository tests.

This is a factual starting inventory to prevent duplicate work. The source paths below were verified to exist in GitHub `main` by listing directories and reading representative file headers. Existence is **not** evidence of production readiness, a passing integration test, validated prediction capability, or V6.7 implementation.

## Findings: already-existing code to reuse / inspect

| Responsibility | Verified existing source / documentation | Verified observation | Status before tests | Next action |
| --- | --- | --- | --- | --- |
| Pattern recognition / Pattern Sync | `artifacts/api-server/src/lib/patternSync/patternSyncEngine.ts`, `patternSyncComparator.ts`, `__qa__/` | Pattern Sync engine already implements pure advisory candle/structure pattern reads, with safety boundary documented in source. | **E** (integration/coverage unverified) | Inspect API consumers and deterministic tests; extend rather than create a second pattern analyzer. |
| Market data entry point | `artifacts/api-server/src/lib/marketData/marketDataService.ts`, `realProvider.ts`, `types.ts` | Unified market-data snapshot includes provider, data quality and blocker semantics; read code explicitly rejects fabricated real-time fallback for decision-capable consumers. | **E** | Verify provider provenance, finalization, timestamps, ATR, staleness and the existing tests. |
| Deep candle history / Deriv history | `artifacts/api-server/src/lib/data/candleHistoryService.ts`, `candleCache.ts`, `marketDataRouter.ts`, `providers/derivProvider.ts` | Paginated candle history composes cache, router and Deriv deep fetch; known source/freshness contract. | **E** | Validate candle-close semantics, gaps, tick availability, real historical replay and permission. |
| Current strategy engine | `artifacts/api-server/src/lib/strategyEngine.ts`, `docs/ALGORITHM_MAP.md` | Existing modular strategy engine, with explicit `ADVISORY_UNCALIBRATED` marking. | **E** | Map BOS/sweep/imbalance existing functions against V6.4 causal event-label requirements; do not replace engine. |
| Scalp intelligence | `artifacts/api-server/src/lib/scalp/scalpEngine.ts`, `flameRead.ts`, `scalpManage.ts`, `__qa__/` | Existing pure deterministic scalp evaluation and live-feed honesty rules. | **E** | Confirm hooks/inputs only; no new execution permissions. |
| Chart & overlays | `artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx`, `ChartAiOverlayPanel.tsx`, `lib/chart-engine` (import reference) | Native chart already consumes normalized candles and overlay contracts. | **E** | Inspect overlay APIs and add ghost paths only by extending supported chart layers. |
| Chart event memory | `artifacts/api-server/src/lib/chart/chartDecisionMemory.ts` | Per-user chart-event persistence exists with event type, setup state and metadata. | **E** | Assess suitability for **immutable forecasts** separately; do not assume chart-event memory is sufficient. |
| Signal intelligence | `artifacts/api-server/src/lib/signalIntelligence/signalIntelligenceService.ts` and market scanner | Existing signals and opportunity service paths exist. | **E** | Map advisory/signal boundaries and tests. |
| Historical/backtest infrastructure | `artifacts/api-server/src/lib/backtest/`, `artifacts/api-server/src/routes/backtests.ts`, `scripts/src/` | Backtest/data-reliability modules and many QA runners exist. | **E** | Determine whether chronological event-time, purged walk-forward, labels and Brier metrics already exist. |
| Safety/execution boundaries | `artifacts/api-server/src/lib/riskGovernor/`, `tradeEngine/`, `safety/`; `docs/ARCHITECTURE_MAP.md`, `docs/ALGORITHM_MAP.md` | Repository documents a single authority per responsibility and isolated 18-gate live execution path. | **E** | Freeze interfaces, run safety regression tests, no broker dispatch from forecasting. |
| V6.7 original research formula | Research prose added under `docs/arx-structural-intelligence/research/` | V6.7 report exists in PR; **full fitted model source and weights have not been located or verified**. | **E** | Search all GitHub branches/research artifacts, local Codex research outputs and bundled training files; no invented parameters. |
| Three-ghost path forecast | Research description included in master plan; existing chart overlays present | **No end-to-end 60M three-path implementation has been verified.** | **E** | Map chart extension and research path generation; preserve illustrative vs calibrated distinction. |

## Repository-level guardrails discovered

- `docs/OWNER_DECISIONS.md` rules: Compose instead of duplicating risk primitives; multi-broker implementation in TypeScript, not parallel Python; reviewed branches as source of truth; fail-closed on absent safety facts. Read the full registry before changes.
- `docs/ARCHITECTURE_MAP.md` outlines Risk Governor, Trade Engine, Position Guardian, Broker Hub and Platform Safety as distinct authorities. The source doc references historical PAPER mechanics; identify current user-facing LIVE/DEMO policy rather than copying old mode descriptions.
- `docs/ALGORITHM_MAP.md` identifies extensive pre-existing scalp, scanner, advisory, chart and test surfaces. These must be evaluated against the new forecast requirements before creating services.
- `docs/RESEARCH_OPERATING_SYSTEM.md` requires preregistration, causal data boundaries, chronological holdouts, cost validation, shadow stage and human approval.
- Existing `feature/structural-research-phase1-20261112` branch was discovered. GitHub compare to `main` returned **identical** at inspection time (ahead 0/behind 0). Verify all additional related branches and source archives.
- Repository `main` commit above was retrieved as of this audit; do not treat older inventory reports as current runtime evidence.

## Preliminary classifications

A = implemented, integrated, functioning, tests pass.  
B = implemented, incomplete.  
C = implemented, defective.  
D = demonstrably absent.  
E = existence/integration/behavior **not verified**.

**No component is classified A, B, C or D yet** because this is an inspection-based starting audit, not a comprehensive verified evaluation. None of the existing code should be replaced solely because it is marked E.

## Explicit remaining Stage 0 work

1. Enumerate all relevant branches and inspect modern `main` sources (especially forecast/hazard, structural labeling, risk, chart, market data and database tables).
2. Locate exact V6.7 research source code/weights/artifacts and compare to formulas; report if unavailable.
3. Trace data flow from Deriv/MT5 to chart/analysis, identify causal closed-bar and forming-bar contracts.
4. Run existing repository tests (baseline) in a suitable checkout; capture full command output and commit SHA. **Not yet run.**
5. Inventory database schemas/migrations, current deployed state only if authorized, and event/forecast stores.
6. Create file-level dependency/gap map, identify smallest missing research-only functionality, and set a justifiable implementation order.
7. Verify current user-facing account modes (DEMO/LIVE) against potentially stale historical PAPER descriptions.
8. Do not execute any brokerage, user activation, production DB or deployment actions.

## Audit result

**Stage 0: PARTIAL, NOT COMPLETE.** Verified the existence of significant reusable source surfaces and existing governance rules. The core V6.7 model and real-data testing remain unverified. No tests or trading operations were executed in this initial audit. Codex must complete the audit before implementing.
