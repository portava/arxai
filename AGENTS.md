# ARX AI repository agent instructions

## Structural Intelligence V6.7 active task

If working on ARX Structural Intelligence / PR #150, start at:
- `docs/arx-structural-intelligence/CODEX_START_HERE.md`
- `docs/arx-structural-intelligence/ARX_STRUCTURAL_INTELLIGENCE_MASTER_BUILD_V6_7.md`
- `docs/ARX_STRUCTURAL_ENGINE_AUDIT.md` (preliminary evidence, complete remaining audit)
- `docs/ARX_PROGRESS_MATRIX.md`

Audit **before** implementing. Check earlier branches and features first; use existing modules, do not duplicate.

## Architectural non-negotiables
- Follow owner decision registry `docs/OWNER_DECISIONS.md`; multi-broker integration in this monorepo must be **TypeScript**, not a parallel Python trading service.
- Reuse existing market-data, Pattern Sync, scanner, scalp, chart, prediction memory, risk governor and trade-engine services where suitable.
- Treat LIVE/DEMO execution and analysis as separate authorities. No broker orders, risk control bypasses, production migrations, deployment, or trader permission changes as part of the research task.
- Respect the 18-gate execution architecture and kill switch; emergency close exception is owned by its existing canonical predicate.
- Store immutable forecast timestamps and market-data provenance; enforce past-only features and no lookahead.
- Do not fabricate V6.7 fitted coefficients, calibrated probabilities, real-market skill, predictive price trajectories, or passing tests. Locate original source and trained artifacts before claiming equivalence.
- No silent promotion of candidates to LIVE. The three ghost scenarios are structural illustrations until true path calibration is validated.

## Branch authorization
The owner approved work on a dedicated GitHub branch / draft PR. Do not merge to `main` or deploy to production without separate approval.

## Evidence standard
For each stage, report already-built paths, exact changed files, successful and failing tests, gaps, source provenance, unverified statements, and the next minimal scope.
