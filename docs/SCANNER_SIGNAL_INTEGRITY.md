# Scanner signal integrity audit

2026-10-26. Follow-up to `SCANNER_QUALITY_ACCEPTANCE.md` and PR #78. This audit concerns correctness of data entering a heuristic scanner. It does not establish strategy profitability, calibrated probabilities, professional screener parity, or production latency.

## Findings and repairs

| Boundary | Defect | Implemented behavior |
| --- | --- | --- |
| Router bars → analysis | Raw bars, including unfinished bars, counted as closed and influenced scores/regime/features | Reuse the chart normalizer's provider-specific timestamp convention. Only completed valid bars enter those consumers. No candle is synthesized. |
| Instrument/timeframe/source | Scanner accepted request aliases without canonicalizing all paths; returned data identity was trusted | Resolve approved canonical symbol/timeframe before I/O; reject wrong-symbol results, unknown/mock sources and conflicting provenance. Denser wrong-timeframe series are refused. |
| Candle integrity | Raw order, duplicate/conflicting bars and malformed OHLC could influence analysis | Sort using the shared normalizer; identical duplicate bars count once; conflicting duplicates, invalid timestamps and invalid/nonpositive OHLC refuse the read. |
| Continuity | A 24/7-market missing interval could silently bridge separate observations | Use only the latest contiguous tail for crypto and synthetic markets; its actual depth must pass sufficiency. Session instruments retain real gaps without fabricated bars. Authoritative exchange calendars remain future work. |
| Candle/quote identity | Independent router fallbacks could combine candles and quotes from different feeds; absent quotes became candle-close/zero-spread geometry | Live readiness requires a current matching instrument/provider quote, compatible known bridge/account identity, and a measurable positive spread. Bid/ask supply midpoint and spread when available. Historical candle context cannot create live actions. |
| Opportunity Map lateness | A second quote read could change the setup's original provider, or use reversed stop geometry | Retain an internal opaque source binding through decorators and compare the entire originating identity (including bridge/account/environment/native symbol) during enrichment. Recheck closed candles, require a matching fresh quote, and require directionally valid entry/stop/target geometry. Unknown timing withholds readiness. |
| Regime memory | Symbol/timeframe state could survive a feed switch and older windows could count as new confirmations | Key state by feed identity as well; refuse backward windows and same-bar corrections without advancing held state. |
| Candidate ranking | Ties depended on input order; malformed scores or inconsistent action/direction could create candidates | Deterministic score/quality/identity tie order. Non-finite/out-of-range map scores and contradictory directions are withheld. Invalid effective-ranking components rank zero. |
| Legacy results polling | Fixed-interval polling could supersede every slow healthy request before it completed | Completion-based scheduling permits one active poll; seven-second fixture reads publish successfully despite the five-second target interval. |
| Selected trade ticket | Freshly retimestamped rows could pass without an envelope timestamp; newer invalidation did not dismiss an old ticket | Both original scan and row timestamps are mandatory. A new invalid/non-tradeable/missing setup or changed action/geometry dismisses the old ticket immediately. |

Close-time semantics preserve each provider's actual bar start, including session opens not aligned to UTC hours. MT5/Deriv raw times are opens; assistant-real raw times follow the existing chart close-time convention. The normalized feature/regime path receives open times. Closure means `provider open + requested interval <= observation time`, rather than flooring a session bar to an assumed UTC bucket.

This matches the distinction in [MQL5 CopyRates](https://www.mql5.com/en/docs/series/copyrates) between completed history and the current unfinished bar. TradingView also explains using [confirmed bar states](https://www.tradingview.com/pine-script-docs/concepts/bar-states/) to avoid provisional real-time conditions, while documenting that [provider revisions can still change historical results](https://www.tradingview.com/pine-script-docs/concepts/repainting/). These references inform the acceptance criteria; they are not performance comparisons.

## What the scores actually mean

The current scanner is deterministic heuristic analysis, not a trained or calibrated prediction model:

- `confidenceScore` averages setup quality, entry quality and inverted risk score in `aiBrain.ts`. It is not an empirical success rate.
- `entrySniperScore` comes from that same entry-quality calculation. Multiple visible score names do not establish independent evidence.
- `opportunityScore` sums bounded factors and applies an older formula as a downward ceiling. `supportResistanceQuality` is pinned to zero; `aiConfidenceCalibration` is pinned to five; the scanner passes a constant strategy match of seven.
- The generic factor maxima sum to 78/100, or 75 with the scanner's strategy-match constant. The current fixed 2:1 risk/reward and entry-quality rules constrain the ordinary base score further. Existing `STRONG`/`ELITE` thresholds are not evidence that those labels are statistically validated, and their reachability changes with later advisory/timing decorations.
- Opportunity Map execution quality is a feed-state lookup, not an observed execution/slippage model. Candidate “edge” means rank points, not estimated financial edge.
- Regime confidence reflects state-machine evidence and hysteresis, not demonstrated outcome calibration.

This change does not raise scores, retune thresholds to produce more “elite” signals, or relabel them as probabilities. A future ranking specification should expose formula/version/data provenance, keep any calibrated estimate separate, and validate on chronological holdouts with closed-bar timing, costs, adverse feed cases and no leakage. No measured outcome corpus was used in this audit.

## Validation and limitations

Tests run with provider credentials removed, live execution disabled and an unreachable loopback database; HTTP routes use mocked users/providers/cooldowns. New behavioral fixtures cover unfinished-bar price shocks, the exact bar-close boundary, session-offset starts, malformed and duplicate data, source mismatch, old/corrected regime windows, every permutation of tied candidates, and stale/invalidated selected tickets. The real scanner integration fixture proves unfinished bars cannot change scores, regime or feature snapshots and cannot satisfy the closed-bar floor.

The source-binding regression proves internal binding survives object-spread decorations while JSON responses omit it; no account or bridge identifiers are added to client payloads.

The positive live-feed regression controls now include a genuine in-memory quote fixture. The prior controls supplied only candles and therefore encoded the behavior this change intentionally removes.

Validation at this change: 376 targeted tests (18 input/pipeline/ranking, 47 scanner quality, 69 existing truth/feature/pattern regressions, 10 regime tests, 216 UI/pure tests, and 16 cooldown/outage/feedback tests); full workspace typecheck, both production builds and 87/87 architecture guards. These are local offline checks. The existing dashboard bundle-size warning remains.

Remaining limits: no authoritative session-calendar gap classification; no per-bar signed identity; no distributed regime state, replay corpus, statistical calibration, production load benchmark, real broker testing or deployment. Source provenance is checked when the router supplies it; legacy missing provenance is not invented. Existing execution gates continue to own order authorization.
