# Formula V6.7 implementation map

Identity: `arx-v6.7-implementation-1`. This is newly authored TypeScript inside
ARX, based on the documented mathematical contracts. The owner explicitly
confirmed there is no original runnable research code. The prior research reports
are retained unchanged and their synthetic-world statistics are not attributed
to this implementation. No learned coefficients are copied from prose or invented.

| Research contract | Implementation |
|---|---|
| V6.4 causal structure and five competing hazards | `observer.ts`, `model.ts`: BOS_UP, CHOCH_UP, BOS_DOWN, CHOCH_DOWN, no event, conditioned on survival. |
| V6.5 coherent event-time distribution | `math.ts`: survival times hazard produces a 60 × 4 first-event PMF; neither is remaining survival. |
| V6.6 early confirmation adjustment | Full-feature hazard head, independent acceptance, first-five-minute subtype reallocation. |
| V6.7 before-first-break head | Eligible-only regularized three-class softmax; no visible current precursor; independently selected and gated against the implemented preceding layers. |
| V6.7 terminal preservation | Early changes preserve each of the four 60m subtype marginals; zero late support uses the original subtype instead of dividing by zero. |
| OOD and prior-outcome brake | Training-standardized feature screen; 30 completed prior 5m scores; excess Brier > 0.03 latches quarantine across refits of the same policy/provider. |
| Training-only ghost paths | Reprice historical training OHLC, replay against current history, classify first event, choose median terminal exemplar by class. No post-training exemplar. |

## Explicit new choices

The reports omit exact features, fitted weights and several thresholds. These are
implementation decisions, not claims of recovered research settings:

- 120 closed M1 candles; pivots require two left and two right bars. Ties choose
  the last matching pivot. The pivot becomes knowable at the second right close.
- Prior 20-bar mean true range. First close is at least 0.35 ATR beyond a known
  pivot; the immediately following close must retain at least 0.15 of that same
  frozen ATR beyond that same pivot. The second close publishes the event.
  CHoCH reverses the last confirmed direction; BOS continues/establishes it.
- Sweep: wick exceeds a known level by 0.20 ATR and close returns by 0.05 ATR.
  FVG: three-candle gap at least half the preceding 20-bar mean range. Retest:
  later overlap with a close on the directionally favorable side of its midpoint.
  These are formation/retest diagnostics, not a full active-zone lifecycle.
- 18 named features in `FEATURE_NAMES`: level distances, three momentum scales,
  compression, body/wicks, pressure, trend, sweep/FVG/retest, precursor and ages.
  Train and infer call the same point-in-time function. Higher-timeframe features
  have not been inserted without a separate model-version evaluation.
- Geometry hazard uses five geometry features plus time and time squared; full
  confirmation hazard uses all 18 plus time. The prebreak classifier uses all 18.
  Standardization and ridge multinomial parameters are fitted only on training.
- `MODEL_POLICY` freezes deterministic 120-step full-batch fitting, ridge 0.01,
  step 0.08, stride 15m, chronological 55/15/15/15 partitions, 60m purge, at least
  80 training episodes and 30 acceptance examples. Geometry selection targets
  60m Brier; the confirmation and prebreak heads target 5m Brier.
- Empirical baseline uses training risk-set frequencies with 0.5 pseudocounts
  for each hazard class. Selection chooses from 0/0.25/0.5/0.75/1. Every blend
  is frozen before acceptance labels are consulted. Acceptance requires a
  deterministic 400-replicate moving-block bootstrap lower gain above 0.005.
  This is an exploratory evidence screen, not a production promotion decision.
- Prebreak direction scores map to the preceding model's within-five-minute
  time shape and subtype proportions; missing support remains unavailable.
- A snapshot with no first-close precursor cannot confirm at +1 minute.
  Any model mass at +1 is moved to +2, preserving all subtype totals and all
  displayed 3/5/15/30/60m probabilities. Baselines receive the same constraint.
- Out-of-distribution means any standardized feature exceeds absolute z=6.
  The empirical baseline is used when no candidate passes, OOD triggers, or
  the brake latches. Invalid/stale inputs and insufficient training abstain.

`BASELINE` means the implemented gated predecessor chain (possibly including an
accepted geometry/confirmation adjustment), not necessarily a constant empirical
forecast. `baselineMass` always records the empirical comparator. The UI exposes
the gate reason; the full manifest preserves every head's decision and weights.

The model input/content hash, source hashes in the validation plan, feature/event
versions, trained-through cutoff and available-at cutoff make decisions auditable.
The current implementation does not reproduce unavailable V6.6 coefficients,
original price fans, warning thresholds or the older report's performance.
