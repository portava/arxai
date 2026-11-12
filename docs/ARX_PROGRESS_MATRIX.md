# ARX Structural Intelligence — implementation progress

As of 2026-11-12. PR #150 branch `codex/arx-structural-v67-kickoff-20261113`.
The owner confirmed there is no runnable original model and requested a working
feature inside ARX. This branch now contains that integration. Implementation,
measured forecasting skill and production readiness remain separate judgments.

| Stage | Current state | Evidence and remaining boundary |
|---|---|---|
| 0 — Audit | Source audit completed for integration; deployed system unverified | `ARX_STRUCTURAL_ENGINE_AUDIT.md`: 7,043 tracked-file inventory, existing services, branches, authority trace, baseline tests. Not every historical feature has a runtime certification. |
| 1 — Architecture | Implemented | `ARX_STRUCTURAL_ARCHITECTURE.md`; existing history, normalized chart, receipt/outcome tables and chart adapter reused. |
| 2 — Market data | M1 boundary integrated and tested | `structural/feed.ts`, `runtime.ts`; existing paginated history and current chart truth. Five public Deriv feeds captured. Existing M5/M15/H1/H4 interfaces preserved. MT5 production E2E and original historical ingestion times remain unverified. |
| 3 — Causal structure | Core observer implemented; extended context partial | `lib/domain/src/structural/observer.ts`: causal swings, BOS/CHoCH second-close events, sweeps, FVG formation/retests, 18 features. Multi-timeframe structural features and full FVG invalidation lifecycle remain future version work. |
| 4 — Formula V6.7 | New versioned implementation fitted and tested | `ARX_FORMULA_V67_IMPLEMENTATION_MAP.md`. No recovered-code equivalence claim. All five prebreak candidates rejected by their gates. |
| 5 — Ghost chart | Integrated and browser-verified | Actual `ARXNativeChart`, separate adapter candle series, 60m path toggles, six horizon probabilities. Missing training scenario stays unavailable. Price paths are illustrations. |
| 6 — Memory | Integrated; real PostgreSQL tests pass | Existing `chart_decision_receipts` and `chart_decision_outcomes`; versioned snapshots, fingerprint, model manifest, append-only scores, user isolation. No schema migration. |
| 7 — Historical evaluation | Exploratory real-feed replay completed | `ARX_REAL_MARKET_VALIDATION_REPORT.md`: 39,996 bars, 375 held-out forecasts, six horizons. Short reused sample is not independent edge validation. |
| 8 — Live observation | Bounded prospective cycle demonstrated | Saved V75 issuance before next close, resolved 1m outcome in the same receipt store, original snapshot unchanged. Long-running deployment, disconnect soak and latency distributions remain unverified. |
| 9 — Scorecard | Integrated basic diagnostics | Panel has Brier, frequency baseline, log loss, directional precision/recall and eligibility cohorts. CLI adds reliability bins, lead times, uncertainty and path availability. Regime dashboards and calibrated path coverage remain unavailable. |
| 10 — Improvement lifecycle | Candidate fitting, gates, manifests and brake implemented | Chronological selection/acceptance, OOD fallback, latched prior-outcome brake, versioned reproducibility. No production approval registry or automatic trade promotion. |
| 11 — ARX integration | Working authenticated API and chart integration | POST/GET `/api/me/structural/forecasts`; typed read-only domain contracts. Execution, scanner trading decisions and risk gates unchanged. |
| 12 — DEMO economics | Not authorized or performed | Protocol in `ARX_STRUCTURAL_OPERATIONS.md`; no orders or P&L claim. |
| 13 — LIVE readiness | Not ready for promotion; not deployed | Build and local tests pass. Broader validation, fresh reproducible install, runtime feed E2E, retention/load controls and owner release approval remain. |
| 14 — Maintenance | Backlog and versioning documented | `ARX_STRUCTURAL_OPERATIONS.md`; preserved V6.4–V6.7 reports. |

See `ARX_STRUCTURAL_VERIFICATION.md` for commands, failures and final checks.
