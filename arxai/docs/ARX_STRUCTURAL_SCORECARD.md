# ARX structural scorecard

Overall predictive grade: **NOT YET VALIDATED**. No A–F threshold has been
validated and no return, profit or execution-quality claim is made.

The M1 native-chart panel supports forecast issuance, saved-forecast refresh and
review, six horizons, and separate all/prebreak/post-precursor evaluation cohorts.
Every forecast is saved before the API reports success. Ghost path probabilities
are labeled at 60m separately from the selected shorter-horizon probabilities.

| Metric | Definition / current availability |
|---|---|
| Multiclass Brier | Sum of squared errors for UP_FIRST, DOWN_FIRST, NEITHER; lower is better, range 0–2. Panel and replay. |
| Frequency baseline Brier | Same realized outcome against stored training risk-set PMF. Panel and replay. |
| Log loss | Negative log probability of the realized class, with numerical floor. Panel and replay. |
| Direction precision | Correct up/down argmax decisions divided by up/down argmax decisions; no calls means unavailable. Panel and replay. |
| Direction recall | Correct directional decisions divided by realized directional events. Panel and replay. |
| Probability reliability | Ten bins of maximum class probability, with observed winning-class accuracy and sample counts. Replay JSON. |
| Lead and false calls | Median first-break/confirmation lead among correct directional argmax calls; false-direction fraction includes opposite and neither outcomes. Descriptive CLI diagnostics, not a validated selective-warning policy. |
| Uncertainty | Deterministic four-episode moving-block bootstrap lower mean Brier gain. Limited short-sample screen; cross-market and model-selection uncertainty not fully represented. |
| Ghost availability | Count of replay-verified training exemplars by scenario. Replay JSON. Missing path is disabled in UI. |
| Calibrated price-path coverage | Unavailable. Ghost candles have no calibrated confidence-interval claim. |
| Feed freshness | Existing chart truth plus final M1 tip <60 seconds old and source agreement; gaps reject current features. |
| Regime robustness, drift, latency distributions | Not established by one short capture and one prospective cycle. |

The repository reads the newest 250 saved forecasts for a user/symbol; scores in
the panel describe this recent view, not lifetime performance. The replay has 75
held-out forecasts per symbol. At 5m there were zero prebreak directional argmax
calls in this sample; precision and warning lead are unavailable, not 100%.
The accepted V75(1s) geometry candidate performed worse than frequency on the
final holdout. See the validation report for exact numbers and limitations.
