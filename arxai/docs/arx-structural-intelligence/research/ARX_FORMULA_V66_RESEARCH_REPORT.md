# ARX Predictive Intelligence — V6.6 Early Structural-Event Forecasting

**Mode:** offline synthetic research. **Date:** 2026-11-12. **Deployment:** none. **GitHub:** no V6.6 changes. **Trading:** no signals authorized and no broker communication.

## Decision

**Qualified improvement in short-horizon prediction of the CONFIRMATION of an already-developing, operationally defined BOS/CHoCH.** V6.6 improved 5-minute three-class Brier error versus a reproducible V6.5-style fallback in three of four artificial market environments, but worsened slightly in the abrupt-reversal environment. The one-hour event-direction probabilities were **held exactly constant by mathematical construction**, not improved by prediction. This is not evidence of live-market edge or profitable trading.

## Research question and correct target

The previous versions estimated *whether a named structural event would occur at any time within 60 minutes* but predicted its timing imprecisely. V6.6 asks a narrower, falsifiable question: **Given 120 complete M1 OHLC bars and a first-break precursor known by time t, will the FIRST significant confirmed BOS/CHoCH arrive in the next 1, 3, or 5 closed M1 bars?** Target events are the existing V6.4 two-close BOS/CHoCH definitions; no event within the horizon is the third **first-event classification** outcome. The 'no event' case must NOT be equated with a guaranteed sideways price range.

**Causal improvement:** A first closed candle that crosses a previously confirmed swing level by at least 0.35 previous-bar ATR is recognized as an unconfirmed pattern precursor. Actual structural confirmation requires a SECOND closed candle beyond the frozen pivot by at least 0.15 ATR; its future observation is never used in prediction features. The 28-feature precursor fingerprint also includes historic gap/retest/sweep proximity, wick geometry, compression and recent confirmed events. All features are constructed from bars closed at or before the forecast timestamp. The causal event-label software is inherited and regression tested from V6.4–V6.5.

### Mathematical correction for the ghost engine

The earlier V6.6 pilot increased early-warning skill but sometimes degraded one-hour forecasts. The new **terminal-marginal-preserving conditional event-time redistribution** fixes that: for each event cause k, the V6.5-style forecast's total 60m event probability M_k is unchanged, while up to five minutes of event-time mass is reshaped toward the separately estimated precursor distribution. Remaining event-time mass is proportionally redistributed over minutes 6–60. The full joint cause-by-minute distribution remains nonnegative and sums to one, with monotone cumulative event probabilities across forecast horizons.

For first five minutes:

`r[t,k] = (1-w) * p_baseline[t,k] + w * p_precursor[t,k]`

If `sum_t<=5 r[t,k] > M_k`, reduce that early mass proportionally to `M_k`. Redistribute `M_k - sum_t<=5 r[t,k]` across the *baseline* later-time shape for that cause. The no-confirmation-at-60m probability is unchanged. `w` is selected on independent synthetic validation and gate-checked. This is **timing-aware probability reallocation**, not a new 60m directional edge.

## Controlled experiment

- Artificial generators: (1) random returns, (2) persistent regime with jumps, (3) rapidly switching weak trends, and (4) a deliberately unannounced testing-period trend reversal.
- Per environment: 850 independent training episodes, 200 model-selection episodes, 200 separate acceptance-gate episodes, then **350 new holdout episodes**. Total final holdout = **1,400 synthetic episodes**.
- Each episode: 120 past M1 bars and 60 reserved future M1 bars; the no-future-input property is checked by replacing future returns and asserting identical forecast inputs.
- Models: V6.5-style frequency/geometry/advanced arbitration with frozen regression safeguard, versus a separate precursor-aware 5-class discrete-time cause-specific hazard, with short-term conditional event-time reallocation.
- Primary metric: multiclass Brier at 5 minutes (lower is better). Secondary: 1m, 3m, 15m, 30m, 60m Brier; event-time MAE conditioned on the later realized event type (diagnostic only); fixed-selection-percentile warning precision and false alerts.
- Model selection and gating use only training/selection/acceptance episodes. Outcomes from final holdout are exposed after issued probability arrays are saved. Single example ghost paths are taken from TRAINING episodes and checked against that example's known historical structure before charting.
- Frozen plan SHA256: `6ae691f74a8e5e6f5e7cf991bc36695698acf3e09e37fdfedbd1cac6aa94d20a`.
- **Important:** The V6.6 pilot showed long-horizon degradation and the first retest exposed a floating-point tolerance bug in the safeguard. Those observations informed the terminal-marginal-preserving fix and numeric tolerance before this frozen final-seed retest. Thus this is a new synthetic retest, but after extensive exploratory iterations on the SAME generator families; independent real-market evaluation is still necessary.

## Frozen final results (350 episodes per world)

| Artificial environment | V6.5-style 5m Brier | V6.6 5m Brier | Relative Brier improvement | Baseline 60m Brier | V6.6 60m Brier |
| --- | ---: | ---: | ---: | ---: | ---: |
| Null random walk | 0.413392 | **0.389572** | +5.76% | 0.527112 | 0.527112 |
| Persistent trends + shocks | 0.386293 | **0.336665** | +12.85% | 0.513914 | 0.513914 |
| Fast regime switching | 0.449107 | **0.416000** | +7.37% | 0.516455 | 0.516455 |
| Unannounced reversal | **0.443480** | 0.443905 | −0.10% | 0.522010 | 0.522010 |

Equally weighting the four synthetic generators, average 5m Brier fell from **0.423068** to **0.396536**, a **6.27% relative reduction**. The pooled paired mean difference is **+0.02653 Brier** with simple episode-resampling 95% interval **[+0.02118,+0.03226]**. The interval assumes independent synthetic episodes, ignores dependency among generator families, and is not a confidence interval about any live financial market.

At 60m, the mean Brier remains **0.519873 for both** by construction. This is a no-regression invariant, **NOT** proof of improved one-hour directional prediction. At short horizons, much of the apparent predictive power comes from knowing that one of the two required confirmation closes is ALREADY observable: this can improve deterministic label completion forecasts even in an artificial random-walk market. It does not establish an exploitable next-price direction advantage.

## Event timing and first-confirmation early warning

| Environment | Baseline conditional timing MAE | V6.6 conditional timing MAE |
| --- | ---: | ---: |
| Null random walk | 9.321 min | 8.571 min |
| Persistent trend | 8.887 min | 8.241 min |
| Fast switching | 8.488 min | 7.657 min |
| Hidden reversal | 8.493 min | 8.493 min |

These MAEs are diagnosed **after observing which event type happened**, so they are not an online entry timestamp prediction. V6.6 has NOT established precision scalping timing.

Across the 1,400 final synthetic episodes, **97** already had a strong final-bar first-close precursor at forecast time; **77** were followed by the corresponding second-close confirmation at minute +1. This is an **observed synthetic 79.4% conditional confirmation frequency** after one close, NOT trade win rate or directional forecasting accuracy. One-minute confirmation is mechanically easier to foresee because the event label itself requires two consecutive closes around a frozen level.

At selection-derived top-10%-confidence thresholds, warning precision and alert rates varied considerably. In the persistent-trend environment, V6.6 emitted **32** 5m warnings (9.1% of the 350 test episodes), **68.75%** of which correctly identified the first event direction, and the verified correct alerts had a **1-minute median** lead before confirmation. In the unannounced-reversal environment it emitted **2** alerts and neither identified the correct direction: confidence selection effectively collapsed out-of-distribution. A constant baseline cannot honestly rank its episodes and emits **zero selective early warnings**, rather than firing on every sample due to tied threshold values.

## Other structural-event families

Five-minute standalone SWEEP, FVG formation and FVG retest probabilities were trained as *independent, non-exclusive* research heads using the same causal feature snapshot. Their out-of-sample results were mixed, including negative skill for FVG formation in several generators. **None were activated** or passed a separate live model-approval program. A first confirmed BOS/CHoCH is distinct from support-family event incidence; do not add those probabilities together as if mutually exclusive.

## Three ghost candles / one-hour visualization

An example forecast using the reserved synthetic persistent-regime test origin produced **48.25% up-first**, **49.84% down-first**, and **1.91% neither confirmed** over 60m, with the real reserved synthetic future having a **down-first confirmed BOS** at future minute **1**. The original forecast was near evenly split and thus should **not** be represented as a strong bearish call.

The visual ghost paths are 60 M1 OHLC candlesticks per scenario drawn from **training-only synthetic episodes**, shifted to the currently known simulated starting price and each rechecked against the frozen past for correct structural-event classification. To improve readability, visual examples are selected by training-only median endpoint within up/down classes and closest-to-flat endpoint among 'no event' candidates. That display selection **is not a calibrated conditional price-path simulator** and must never be scored as a predicted price target or trading signal. The 3rd class is *neither confirmed event*, not equivalent to all sideways paths.

The no-confirmed-event class occurred in only **24 of 1,400** synthetic test episodes, so independent calibration of the third scenario is inadequate.

## Unit and regression testing

**53 automated tests passed; 0 failed** (9 new V6.6 tests plus 44 rerun V6.3–V6.5/reference contract checks). They include future-data mutation invariance, strict closed-history lengths, 3-way probability sum, per-horizon monotonic cumulative incidence, 60m terminal probability invariance, clean legacy structural labels, and honest refusal to produce alerts from an indistinguishable constant score.

This is not a full production execution, risk, broker/feed, or UI integration test. No actual tick-order ambiguity handling, data staleness/freshness, Deriv API, MT5 broker E2E, fill slippage, costs, live performance or operational latency is measured.

## Unresolved defects / next gate

1. **Surprise reversal deterioration remains.** V6.6's 5m Brier slightly worsened on the new unannounced-reversal holdout. The confirmed first-close precursor can still fail, especially after a shock.
2. **Third class rarity:** Only 24/1,400 no-confirmation outcomes; need explicit horizon definitions and scenarios with meaningful no-event frequency rather than falsely implying price stays flat.
3. **No real-market evidence:** Tests are controlled synthetic recognition and label-confirmation tests. The generator's built-in regularities can be learned without revealing any actual broker-market predictability.
4. **Price-path generation is illustrative:** Ghosts are structurally coherent training exemplars, not calibrated future candle distributions; true pathwise scoring has not been achieved.
5. **No economic utility:** There is no demonstrated positive EV after spread, commission, latency, slippage or risk. Zero new live-order authority is justified.
6. **Need real M1 and tick data:** Timestamped Deriv/MT5 history with provider/connection provenance, finalized-bar flags and chronological walk-forward partitions, including real regime shifts and no-event cases, before claiming an edge.

**Research decision:** Retain V6.6 as an early-confirmation research model only. Preserve V6.5 long-horizon probabilities, reject trading authorization, and do not push to GitHub until the owner explicitly approves following real-data validation.