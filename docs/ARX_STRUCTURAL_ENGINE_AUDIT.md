# ARX Structural Intelligence — Stage 0 initial source audit

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
