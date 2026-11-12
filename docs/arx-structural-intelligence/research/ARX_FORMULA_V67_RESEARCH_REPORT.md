# ARX Formula V6.7 — Pre-Break Structural Forecasting (Local Synthetic Research)

**Mode:** offline only | **Broker data:** none | **GitHub:** no changes to V6.7 | **Trade permissions:** disabled

**Frozen test plan SHA256:** `87ae075b0fa2269fe9dc62ed1206c72941d41c41e918378d98c4107f528eab61`

## Research objective
Do not confuse recognition of an existing first-close breakout with genuine forecasting. Issue a forecast only when **no first-close BOS/CHoCH precursor** is observable in the 120 completed historical candles. Predict the **first confirmed directional structural event within the next 5 minutes**. Confirmation requires two closed bars, so a correct forecast from an eligible snapshot is necessarily issued before the initial breakout bar.

The model is a regularized, past-only multinomial classifier on pre-break pressure and swing geometry. A conservative acceptance gate compares it to a recomputed V6.6 baseline. A joint-probability reallocator modifies only the first 5 minutes while leaving the 60-minute four-subtype BOS/CHoCH marginals unchanged. Out-of-distribution historical-feature screening and a previous-outcome-only short-horizon brake can suppress it. Failing the gate means fallback to V6.6.

## Fresh synthetic retest
- 1400 independent artificial episodes; 1322 issued with no first-close precursor visible.
- For each world: 850 train, 200 model selection, 200 acceptance-gate, 350 untouched final episodes.
- Four generator families already explored in previous versions, but new random seeds. **Not independent real-world validation.**
- Performance target: 3-class first confirmed structural event direction (UP / DOWN / NOT CONFIRMED) by minute +5.

| Artificial environment | V6.6 5m Brier | V6.7 5m Brier | V6.7 approved? | Eligible snapshots |
|---|---:|---:|:---:|---:|
| null_random_walk | 0.408787 | 0.408787 | No | 329 |
| persistent_regime_shocks | 0.372182 | 0.372182 | No | 331 |
| weak_fast_switch | 0.433162 | 0.419446 | Yes | 328 |
| train_test_regime_break | 0.418940 | 0.418940 | No | 334 |

**Pooled five-minute Brier:** 0.408268 → 0.404839; 0.84% relative reduction.
**Paired mean Brier gain:** +0.003429; naive episode bootstrap 95% interval [+0.000970, +0.006132].
**Important:** Small pooled changes can be statistically uncertain; episode bootstrap ignores uncertainty from reuse of generator families and model selection. The third outcome means neither confirmed BOS/CHoCH by H, not guaranteed flat price.

## Before-first-break early-warning honesty
The new predictor passed its held-out acceptance gate in exactly one world, `weak_fast_switch`. In this synthetic test:
- 24 gated warnings were issued. 10 identified the correct first confirmed structural-event direction, with 12 reaching no confirmed structural event by five minutes.
- Directionally correct warning precision: 41.7%. Median time from warning to confirmation: 3.5 minutes; initial first-close breakout is one minute before confirmation, so median lead before **that first break** was about 2.5 minutes.
- False alerts and low recall remain substantial. The conservative gate emitted **zero pre-break warnings in the other three worlds**: a deliberate abstention, not evidence that those markets are predictable.
- Predicting a mechanically required *second* close from an observed *first* close can inflate apparent skill; this experiment explicitly excludes such predictions from pre-break scoring.

## 60-minute integrity and scenario paths
- Three 60-minute scenarios remain mutually exclusive under the operational event definition: bullish confirmed first, bearish confirmed first, neither confirmed by +60.
- Each forecast preserves the earlier 60-minute fine-grained event probabilities exactly to numerical tolerance; this is a mathematical non-regression, not a directional forecasting improvement.
- Ghost OHLC candles come from verified TRAINING-ONLY paths revalidated against the test snapshot; they are realistic illustrative paths, not a calibrated future candle prediction. The 10–90% price fan is an empirical training-return diagnostic.

## Exploratory training-only terminal price-range coverage
| Artificial world | Coverage of nominal 80% range at 5m | at 15m | at 60m |
|---|---:|---:|---:|
| null_random_walk | 79.4% | 81.1% | 76.0% |
| persistent_regime_shocks | 79.7% | 81.1% | 79.7% |
| weak_fast_switch | 77.7% | 81.4% | 81.7% |
| train_test_regime_break | 68.0% | 68.0% | 70.9% |

These ranges are not structural ghost-path credible intervals; coverage is a separate post-hoc diagnostic of marginal terminal returns. No guarantee transfers to V75 or any other broker market.

## Approval decision
**No GitHub promotion, no LIVE trading integration.** V6.7 provides a research-specific pre-break forecasting head and a gate that rejects it where its incremental evidence is weak. Only one controlled artificial world yielded a modest measurable improvement. On an abrupt unannounced reversal, no past-only model can know a future switch with no precursor in the input.

Before approving the formula: obtain timestamped genuine Deriv/MT5 ticks, confirm BOS/CHoCH event labels in real feed replay, assess actual first-break precision and missed opportunities across 1/3/5/15/60-minute horizons, calibrate conditional ghost paths, assess slippage and stop-loss/cost utility, and conduct untouched real-data walk-forward evaluation. No trade edge has been established.