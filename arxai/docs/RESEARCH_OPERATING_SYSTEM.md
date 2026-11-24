# ARX Research Operating System

Transcribed from Blueprint Part IV — Evidence and research operating system
(`docs/prodready-20260819/MASTER_BLUEPRINT_EXTRACTED.md`). This document
GOVERNS how `lib/discovery` is used: every experiment run through the
discovery pipeline must be pre-registered (hypothesis + full parameter set
inserted BEFORE any metric exists) and must follow the lifecycle below. The
pipeline's terminal output is a CANDIDATE with `liveAllowed=false`; nothing
promotes past shadow without the human stages and evidence package here.

ARX should not treat research as a notebook that occasionally produces code.
Research is a governed production pipeline with explicit questions, frozen
evidence, independent validation, and a default outcome of rejection.

## Research lifecycle

1. Observe a measurable problem, anomaly or opportunity without deciding the
   conclusion.
2. Search the negative-knowledge library and prior experiments.
3. Write a falsifiable hypothesis and the evidence that would reject it.
4. Approve the dataset, labels, cost assumptions, sample boundaries and search
   budget.
5. Register the experiment before reading the final holdout.
6. Run chronological development tests with leakage controls.
7. Run walk-forward, sensitivity, ablation and materially worse-cost tests.
8. Use the untouched final holdout once after the design is frozen.
9. Reject, retest with a stated reason, or send to shadow; never promote
   directly.
10. Collect live shadow and demo evidence, including execution and
    reconciliation.
11. Produce a safety case, behavioral diff and owner review packet.
12. Promote only to the maximum authority earned by the evidence, with
    automatic expiry and retirement rules.

## Minimum evidence package

- Preregistered hypothesis, decision target and falsification criteria.
- Dataset provenance, hashes, time ranges, exclusions and data-quality report.
- Exact feature, label, cost and execution assumptions.
- Train, validation, walk-forward and final-holdout boundaries.
- Calibration, conservative EV, drawdown, tail, capacity and abstention
  results.
- Sensitivity to parameters, latency, slippage, missed fills and missing data.
- Ablation of every feature and comparison with the minimum-intelligence
  baseline.
- Code commit, model artifact, configuration hash and deterministic replay
  result.
- Shadow/demo sample, broker behavior and reconciliation evidence.
- Known limitations, unsupported regimes, breakers, expiry and rollback path.

## Research questions that must remain open

- Whether any candidate edge remains positive after realistic costs and
  sufficient out-of-sample evidence.
- Whether the intended opportunity rate supports the original trade-throughput
  objective without manufacturing trades.
- Whether performance transfers across Deriv instruments, brokers or account
  environments.
- Whether complex models add durable value over interpretable baselines.
- Whether observed market relationships are stable mechanisms or temporary
  correlations.
- Whether the product can support meaningful live capital within the approved
  drawdown and operational constraints.

## ATI implementation order

Start with one versioned Self-Trade setup on one instrument and timeframe.
The following dependencies apply to the isolated ATI build. Existing ARX
components provide starting points. Each stage needs its own evidence before
its conclusions can affect a later decision.

| Order | What ARX already provides | ATI deliverable and evidence required |
| --- | --- | --- |
| 1a. Shadow report | Self-Trade decision engine, venue adapters and Trade Engine bracket grading | Capture both decisions before the outcome. Replay the same released quotes after restart. Show skipped setups, unobserved bars, partial paths and per-strategy net results. |
| 1b. Execution costs, in parallel | MT5 command pipeline, bridge events and deal-history receipts | Reconcile owner, account, mode, order, deal, side and quantity. Report decision spread, movement to submission, slippage and separately evidenced charges. Check a complete broker round trip before using it for net-cost calibration. |
| 2. Trading Memory | Persisted decisions, outcomes and execution events | Reconstruct what a single owner could know at each decision, including when a label became available. Keep research holdouts private and test across restart. |
| 3. Research Lab | Research lifecycle, chronological folds, Monte Carlo validation | Register the hypothesis, chronology and rejection criteria. Freeze the dataset, verify an offline replay and retain the outcome when the hypothesis fails. |
| 4. Counterargument and timing | Existing decision checks, entry zone and Trading Memory | Compare the original entry with waiting, reducing size or skipping. Account for missed winners, no-fills and adverse executable entries after waiting. |
| 5. Regime and instrument rules | Market evidence, structural context and instrument profiles | Freeze classifications at decision time. Compare net results within each supported instrument and regime, with sample counts and an untouched period. |
| 6. Early patterns and Ghost | Structural forecast issuance, persistence and scoring | Score early breaks and projected paths against simple frequency and last-close baselines. Check probability calibration, band coverage and restart-safe forward receipts. |
| 7. Position Guardian | L3 position-management evaluator, first target and archived quote replay | Change one exit rule at a time. Compare paired net returns, changed exits and drawdown on the same eligible strategy entries. Carry every unfilled or unresolved case through the report. |
| 8. Adaptive portfolio risk | Portfolio Risk Engine, Risk Governor, position sizer and Self-Trade correlation checks | Freeze the owner/account book, exposure, drawdown, cost quality and applicable limits at the decision. Compare constrained sizes under the same concurrent opportunities. Test simultaneous losses, missing risk inputs and hard-limit dominance. |
| 9. Specialist scoring | Agent result ledger, weighting logic, signal evidence and frozen research cohorts | Score each specialist against a simple baseline for its assigned job. Compare calibration and net contribution on held-out regimes, including an ablation that removes each specialist. |
| 10. Monitoring and recovery | Feed freshness, bridge sequencing, immutable research seals and execution reconciliation | Detect stale inputs, broken streams, delayed fills, cost drift and restart gaps. Rehearse recovery with duplicated or reordered messages, then prove that recovery preserves the evidence and cannot duplicate an order. |
| 11. Controlled promotion readiness | Strategy lifecycle, promotion and demotion gates, Risk Governor | Assemble a version-specific review packet with out-of-sample results, independent forward evidence, reconciled venue costs and rollback criteria. Negative, missing or cross-strategy evidence cannot satisfy the gate. |

### Candidate review

`GET /api/self-trade-ai/agents/:id/ati-research-studies/:runId/candidate-review`
accepts either member of a registered primary/forward pair. It replays the
scored outcomes, reports sealed capture coverage by phase, and includes
the cost basis used in each simulation. Open studies withhold decisions,
grades and broker matches. The review has no execution authority.

For a sealed native fleet study, ARX rebuilds the cutoff dataset and selects
the reproduced out-of-sample decisions. The MT5 reader independently reconciles
each position. Every opening fill must link to one of those exact decision IDs
under the registered agent, build, instrument, setup, timeframe and settings.
The primary and forward each have their own dispatch window. Results retain
the broker account grouping and mode, including when the decision feed was
Deriv. Spread and movement before submission have their own entry-fill
denominators. Broker costs attach to the incumbent. The shadow challenger
retains its simulation basis.

The packet also lists the existing lifecycle demotion thresholds. Applying
those rules and rehearsing recovery for this candidate require separate
evidence. A passed archive replay alone can establish the registered
comparison and leaves the remaining evidence gaps visible.

At 09:28 UTC on November 24, the V75 fleet primary was open. Two fresh
read-only processes returned the same candidate evidence. Across the four
isolated V75 study databases inspected, the owner had zero attested DEMO
or LIVE dispatches, triggered deals or reconciled positions from midnight
through the review cutoff. Real broker costs for that sample are unknown.
[Candidate review and isolated MT5 inventory](ati-evidence/v75-m5-candidate-review-20261124T0928Z.json).

The native V75 fleet pilot finished capture at 09:37:14 UTC. Each of the
13 M5 slots contained an observed trend-continuation decision. Both versions
waited on all 13. Nine chart checks lacked broker-price alignment and four
lacked cached chart intelligence. One additional read in an observed slot
had an unverified fleet price source. All 14 records matched their stored
native decisions. Two fresh processes reproduced the report and coverage
byte for byte at 09:37:20 UTC. Zero entries qualified for grading.
[Native fleet capture-end report](ati-evidence/v75-m5-owner-fleet-20261124T093720Z.json).

ATI looks up canonical synthetic instruments using their exact MT5 catalog
names. V75 includes Volatility 75 Index and R_75. V75_1S includes Volatility
75 (1s) Index and 1HZ75V. A report requested by a native name stays exact.
A saved command mapping that names a different known instrument cannot
credit that fill to the requested strategy. Position histories, duplicate
claims and cost calibration still use their original broker symbol and
account. A DEMO command can supply measured costs while its originating
bot decision remains unknown.
