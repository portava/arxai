# ARX Predictive Intelligence — Formula V6.5 (RC2) Local Research Report

**Date:** 2026-11-12  **Mode:** offline simulation / research only. **GitHub:** unchanged. **Live trading:** disabled.

## Decision

**CONDITIONAL ROBUSTNESS GAIN, NOT A GENERAL FORECAST BREAKTHROUGH.** V6.5 reduced Brier loss during an artificially imposed, unseen reversal relative to the older V6.4 rule. The improvement did **not** beat the simple training-frequency baseline and does **not** improve actual event-time prediction. Keep local, reject for live use. Performance depends on the artificial data generator.

## What was fixed, and how it works

1. **Baseline arbitration across three structural forecasts:** on independent selection/validation partitions, require the geometry-only or advanced model to demonstrate positive multiclass Brier skill versus the training-frequency baseline. Otherwise use the baseline. This addresses the V6.4 weakness that geometry could be worse than simple frequencies.
2. **Regime-shift damage brake:** after each **completed prior forecast**, compare the selected model's average 5/15/30/60-minute Brier loss against the independent frequency baseline. Trigger quarantine when cumulative excess exceeds 2.2 after 0.03 tolerance per observation *and* at least eight recent completed episodes show persistent harm (mean relative loss >.10 and ≥65% worse by >.05, with at least six harmful episodes). There is no automatic re-enablement. Until then, the selected forecast is conservatively mixed with 3% baseline mass.
3. **Explicit conditional timing model:** estimate a five-bin event-time distribution given each hypothetical BOS/CHoCH type. Mix it into the joint forecast while preserving the entire 60m event-type marginal. Require separate conditional time-log-loss validation *and* a 15-minute Brier safety check before activation. In these final tests, the timing head failed activation when the advanced model was selected. It passed its experimental gate in random/weak worlds, but their *core* model was the baseline and the brake path intentionally retained the unmodified baseline—so those timing heads had **zero effect on the final forecast**. This is a design limitation to resolve in the next version.
4. **Causal event definitions unchanged:** named BOS/CHoCH requires a swing break with two consecutive closed-candle confirmations and specified displacement; sweeps and FVG events are recognized as supporting features only. The events are **not** broker-validated price-action truths and are not proven actionable patterns.
5. **Probabilities remain a single joint event/time distribution:** always three coherent scenario masses: confirmed up-first, confirmed down-first, or neither confirmed within the horizon. The third class is **not** necessarily a sideways range.

## Frozen final test procedure

- Four independent artificial market generators: random walk, persistent trend with rare shocks, weak switching trends, and an explicitly hidden test-period reversal.
- Per environment: 850 training episodes, 200 model-selection, 200 separate gate, and **350 untouched final test episodes**. Each episode is 120 prior closed M1 bars plus 60 future bars. New final seeds were not used during guard development. Pilot RC1 falsely quarantined an otherwise useful model; RC2 increased required evidence and was assessed on separate *pilot* seeds before the final test plan was frozen (hash in `PRE_REGISTERED_PLAN.json`).
- Forecasts are frozen before outcome labels are exposed. Online quarantine sees only already completed earlier test episodes. We treat synthetic episodes as **independent, sequential non-overlapping units**. They are **not** actual chronological broker timestamps.
- Multiclass Brier at 60 minutes is primary; lower is better. Directional accuracy is *first confirmed structural event classification*, not win rate. Conditioned event-time MAE is retrospective diagnosis, not executable entry timing. Paired uncertainty intervals are simple episode-resampling bootstrap intervals and should **not** be mistaken for real-market confidence bounds.

## Final independent results — 350 episodes per world

| Artificial environment | Training frequency Brier | V6.4 comparator Brier | V6.5 Brier | V6.5 60m event-class accuracy | 95% interval for V6.4 minus V6.5 Brier |
|---|---:|---:|---:|---:|---:|
| Random walk | 0.51222 | 0.51431 | **0.51222** | 52.3% | [-0.0103, +0.0142] |
| Persistent trends + shocks | 0.50970 | 0.40197 | **0.40283** | 72.9% | [-0.0018, +0.0002] |
| Weak rapidly switching | 0.50898 | 0.49749 | **0.50898** | 48.9% | [-0.0232, +0.0016] |
| Hidden regime reversal | 0.50529 | 0.58843 | **0.52034** | 41.4% | [+0.0319, +0.1024] |

A positive difference means V6.5 reduced loss. These are paired comparisons on identical synthetic forecast episodes. The overall unweighted mean of the four 60m Brier losses is **0.50055 for V6.4 versus 0.48609 for V6.5**. This average includes the very large designed reversal advantage and does not demonstrate real-world transferability.

### Hidden-reversal detail

- Training frequency **0.50529**; V6.4 **0.58843**; V6.5 **0.52034**. Reduction relative to V6.4: **11.57%**.
- Quarantine took effect from test forecast **index 23** (zero-based, after earlier completed episodes): 23 initially active, then 327 prior-only forecasts. It cannot anticipate the unknown break before outcomes accrue.
- Although V6.5 recovered most of V6.4's excess loss, it remained worse than the simple frequency baseline by **0.01505 Brier**. Paired bootstrap 95% interval for frequency-minus-V6.5: **[-0.02882,-0.00329]**. The gap is real in this controlled synthetic sample.

### Persistent-trend detail

- V6.4 Brier **0.40197** versus V6.5 **0.40283**; direction accuracy for both **72.86%** on this artificial environment. The 3% baseline regularization slightly hurt Brier; no quarantine fired. The comparison interval includes zero.

### Weak-trend limitation

- V6.5 fell back to training-frequency Brier **0.50898** whereas V6.4 geometry produced **0.49749** in the fresh holdout. This is a validation-selection miss, not an improvement. We must improve selection without tuning against this holdout.

## Event-time precision

| Environment | V6.4 conditional mean event-time absolute error | V6.5 |
|---|---:|---:|
| Random walk | 9.10 min | 9.04 min |
| Persistent trends | 8.32 min | 8.32 min |
| Weak fast-switch | 9.04 min | 9.20 min |
| Hidden reversal | 8.73 min | 8.72 min |

**No meaningful time-forecasting gain.** The small differences are below a useful scalping timing improvement. Conditioning on realized event type is not a prospective entry timing claim.

## Three-scenario visual check

The example source is one frozen held-out synthetic episode from the persistent-trend world. Forecast probabilities are **up first 37.80%; down first 60.45%; neither 1.75%**; the reserved actual was down-first. The line plot overlays *past-only block-resampled representative OHLC paths*, each subsequently verified against the event observer as belonging to its labeled class. It does not show a calibrated conditional generative model. Ghost paths are physically valid OHLC sequences, not precise predicted candles. `ghost_candles_180.csv` contains all 180 projected M1 exemplar candles (60 per scenario).

Only **12 of the 1,400 final episodes** resulted in neither confirmed directional structure by 60m. That makes the third class rare and under-tested, a serious limitation for the required three-trajectory experience. Accuracy or calibration for this third class has **not** been established.

## Automated tests and limitations

**70 regression tests passed, none failed**, including nine new V6.5 properties: event-time mass preservation, horizon coherence, invalid input refusal, no current/future-outcome leakage in the brake, monotonic quarantine and research-only status. This does not establish predictive validity.

**Not tested:** actual Deriv or MT5 history, real-time recognition latency, causal tick-order event disambiguation, actual structural-event timing usefulness, forecast interval calibration on broker prices, slippage/spread, trade execution, real expected value, durable OOD detection before observations, and current chart integration.

## Decision and next research gate

**Keep as a local research candidate only.** The robust fallback meaningfully reduces simulated reversal damage but remains worse than no-signal frequency predictions in that world. The short-term time head still lacks independently validated gains. The next tests should use properly timestamped broker/tick history, more realistic low-event-frequency samples, explicit ongoing drift evidence, and a pre-registered separate holdout. No code or prediction may bypass ARX's safety and order execution boundaries.

**No GitHub writes, Supabase modifications, broker connections, trading account changes or live/demo orders were performed.**