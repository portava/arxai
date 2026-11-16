# ARX AI — V6.4 Genuine Structural-Event Forecasting: Research-Only Retest

**Run:** 12 November 2026. **Status:** LOCAL RESEARCH / NO GITHUB PUSH / LIVE DISABLED.

## Executive result

V6.4 changes the forecast target from an arbitrary price barrier to **actual, causally labeled, named structural events**: significant two-close-confirmed BOS/CHoCH, wick sweeps, three-bar FVG formation, and FVG retest-and-close. It predicts (a) the **first up-confirmed BOS/CHoCH**, (b) the **first down-confirmed BOS/CHoCH**, or (c) **neither within the horizon**; it separately estimates the incidence of supporting events. The third outcome is **not automatically a ranging market**. The model emits a single consistent event-type-and-minute probability distribution.

**Primary finding:** Relative to a geometry-only hazard comparator, V6.4 improved 60-minute Brier loss in an artificial persistent-trend environment, but **worsened sharply under an unannounced directional regime reversal**. It did **not** improve conditional event-timing error in the retained strong-trend environment. No real-market predictive edge is established.

## What counts as genuine structural recognition here

Operational definitions are pre-specified in `arx_v64_label_rules.py`:

1. **BOS/CHoCH:** A V6.3 causally confirmed swing break, first close ≥0.35 preceding ATR beyond the pivot and *second consecutive closed candle* holding ≥0.15 ATR beyond it. The event is recognized at the **second candle close**, never backdated.
2. **Wick liquidity sweep:** A wick crosses a confirmed pivot by ≥0.20 ATR, with candle close back inside ≥0.05 ATR.
3. **Three-bar FVG formation:** Fully completed third candle leaves a wick gap ≥0.50 of the immediately preceding 20-candle mean range (experimental ATR proxy).
4. **FVG retest-and-close:** Later completed candle touches a previously valid gap and closes above/below its midpoint as defined by the gap direction. This is a measured interaction, **not proof of a successful trade**.

Timestamps now represent **the closing instant** of the recognized M1 candle (source candle timestamps represent opens). The previous V6.3 event observer provided raw detections; V6.4 uses deterministic significance and confirmation rules. These are explicitly experimental definitions, not universally accepted trading standards.

## Mathematical model

At minute j after the request, fit multinomial conditional hazards over 5 outcomes:

    q(j) = softmax(W * causal_features(X_t, j) + b)

    categories = BOS_UP, CHOCH_UP, BOS_DOWN, CHOCH_DOWN, SURVIVE
    S(0) = 1
    P(event_type=k exactly at minute j | X_t) = S(j-1) * q_k(j)
    S(j) = S(j-1) * q_SURVIVE(j)

Forecast probabilities for **Up**, **Down**, **No named directional event** at any horizon h are the appropriately summed event-type-and-minute probabilities plus survival S(h). They sum to 100% by construction; horizons 1/3/5/15/30/60 use the **same joint distribution**, not disconnected classifiers. Model significance is evaluated with independent validation and an offline-only trained frequency and geometry comparator.

## Controlled experiment and reporting integrity

- **Source:** Fully artificial returns and OHLC with 10-second future substep extrema, closed M1 candles, and externally generated historical wick noise. Four separate stochastic market generators: zero-drift random walk, persistent trends with shocks, weak/rapidly switching trends, and an abrupt unannounced test-period reversal.
- **Per world, per cohort:** 850 train episodes, 200 model selection, 200 validation gate, **350 unseen test episodes** (each has 120 historical M1 bars followed by a reserved 60-minute future). Episodes are independent synthetic units, **not broker samples**.
- **Total:** 1,400 tests in the development pilot cohort and **1,400 fresh fixed-seed tests** in a separately frozen audit cohort (2,800 test episodes total); 350 fresh tests per world.
- **Selection:** choose predefined blend weight among {0, .25, .5, .75, 1} on selection partition; require paired validation bootstrap lower gain >0.005 at alpha .0125 to activate advanced features. V6.3's pre-existing eight-completed-forecast demotion monitor is also tested. Only previous completed episodes inform the current demotion decision.
- **Leakage controls:** no features from future OHLC, pivot confirmations published at confirmation, forecasts frozen before reserved outcomes, no intrabar ordering inferred from OHLC.
- **Important:** the early pilot and prior V6 versions were examined during development, so only the explicitly frozen fresh-seed cohort serves as this round's incremental audit. All cohorts use the same artificial generator families, not independently sourced real markets.

## Fresh audit results — first genuine up/down structural event within 60m

Lower Brier is better; accuracy is a **three-outcome structural classification**, not a trade win rate.

| Artificial environment | Train-frequency Brier | Geometry Brier | V6.4 selected Brier | V6.4 accuracy | Conditional timing MAE* | Advanced validated? |
|---|---:|---:|---:|---:|---:|---|
| null random walk | 0.51185 | 0.51858 | 0.51858 | 48.9% | 8.66 min | No |
| persistent regime shocks | 0.51585 | 0.48321 | 0.45126 | 68.6% | 9.22 min | Yes |
| weak fast switch | 0.52296 | 0.52110 | 0.52110 | 52.0% | 8.71 min | No |
| train test regime break | 0.51659 | 0.65650 | 0.69218 | 34.6% | 9.06 min | Yes |

\* Conditional event-time MAE evaluates the median timing *conditioned on the realized event type*; this is a retrospective diagnostic, not the latency of tradable entry signals. The timing MAE does **not** directly compare with V6.3's old fixed-barrier timing task.

### Key paired comparisons on the fresh synthetic holdout

- Persistent trend: geometry Brier **0.48321** vs V6.4 **0.45126** at 60m, absolute reduction **0.03195** (about **6.6%**). Per-episode bootstrap 95% interval for geometry-minus-V6.4 Brier improvement: **[0.0057, 0.0572]**. Trend model accuracy at 60m: **68.57%** vs geometry **62.00%**.
- Shorter horizons: in the persistent-trend audit, 15m Brier was **0.64162** (geometry) vs **0.64168** (V6.4), i.e. **not improved**. Five-minute improvement was only **0.00489**.
- Random walk: V6.4 selected only the geometry baseline; its 60m Brier **0.51858**, which was slightly worse than the unconditional event-frequency baseline **0.51185**. This is a warning against interpreting better-looking structure forecasts as a trading edge.
- Weak trend: advanced features were rejected; 60m Brier remained **0.52110**.
- Abrupt reversal: geometry Brier **0.65650**, selected V6.4 **0.69218**, train-frequency Brier **0.51659**. V6.4 was **worse than both**. The transferred guard did not demote the model until **after 156 independent completed test episodes**. Paired 95% bootstrap improvement interval: **[-0.0492, -0.0223]**, entirely negative. This is a **failed robustness test**.

Conditional event-time MAE in the persistent-trend audit **worsened** from 9.05m (geometry) to 9.22m (V6.4), so the core early-timing target is not met.

### FVG, sweep, and other supporting event heads

At 15m in the fresh persistent-trend environment: CHOCH Brier skill was **+1.74%** over a frequency-only prior; BOS **-0.85%**, sweeps **-5.03%**, FVG formations **-3.02%**, and FVG retests **+0.77%**. These small/negative gains **do not qualify as independently validated supporting predictors** and should not be exposed as trustworthy signals.

## Ghost-trajectory demonstration (not claimed as exact candles)

A fixed, non-cherry-picked held-out synthetic example produced:

- Up confirmed first: **42.63%**
- Down confirmed first: **56.64%**
- Neither by 60m: **0.73%**

**The actual reserved future was the third class: no two-close-confirmed directional break within 60m.** The most probable predicted class was **wrong in this example**. The 60 M1 ghost candles for each path are selected as *structurally verified scenarios* from past-only block-resampled OHLC, and they are **not** individually calibrated candle predictions. Candidate paths checked: 977. Candidate scenario distribution: UP_CONFIRMED_FIRST: 260, DOWN_CONFIRMED_FIRST: 701, NO_DIRECTIONAL_BREAK: 16. Those bootstrap frequencies are **not** model probabilities.

Each sample path was explicitly replayed through the V6.4 event observer to verify its class. A missing path would be reported as unavailable rather than invented.

## Software checks

**61 regression tests passed**, including 12 new local V6.4 tests and 49 prior V6/V6.3 checks. Tests cover five-class hazard conservation; short-horizon mass consistency; two-close confirmation without backdating; M1 closing-time timestamps; valid FVG/retest observations; causal prefix equality; rejection of gaps/forming candles; future mutation cannot affect historical features; and a demotion monitor that cannot consume the current forecast's outcome.

Passing those tests **does not prove** real-market predictability, calibration, fill quality, positive expectancy, or safe LIVE trading.

## Final verdict: NOT PRODUCTION-READY

V6.4 moves the project from **proxy barrier outcomes** to measurable BOS/CHoCH and supporting structural-event forecasts. That is a substantive *target-definition and mathematical* upgrade. It is **not** a robust overall forecasting upgrade: short-term event timing remains weak, ancillary heads lack reliable skill, and sudden regime reversal made the advanced forecasts worse than the simplest train-frequency prior despite the monitor.

**Before GitHub / LIVE:** (a) obtain correctly timestamped real Deriv/MT5 tick+closed-bar history; (b) freeze broker/symbol-specific event definitions and follow event prevalence/false-alarm rates; (c) apply regime-shift detection and OOD abstention with controlled false-positive rates; (d) compare advanced vs geometry vs frequency-only on chronological purged real holdouts; (e) calibrate event-time probabilities and test entry decision EV after realistic spreads/slippage; and (f) measure actual inference-to-order latency while preserving the existing 18 execution gates. Do not connect this research system to trade authorization.

**No network requests, GitHub writes, live feed connections, MT5 execution, DEMO trades, or real-capital transactions were performed.**