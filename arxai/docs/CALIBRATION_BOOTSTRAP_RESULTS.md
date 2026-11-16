# Calibration bootstrap: forward validation results

Regenerated 2026-11-12 with `isotonic_pav_beta_shrinkage_forward_v2` against the committed, hash-verified real-history fixtures. This supersedes the 2026-11-10 blocked K-fold report.

Reproduce without a database (from `artifacts/api-server`):

```sh
node --import tsx src/scripts/calibrationBootstrap.ts --report --json
```

## Validation and interpretation

- Sort by prediction availability time. Replay OHLC observations are available at the next bar boundary, not the current bar open. The terminal bar uses the preceding interval. Live samples use their recorded creation and resolution/review timestamps.
- Reserve the final 20% of observations for evaluation. Remove development labels that had not resolved strictly before that boundary.
- Select the candidate on the earlier data using expanding training windows. Every fold trains only on earlier outcomes resolved strictly before its validation boundary.
- Freeze the selected candidate and evaluate it on the final period. Both selection and the final check must pass before serving score-dependent probabilities or granting agent influence. Require at least 100 scored observations for selection and 100 in the final check.
- Check improvement using both observation-level and chronological-block lower bounds. The block calculation is conservative, but does not establish independence across markets, overlapping outcomes or regimes.
- A record without valid prediction/resolution timing may support only a descriptive base rate. It cannot establish an edge, out-of-sample Brier/reliability, or agent authority.
- `cv` reports selection metrics; `holdout` reports the preselected candidate and its final-period metrics, including sample sizes and cutoff. Top-level Brier/reliability describe the served choice on that same final period, using a frozen pre-holdout fit. Since the final check can veto promotion, use `holdout.brierSelected` when assessing the preselected candidate, not the better-looking post-veto metric. The eventual serving fit is refitted on all resolved samples.
- This is retrospective temporal validation on previously inspected fixtures, not a fresh prospective trading trial. Pooling markets and timeframes changes sample composition over time. No guarantee of profitability, false-positive rate, or future performance follows.

## Strategies (pooled keys)

| Strategy | N | Base rate | Holdout N | Selected / served | Holdout Brier | Edge |
|---|---:|---:|---:|---|---:|---|
| Trend Continuation | 7243 | 0.3849 | 1449 | base_rate / base_rate | 0.239083 | no |
| Break of Structure | 2118 | 0.3805 | 424 | base_rate / base_rate | 0.24457 | no |
| Liquidity Sweep Reversal | 3164 | 0.3448 | 633 | base_rate / base_rate | 0.220981 | no |
| Volatility Expansion | 943 | 0.4083 | 189 | base_rate / base_rate | 0.239576 | no |
| Pullback Continuation | 5982 | 0.3034 | 1197 | base_rate / base_rate | 0.211951 | no |
| Mean Reversion | 4081 | 0.257 | 817 | base_rate / base_rate | 0.175967 | no |
| Session Breakout | 452 | 0.4093 | 91 | base_rate / base_rate | 0.2528 | no |

No tested strategy passed the score-dependent edge gate. Each serves its observed base rate. Mean Reversion now fires and is measured (4,081 outcomes); the earlier zero-fire defect was fixed before this validation change. Session Breakout has only 91 final-period observations, below the 100 required for an edge.

## Agents

| Agent | N | Influence | Basis |
|---|---:|---:|---|
| STRUCT | 11336 | 0 | no_out_of_sample_skill:selectionLower95=-0.00065; holdoutLower95=0 |
| RISK | 11336 | 0 | no_out_of_sample_skill:selectionLower95=0; holdoutLower95=0 |
| PRECISION | 11336 | 0 | no_out_of_sample_skill:selectionLower95=-0.000022; holdoutLower95=0 |
| SCANNER_AI | 11336 | 0 | no_out_of_sample_skill:selectionLower95=-0.000693; holdoutLower95=0 |

Other agents have no replayable prediction record and receive zero influence, with a specific reason in the JSON report. These findings describe the tested agents and data; they do not establish that no predictive signal exists.

## Saved-fit upgrade

Legacy `isotonic_pav_beta_shrinkage_cv_selected` fits are rejected by the cache, reading API and agent-trust calculation. The next authorized refit appends a new version even if N, wins and provenance are unchanged, because the method changed. Changed fit contents also invalidate the persistence shortcut. Repeating an identical new-method fit is idempotent. Until refit, old readings are unmeasured; no migration fabricates missing resolution times.

## Test controls

The original planted-momentum replay does not establish an edge under this validation method; its negative result is retained as a regression. Direct planted-score controls use larger records (12,000 observations for reliability/agent influence; 16,000 generated scanner training observations before excluding H4) to exercise successful detection with separate selection and holdout periods. The thresholds are unchanged to accommodate these controls. Driftless-GBM controls remain negative.
