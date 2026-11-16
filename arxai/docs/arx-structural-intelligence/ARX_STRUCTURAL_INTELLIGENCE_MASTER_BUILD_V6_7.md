# ARX AI — Structural Intelligence Master Build & V6.7 Formula

> **Authorization update — 2026-11-13:** Owner explicitly authorized GitHub publication and Codex implementation work on a dedicated feature branch / draft PR. This supersedes older prohibitions on **branch commits only**. It does not authorize merge to `main`, production deployment, production schema changes, LIVE/DEMO trading, or changes to execution authority.
>
> **First action:** Audit all prior work before coding. Compare `main`, any existing `feature/structural-research-phase1-20261112` branch, repository docs, prior services, tests and research artifacts. Do not duplicate or replace existing working components. Synthetic V6.7 results are **not** real-market performance.
>
> **Provenance:** Markdown adaptation of the approved Word/PDF master build directive, plus bundled research reports V6.4–V6.7. Missing V6.7 learned coefficients and original runnable model source must be located; never invent them.



ARX / AI
STRUCTURAL INTELLIGENCE
MASTER BUILD DIRECTIVE
Stage-by-stage Codex instructions + V6.7 mathematical specification

AUDIT FIRST • REUSE WHAT EXISTS • BUILD ONLY WHAT IS MISSING


Project: ARX AI Trading Platform
Research foundation: Formula V6.7 and applicable V6.0-V6.6 components
Scope: Local development, testing, research integration
Date: November 13, 2026
Approval boundary (updated by owner): Dedicated feature-branch commits/PRs are authorized. No merge, production deployment, database mutation, or broker orders.

FOR CODEX | EXECUTION DOCUMENT
Research note: Based on V6.2-V6.7 ARX research reports (November 12, 2026). V6.7 was tested only on synthetic markets, was not
promoted to GitHub, and its full runnable source and trained parameters must be verified. No trading authority is granted.

# 1 | Direct instruction to Codex
You are responsible for evaluating, completing, and integrating the ARX Structural Intelligence Engine within the
existing ARX AI application. The primary goal is to improve forecasting and real-world evaluation while
preserving all functioning trading and safety systems.
     AUDIT -> REUSE -> REPAIR -> BUILD GAPS -> TEST -> VALIDATE -> REPORT

Non-negotiable rules
  - Do not begin by recreating the forecasting engine. First audit all existing repository code, migrations, services,
    research artifacts, charts, signals, and test suites.
  - Treat implemented, integrated, tested, and production-ready as separate states. Source code existing in a
    folder does not prove a feature works.
  - Reuse functional components and repair incomplete integrations. Create new modules or tables only where
    verified gaps remain.
  - Preserve the existing DEMO/LIVE architecture, shared EA bridge, per-user arming and kill controls, and all 18
    execution safety gates.
  - Forecasts are research outputs. Nothing in this directive authorizes a LIVE/DEMO order, permission change,
    broker-command dispatch, production migration, GitHub push, or deployment.
  - Use real broker/tick history when authorized and available; otherwise disclose missing data and do not
    substitute synthetic simulations as proof of live performance.
  - No silent approximation: missing V6.7 source code, parameters, feature definitions, or acceptance thresholds
    must be reported rather than invented.

Audit status taxonomy
 Status                                 Definition                               Required response

                                        Integrated with evidence and passing
 A - Operational                                                                 Reuse unchanged
                                        tests
                                        Existing code with missing
 B - Incomplete                                                                  Extend
                                        integration/features
                                        Existing implementation fails
 C - Defective                                                                   Repair
                                        validation
 D - Absent                             No suitable implementation found         Build minimum gap
                                        Cannot establish status from available
 E - Unverified                                                                  Investigate / block
                                        evidence

Evidence before action
For every stage, cite relevant file paths, current branch/commit, exact existing interfaces, test commands and
outputs, missing dependencies, and observed failures. Report whether a capability is working, partially working,
or only described in research.


# 2 | Stage overview
 Stage                                  Build stream                             Principal deliverable

 0                                      Full system audit                        ARX_STRUCTURAL_ENGINE_AUDIT.md
 1                                      Architecture & gap plan                  ARX_STRUCTURAL_ARCHITECTURE.md
 2                                      Market-data integrity                    Verified candle/tick interface
 3                                      Structure & patterns                     Causal event labels and tests
 4                                      V6.7 formula integration                 Versioned, coherent forecast engine
 5                                      Three ghost trajectories                 Chart overlay + scenario validation

                                                                                   Immutable outcome-ready forecast
 6                                      Prediction memory
                                                                                   records
                                                                                   ARX_REAL_MARKET_VALIDATION_REP
 7                                      Historical real-data evaluation
                                                                                   ORT.md
 8                                      Shadow forecasting                         Non-trading live forecasts
 9                                      Performance diagnostics                    Evidence-backed ARX scorecard
 10                                     Controlled improvement                     Candidate/approval/rollback workflow
 11                                     ARX intelligence integration               Read-only decision interface
 12                                     Authorized DEMO testing                    Execution-cost and P&L research
 13                                     LIVE-readiness assessment                  Safety and operations review only
 14                                     Maintenance & evolution                    Versioning and prioritized backlog

# 3 | Stage-by-stage build plan
## Stage 0 | Complete existing-system audit
Audit/reuse: Inventory the active ARX repository (previously portava/arxai; verify branch and commit), services,
frontend, Supabase migrations, Edge Functions, Deriv feeds, MT5 EA bridge, signal generation, Pattern Sync, FVG,
scalping, risk and charting. Locate research/source from V6.0 through V6.7; search local branches and available
artifacts before declaring anything missing.
Implement/verify: Classify every component A/B/C/D/E. Run baseline tests without changing production. Trace
market-data -> signal -> command -> 18-gate evaluation -> EA poll -> order-result paths. Identify permission
boundaries and pending deployments.
Gate/deliverable: ARX_STRUCTURAL_ENGINE_AUDIT.md, inventory table with exact paths, reusable systems,
missing work, unresolved blockers, initial test results, minimum change-set. Stop architectural changes until audit
is complete.
## Stage 1 | System architecture and change plan
Audit/reuse: Reuse current market-data, pattern, forecast, memory, evaluation, chart, and integration functions
rather than creating standalone duplicate services.
Implement/verify: Define explicit contracts for candle finality, timestamp provenance, feature snapshots,
structural event labels, joint event-time forecasts, scenario paths, prediction history, diagnostics and read-only
trading intelligence. Record dependency direction and rollback.
Gate/deliverable: ARX_STRUCTURAL_ARCHITECTURE.md: existing/reused components, interface contracts,
dataflow, ownership, file-level change plan, tests and risks.
## Stage 2 | Historical and real-time market-data integrity
Audit/reuse: Inspect the existing Deriv synthetic indices, MT5/CopyRates status and provider ingestion. Prioritize
V75, V75(1s), V50, V50(1s), V25(1s), then other supported symbols.
Implement/verify: Support finalized OHLC and distinct forming bars; M1/M5/M15/H1/H4; ticks where available;
timezones; missing/duplicate candles; stale data; verified instrument precision, provider identity, gaps and order-
of-tick ambiguity. Keep point-in-time available information exact.
Gate/deliverable: Verified event/candle interfaces, historical replay fixtures, stale/gap tests, no-lookahead tests
and a data-quality report.
## Stage 3 | Causal structural and pattern recognition
Audit/reuse: Audit existing swing geometry, BOS/CHoCH, liquidity sweeps, FVG formation/retest, Pattern Sync,
consolidation, volatility, momentum and reversal detection.

Implement/verify: Use defined developing -> precursor -> confirmed states; confirmed swings are known only
after their confirmation; freeze pivot and ATR references at event time; timestamp confirmation at the second
closed bar. Add patterns only with reproducible definitions and tests; include higher-timeframe context causally.
Gate/deliverable: Deterministic event observer, no-backdating tests, labeled fixtures for BOS/CHoCH/sweep/FVG
and clear separate definitions of recognition vs forecast.
## Stage 4 | V6.7 predictive formula integration
Audit/reuse: Locate exact V6.7 implementation, coefficients, feature transforms, training protocol, OOD checks
and acceptance gates. Preserve V6.6 and prior fallbacks; do not infer absent learned values.
Implement/verify: Implement one 5-class competing-risk event-time model feeding three exclusive outcomes at
1/3/5/15/30/60m; distinguish pre-break from after-precursor confirmation. Preserve 60-minute subtype marginals
when reallocating early event mass. Gate candidate upgrades against baselines.
Gate/deliverable: Versioned probability engine, source mapping, mathematical-invariant tests, baseline
comparison, provenance and abstain/fallback behavior.
## Stage 5 | Three-ghost trajectories and chart UI
Audit/reuse: Inspect current charts, projected-candle/forecast overlays and V6 research ghost generators before
adding UI.
Implement/verify: On request, show bullish-first, bearish-first and neither-confirmed paths for up to 60 M1
candles each (180 candles total), each with coherent structural outcome, timestamp, version, horizon and
probability. Initially label training-only paths as illustrations; reserve calibrated price forecasts for separately
proven models.
Gate/deliverable: Chart overlay with toggle/selection controls, scenario replay verification and unmistakable
illustration-vs-calibrated distinction.
## Stage 6 | Immutable structural prediction memory
Audit/reuse: Inspect current forecast/signal/market-event/analytics schemas and tables before proposing new
database design.
Implement/verify: Record timestamp and data vintage, provider/symbol, model/version, immutable features,
event-time PMF, three-horizon classes, generated paths, eligibility, gate state and later outcomes. Store predictions
before outcomes; evaluate asynchronously only when horizon closes; preserve originals and attach versioned
evaluations.
Gate/deliverable: Locally tested persistence/migrations (not applied to production), immutable-record invariants,
future-outcome isolation and retention plan.
## Stage 7 | Historical real-market validation
Audit/reuse: Use timestamped authorized Deriv/MT5 tick+M1 history with provenance. If absent, build local
replay harness but mark this stage blocked for real-market claims.
Implement/verify: Pre-register frozen event definitions and baselines; chronological
train/selection/acceptance/untouched holdout with purge/embargo for overlapping forecast windows. Replay with
point-in-time feature availability, prewrite forecasts, then reveal outcomes. Evaluate shifts and each
symbol/horizon.
Gate/deliverable: ARX_REAL_MARKET_VALIDATION_REPORT.md with Brier, log loss, calibration, direction
precision/recall, alert lead/false alarm, timing, coverage, paths, samples and uncertainty.
## Stage 8 | Real-time shadow forecasting
Audit/reuse: Reuse existing live feed without granting order privileges. Shadow mode is an internal research
process, not a new Paper account.

Implement/verify: Issue and durably log forecasts on actual feed arrivals; measure ingest-to-inference latency,
stale inputs, disconnect behavior, outcome resolution and live drift; suppress questionable predictions and all
broker commands.
Gate/deliverable: Operational read-only shadow monitor with demonstrated zero execution effects and live-
evidence logs.
## Stage 9 | Performance scorecard and diagnostics
Audit/reuse: Find existing analytics and grade widgets; reuse compatible components.
Implement/verify: Display by symbol/regime/horizon: true pre-break precision, confirmation precision, Brier vs
frequency/geometry/V6.6, probability reliability, ghost-path scoring where available, latency, feed quality, drift
and abstention rate. A-F grades only from documented predefined thresholds; otherwise NOT YET VALIDATED.
Gate/deliverable: ARX Structural Intelligence Scorecard with reproducible metric definitions and source
observations.
## Stage 10 | Controlled model-improvement lifecycle
Audit/reuse: Inspect existing model selection, baseline arbitration, quarantine and rollback behaviors from V6.5-
V6.7.
Implement/verify: Diagnose specific failure -> isolate smallest change -> train on permitted data -> select and gate
independently -> evaluate OOD/regime robustness -> version and retain rollback. Do not re-tune immutable final
holdouts or silently auto-promote models.
Gate/deliverable: Versioned candidate pipeline, model manifest, performance diff, signed-off gate result,
fallback/rollback evidence.
## Stage 11 | Read-only ARX decision-intelligence integration
Audit/reuse: Inspect execution boundaries, scalping engine, Pattern Sync, Position Guardian, signal engine and AI
authority modes OFF/ADVISE_ONLY/AI_ASSISTED.
Implement/verify: Expose typed read-only predictions, calibrated uncertainty, event timing, structural levels,
invalidation and source evidence; do not couple forecast generation to executeInstant, confirmation/dispatch, EA
polls, or order creation.
Gate/deliverable: Integration contract and safety regression tests demonstrating 18-gate integrity and no
unauthorized order side effects.
## Stage 12 | Controlled DEMO economic validation - separate approval
Audit/reuse: Do not submit demo trades under this directive. Prepare demo test plans and harnesses using
existing DEMO mode.
Implement/verify: With explicit authorization only, evaluate actual strategy rules and realistic spreads, slippage,
commission, latency, fill rates, drawdown, risk-adjusted returns and false positives. Separate forecast skill from
economic P&L.
Gate/deliverable: DEMO testing protocol and economic report, clearly marked NOT AUTHORIZED until approval.
## Stage 13 | LIVE-readiness assessment - no activation
Audit/reuse: Review model validation, live shadow reliability, broker E2E readiness, safety operations, kill
switches, authority controls and rollback.
Implement/verify: Create readiness checklist; identify insufficient evidence and unresolved infrastructure. No
live trading, trader activation, privilege changes, or release merely because the checklist exists.
Gate/deliverable: LIVE readiness report and explicit outstanding owner decisions; no execution authorization.
## Stage 14 | Continuous development and maintenance
Audit/reuse: Keep a single progress matrix linking stages to components, current file paths, grades, tickets, test
evidence, known failures and owners.
Implement/verify: Prioritize validated deficiencies in pre-break skill, event timing, cross-timeframe features,
OOD abstention, true path calibration, cost-aware economics and operational performance. Avoid expanding
scope without evidence.
Gate/deliverable: Maintained backlog, versioned docs, reproducible research artifacts and release notes.


# 4 | V6.7 mathematical implementation specification
This section expresses the documented V6.4-V6.7 mathematical contracts. It is not a substitute for the original
source code: exact trained coefficients, feature transformations, eligibility details, and numerical gates must be
recovered and verified from the research artifacts.

## 4.1 Causal structural-event labels
Use previously confirmed pivots. For an upward precursor, the first closed candle must exceed a frozen swing
high by at least 0.35 x the prior-bar ATR; for downward, it must close below a swing low by that amount. An event
is confirmed only after a second consecutive qualifying close at least 0.15 x ATR beyond that same pivot. Identify
BOS vs CHoCH using the existing causal structure state; a first-close precursor is never called confirmed.
  UP_PRECURSOR: C[i] - PivotHigh >= 0.35 * ATR[i-1]
  DOWN_PRECURSOR: PivotLow - C[i] >= 0.35 * ATR[i-1]
  UP_CONFIRMED: C[i+1] - PivotHigh >= 0.15 * ATR[i]
  DOWN_CONFIRMED: PivotLow - C[i+1] >= 0.15 * ATR[i]

These threshold values are experimental labeling rules from V6.4, not universal market-structure definitions. Use
existing pivot-age, two-close, displacement and frozen-level rules precisely, not just these shorthand equations.

## 4.2 Five-class discrete-time competing-risk model
At each prospective minute j, conditional on no earlier directional confirmation, fit a five-way softmax over
BOS_UP, CHOCH_UP, BOS_DOWN, CHOCH_DOWN, and SURVIVE. The feature vector must be point-in-time causal.
  K = {BOS_UP, CHOCH_UP, BOS_DOWN, CHOCH_DOWN, SURVIVE}
  z[j,k] = W[k] . Features(X_t, j) + b[k]
  q[j,k] = exp(z[j,k]) / sum_{r in K} exp(z[j,r])
  S[0] = 1
  S[j] = S[j-1] * q[j,SURVIVE]
  p[j,k] = S[j-1] * q[j,k] for k != SURVIVE

W and b are learned on eligible training examples, not set by hand. During fitting, event labels and risk sets must
be chronologically valid; once an event occurs, later minutes for that episode are not considered at risk for a first
event.

## 4.3 Three mutually exclusive horizon probabilities
  P_UP(H) = sum_{j=1..H}(p[j,BOS_UP] + p[j,CHOCH_UP])
  P_DOWN(H) = sum_{j=1..H}(p[j,BOS_DOWN] + p[j,CHOCH_DOWN])
  P_NONE(H) = S[H]
  P_UP(H) + P_DOWN(H) + P_NONE(H) = 1
  H in {1, 3, 5, 15, 30, 60}

P_NONE means no qualifying two-close-confirmed directional structural event by H; it does not mean flat prices, a
small range, or no wick movement. All horizons must derive from the same joint distribution. Cumulative first-
event incidence must be non-decreasing with H.

## 4.4 V6.7 genuine pre-break model
V6.7 targets the first qualifying BOS/CHoCH within five minutes from a forecast snapshot without an already
observable first-close breakout precursor. It therefore tests prediction before the initial break, not mechanical
completion after the first break.
  X_pre = PastOnlyPreBreakFeatures(last_120_closed_M1, causal_context)
  z_pre = W_pre * X_pre + b_pre
  P_prebreak_5m = softmax(z_pre)
  classes = {UP_FIRST, DOWN_FIRST, NEITHER_CONFIRMED}

Documented feature families: pre-break pressure, confirmed swing geometry and level distances, momentum,
volatility compression/expansion, candle geometry and historical structural context. This list is not the exact
learned feature schema. Restore original transforms, coefficients, regularization, calibration and eligibility checks
from V6.7 source. Do not invent missing coefficients.
V6.6 is the separate post-precursor confirmation engine. Never combine its after-first-close performance with V6.7
genuine pre-break warning precision.

## 4.5 Preserve 60-minute event-type probabilities
V6.6 developed a mathematically constrained early event-time reallocation. V6.7 adapts the early five-minute
allocation while preserving fine-grained four-subtype 60-minute event probabilities. The conversion from the V6.7
three-class prediction to minute-by-subtype candidate mass must match the original code; it cannot be uniquely
reconstructed from the report alone.
  p_base[j,k] = baseline first-event probability for minute j, subtype k
  M[k]      = sum_{j=1..60} p_base[j,k]
  r[j,k]   = (1-w)*p_base[j,k] + w*p_candidate[j,k], j<=5
  A[k]     = sum_{j=1..5} r[j,k]

If A[k] exceeds M[k], proportionally shrink r[1..5,k] to fit the available M[k]. Let E[k] be the accepted early mass.
Allocate remaining M[k]-E[k] across minutes 6-60 proportionally to the baseline late-time mass.
  B[k] = sum_{j=6..60} p_base[j,k]
  p_new[j,k] = (M[k]-E[k]) * p_base[j,k] / B[k], j=6..60, B[k]>0
  ASSERT: sum_{j=1..60} p_new[j,k] == M[k] (within tolerance)

Handle zero late-time mass without division by zero. The safe fallback is the unmodified baseline subtype
distribution where reallocation is infeasible. Recompute survival and horizon probabilities from the coherent
joint distribution, not by separate ad hoc normalization. Enforce nonnegativity, monotone cumulative incidence
and unchanged survival at 60m.

## 4.6 Model selection, calibration, out-of-distribution abstention
Use training-frequency, geometry and advanced-model baselines; candidate approval must come from
independent model-selection and acceptance-gate partitions. V6.7 includes OOD historical-feature screening and a
prior-completed-outcomes-only short-horizon performance brake. Preserve the original learned settings or mark
them unavailable; never fabricate a numerical approval threshold.
  Brier(H) = (1/N) * sum_i sum_c (p[i,c,H] - y[i,c,H])^2
  Relative_Brier_Gain = (Brier_baseline - Brier_candidate) / Brier_baseline

Lower is better. Report Brier, log loss, calibration and paired uncertainty on untouched out-of-sample histories. If
a candidate fails the validation gate, or the input is OOD/stale/insufficient, use an approved baseline or abstain.
After quarantine, no unreviewed automatic re-enablement.

## 4.7 Three-ghost trajectory contract
A chart request returns three labeled structural scenarios: bullish confirmed first, bearish confirmed first, and
neither confirmed. At M1 x 60 minutes, this can visualize 60 OHLC candles per scenario (180 illustrative candles

total). The scenario probability belongs to the event model; a particular selected ghost path is not a calibrated
conditional price prediction.
  Ghost_A: scenario=UP_FIRST, probability=P_UP(60)
  Ghost_B: scenario=DOWN_FIRST, probability=P_DOWN(60)
  Ghost_C: scenario=NEITHER, probability=P_NONE(60)
  CHECK: each path is an OHLC-valid, training-only, past-adapted example;
     replay each through the frozen event observer to verify its class.

Where no valid class-matching example exists, report the path unavailable; never fabricate it. Future work may fit
P(Future_OHLC_Path | Known_History, Structural_Class), but only independently calibrated and evaluated paths
may be described as predictive price trajectories.

## 4.8 Prediction memory and causal evaluation
Persist forecast_id, timestamp, provider, symbol, data vintage, model and feature versions, features or immutable
snapshot hash, pre-break eligibility, gate status, event-time mass, three probabilities by horizon, path references
and evaluation deadlines. Write immutable issued forecasts before obtaining the future outcome. Later attach
distinct scored outcome records with actual event subtype/time, invalidation reason and model comparison.


# 5 | Validation, gates, and operating safeguards
## 5.1 Required test matrix
 Test group                                                 Mandatory assertions

                                                            Finalized/forming distinction; provider timestamps; gaps;
 Data integrity
                                                            duplicates; staleness; tick-order ambiguity.
                                                            Frozen pivot; confirmed swing; two successive closes;
 Structural labeling
                                                            second-close timestamp; causal FVG/sweep.
                                                            Softmax and survival coherence; probabilities sum to 1; no
 Mathematics
                                                            negative masses; horizon monotonicity.
                                                            Per-subtype 60m marginal unchanged by V6.7 short-horizon
 Terminal preservation
                                                            reallocation.
                                                            Mutating reserved future candles cannot alter past feature
 Future leakage
                                                            snapshots or forecasts.
                                                            No genuine pre-break claim when first-close precursor is
 Pre-break eligibility
                                                            already observable.
                                                            Fallback, gate rejection, OOD abstention, completed-outcome-
 Model controls
                                                            only brake, quarantine/rollback.
                                                            OHLC validity; correct first-event classification; source
 Ghost paths
                                                            restricted to known training data.
                                                            Forecast immutable; outcome known only after horizon; no
 Persistence
                                                            silent revision; version traceability.
                                                            Read-only inference cannot create/modify/cancel orders; 18
 Safety
                                                            gates and kill controls unchanged.

## 5.2 Real-data evaluation protocol
  - Acquire authorized timestamped Deriv and/or MT5 M1 and tick history with symbol/provider provenance.
    Keep feed generation separate from simulated or resampled data.
  - Freeze event definitions and test plan before evaluating true out-of-sample periods. Build chronological train,
    selection, independent acceptance, and final held-out segments. Purge overlapping prediction windows.
  - Replay candles and ticks in arrival order; generate and durably save forecasts at their simulated issuance
    timestamp; reveal future bars only after saving.

  - Measure three-class Brier/log loss, reliability/calibration, pre-break alert precision and false alarms,
    confirmation forecast metrics separately, time-to-event, regime performance and sample sizes.
  - Do not claim an economic edge before evaluating executable, authorization-bounded strategies with spreads,
    commissions, slippage, latency and drawdowns.
  - Maintain exact first-break/confirmation event-time semantics for each instrument, including tick-order
    uncertainty when candle OHLC is insufficient.

## 5.3 Stage exit reporting - mandatory after every stage
  STAGE / NAME / BRANCH+COMMIT
  ALREADY BUILT / REUSED / REPAIRED / NEW
  FILES CHANGED / TEST COMMANDS / PASS-FAIL-SKIP COUNTS
  RESULT METRICS / KNOWN LIMITATIONS / BLOCKERS
  APPROVAL BOUNDARY / STATUS / NEXT STAGE

## 5.4 Current synthetic-research reference (not market evidence)
 Research fact                                               Documented V6.7 result

 Mode                                                        Offline synthetic research; no broker data
 Final test episodes                                         1,400 synthetic; 1,322 eligible pre-break
 V6.6 five-minute Brier                                      0.408268
 V6.7 five-minute Brier                                      0.404839
 Relative improvement                                        0.84% across those synthetic tests
 Advanced gate approved                                      Only weak-fast-switch synthetic generator
 60-minute marginal effect                                   Preserved by construction; not newly improved
 Trading authority                                           None; no LIVE or DEMO orders permitted


A reported V6.7 early-warning experiment generated 24 warnings in the single accepted artificial regime, with 10
directionally correct: 41.7% precision in that test. This is not a live win rate, and other synthetic regimes rejected
the new head. Exact acceptance settings must be recovered from the original source.


# 6 | Developer deliverables and immediately executable command
Expected local artifacts
  - ARX_STRUCTURAL_ENGINE_AUDIT.md - authoritative inventory and evidence; precedes modifications.
  - ARX_STRUCTURAL_ARCHITECTURE.md - reused components, gaps, interfaces and data flow.
  - ARX_FORMULA_V67_IMPLEMENTATION_MAP.md - each mathematical component mapped to source
    file/function/test and verified parameters.
  - ARX_REAL_MARKET_VALIDATION_REPORT.md - actual historical out-of-sample evidence, or BLOCKED with
    exact missing data/access.
  - ARX_STRUCTURAL_SCORECARD.md - evidence-backed grades and NOT YET VALIDATED where appropriate.
  - ARX_PROGRESS_MATRIX.md - stage/component status, regression results, unresolved issues and explicit
    approvals.

Command to Codex
  BEGIN STAGE 0 NOW. Audit the existing ARX project and V6.0-V6.7 artifacts.
  Do not build duplicate functionality. Produce the evidence-based gap map
  and mathematical source-code map. Then execute only verified missing
  local-development work, stage by stage, with tests and reports.
  Do not merge to main, deploy, migrate production, or issue broker orders.

