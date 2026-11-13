# Real-market structural validation report

**Verdict: exploratory broker-feed replay; no predictive edge established.**

This report covers newly authored `arx-v6.7-implementation-1`, not the prior
reports' artificial worlds. Public Deriv synthetic-index prices are genuine
broker feed observations of those instruments, not our generated test fixtures.

## Data and protocol

Captured 39,996 completed M1 bars across V75, V75(1s), V50, V50(1s), V25(1s),
from approximately 2026-11-07 06:36 UTC to 2026-11-12 19:56 UTC. Eight pages
of up to 1,000 bars per symbol; request/receive provenance and raw data hashes
were retained. A live public tick was also observed for each symbol. No account
credentials or order calls were used. The public endpoint is documented at
[Deriv public WebSocket](https://developers.deriv.com/docs/options/ws-public/)
and [ticks history](https://developers.deriv.com/comparison/ticks-history/).

Five separate chronological fits; 15m stride; 120 past bars and 60 future bars;
55/15/15/15 split with 60m purge. Each symbol had 269 training, 71 selection,
71 acceptance and 75 holdout episodes after purging. The 498 valid episodes
per symbol exclude 24 windows crossing missing/off-grid timestamps. The input
was not padded or repaired with invented prices. Holdout predictions were
written to JSONL before the evaluator received their future bars. Historical
arrival times are unknown: this is close-based replay, not tick-arrival replay.

The final pass hashes the exact model source files in `validation-plan.json`.
Earlier passes on this same capture found timestamp discontinuities and a
floating-point negative-mass edge case. They drove integrity/numerical repairs,
followed by the causal one-minute-support fix. Therefore this dataset is **not**
an untouched external acceptance set for the implementation as a whole. No
performance threshold was tuned to obtain a passing head. A new independent
capture is needed before any predictive claim.

## Five-minute holdout results

Lower Brier/log loss is better. Each row contains 75 overlapping forecasts.

| Market | Selected Brier | Frequency Brier | Log loss | Prebreak gate |
|---|---:|---:|---:|---|
| V75 | 0.483706 | 0.483706 | 0.839932 | Rejected |
| V75_1S | 0.584530 | 0.435821 | 0.978300 | Rejected |
| V50 | 0.521257 | 0.521257 | 0.890750 | Rejected |
| V50_1S | 0.538515 | 0.538515 | 0.919895 | Rejected |
| V25_1S | 0.463327 | 0.463327 | 0.817829 | Rejected |

All five prebreak heads failed their independent acceptance screen. Geometry
passed for V75(1s) only, but subsequently worsened 5m holdout Brier from
0.435821 to 0.584530, and 60m from 0.477854 to 0.487248. The negative holdout
result is retained; it was not used to retune the gates. Other markets used
frequency fallback. There is no established V6.7 early-warning improvement.

Full six-horizon Brier, log loss, reliability bins, class counts, eligibility
cohorts, lead diagnostics, block-bootstrap lower gains and all gate decisions
are in `structural-evidence/pr150/historical-summary.json`. At 5m, all markets
had zero prebreak directional argmax calls; direction precision and lead times
are undefined. An argmax call is not a calibrated warning policy.

## Ghost paths and coverage

All 375 forecasts had a replay-verified bullish and bearish training exemplar.
Only 33 V75 forecasts had a matching neither-confirmed 60m training exemplar;
none of the other markets did. Missing paths are marked unavailable. These are
conditional illustrations, not prediction intervals, and no price coverage
or path accuracy grade is asserted.

## Prospective real-feed observation

One V75 forecast was computed and durably saved by the actual service, worker
and PostgreSQL repository before the next candle closed. The subsequent closed
bar resolved the one-minute NEITHER outcome, and deep equality verified that
the original forecast JSON did not change. The run used a separately named
disposable local database and an injected read-only public feed, not a deployed
authenticated ARX broker session. Evidence: `prospective-outcome.json`.
The final-code observation had zero 1m Brier: with no first-close precursor,
NEITHER at +1 follows mechanically from the two-close event definition. This
is not evidence of predictive edge. An earlier prospective run is also retained
in the evidence archive. Neither issued forecast was rewritten. No order API
was called.

## Reproduction

From `scripts/`, with workspace dependencies installed:

```sh
node --import tsx src/structuralValidation.ts /path/to/new-output --capture
```

To replay, create a new directory containing the five original symbol JSON
files and omit `--capture`. Existing plans/outputs are never overwritten.
Preserve the raw files and source hashes alongside results. The bounded live
check is `structuralLiveCheck.ts`; it refuses any database outside a dedicated
localhost database named `arx_structural_pr150_*`. It must not use production.

Independent longer replay, regime shifts, prospective durability/disconnect
soak, original tick order, calibrated price paths and economic validation remain
open. This report does not authorize model promotion or broker execution.
