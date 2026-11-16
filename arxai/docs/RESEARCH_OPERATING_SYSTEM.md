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
