> **Implementation update — 2026-11-12:** The owner confirmed in the build chat
> that no original runnable code exists and requested a working ARX integration.
> See `../ARX_PROGRESS_MATRIX.md`, `../ARX_FORMULA_V67_IMPLEMENTATION_MAP.md`,
> `../ARX_REAL_MARKET_VALIDATION_REPORT.md` and `../ARX_STRUCTURAL_VERIFICATION.md`
> for the new implementation and measured evidence. The historical source-search
> instructions below remain provenance; they are not a blocker to this authorized
> new implementation. Prior report statistics must not be claimed as its results.

# CODEX — START ARX STRUCTURAL INTELLIGENCE V6.7

**Repository:** `portava/arxai`  
**Branch/PR:** Use the dedicated branch containing this specification.  
**Owner authorization:** GitHub feature branch commits and PR work allowed. No merge to main, deploy, production DB mutations, LIVE or DEMO broker orders, trading authority changes, or safety-gate bypasses.

## Read first

1. `docs/arx-structural-intelligence/ARX_STRUCTURAL_INTELLIGENCE_MASTER_BUILD_V6_7.md`
2. `docs/arx-structural-intelligence/research/ARX_FORMULA_V67_RESEARCH_REPORT.md`
3. V6.6, V6.5, V6.4 research reports in that same directory.
4. All applicable repository documents, existing risk/execution boundary rules, tests, and any work in `feature/structural-research-phase1-20261112`.

## Immediate task

**Begin Stage 0 now.** Inventory what already exists with exact files, types, migrations, services, current tests, commits and prior research. Classify each component A=operational, B=incomplete, C=defective, D=absent, E=not verified. Create `docs/ARX_STRUCTURAL_ENGINE_AUDIT.md` with an evidence-based implementation gap matrix and a minimal diff plan.

**Then start implementing only verified missing/defective research-only capabilities** from the staged roadmap. The first coding step after audit should be the smallest safely testable gap, and each stage must include unit/integration/regression tests, no-lookahead proof, and a progress report. Reuse all working services and data contracts.

Reconcile V6.7 with the exact source implementation if available; do not fabricate missing weights, features, or acceptance thresholds. Preserve 60-minute subtype marginals, horizon coherence, immutable forecasts, model fallbacks, research-only broker isolation, and all 18 execution gates.

**Deliver in this PR:** an audit, real file-level changes (only if warranted), tests/logs, current progress matrix, and a clear blocked-items report. Do not falsely claim real-data validation from synthetic data.

If work cannot safely proceed without source files, data permissions, or product decisions, complete the audit and relevant test harness, document exact blockers and stop unauthorized actions.
