# ARX structural forecasting integration

New implementation identity: `arx-v6.7-implementation-1`. The owner confirmed
that no original runnable model exists and requested an integrated product.
The research reports remain preserved; their published results are not results
of this implementation.

## Reused application boundaries

`candleHistoryService` supplies paginated training history; `chartDataService`
supplies current finalized, provenance-bearing M1 truth. Existing candle
normalization aligns historical timestamps. `structural/feed.ts` refuses source
mixing and lets the current verified candle replace a cached copy at the same time. A shared pure
TypeScript module supplies validation, causal labels, features, training,
forecast probabilities, ghost selection and scoring. An API service persists
forecasts into existing `chart_decision_receipts.intelligence_snapshot` and
evaluations into `chart_decision_outcomes.evidence`. The chart consumes a new
authenticated forecast endpoint and adds independent ghost candlestick series
through the existing chart adapter. No migration or parallel market-data service.

## Contracts

* Candle timestamps are UTC milliseconds with explicit open, close and finality.
  Input bars must have valid OHLC, contiguous M1 times and known provider/source.
  Still-forming bars never become model features. Historical backfill has fetch
  provenance, not invented historical ingestion timestamps.
* Events publish at the second close. Confirmed pivots become available after
  two right-side closes. Pivot price and displacement scale freeze at precursor
  time. Every new policy choice is versioned; no claim of recovered coefficients.
* One 60-by-4 first-event PMF supplies all six horizons. First five minute
  reallocation preserves all four terminal subtype marginals. Neither means no
  qualifying confirmation, not flat prices.
* Three scenario paths are training-only observed paths, adapted to the current
  starting price and reclassified under the same observer. Display labels say
  illustrations. Missing classes return no path.
* Immutable issued receipt includes history, features, version, training cutoff,
  provenance, PMF, horizon probabilities, gate result, paths and deadlines.
  A persistence failure prevents reporting a saved/issued forecast. Outcomes
  append only after their horizon closes; never change an issued probability.
* Historical fitting uses chronological training, selection, acceptance and
  holdout segments separated by the forecast horizon. Candidate weights and
  transforms derive only from training. Selection chooses blend; acceptance
  independently rejects or approves. Holdout never changes that decision.
* Existing forecasts are advisory information with no command/permission
  capability. Existing 18-gate execution paths stay untouched.

## Rollback and acceptance

The application can remove the chart panel/router integration without affecting
market data, stored receipts or execution. Candidate rejection uses an empirical
training baseline; stale/invalid inputs or insufficient training data abstain.
No promise of predictive or economic edge is inferred from implementation tests.
Required proof: no-lookahead, frozen labels, PMF conservation, terminal invariance,
training-only ghosts, save-before-outcome, user isolation, API/UI integration and
unchanged execution regressions. Production and broker E2E require a configured
environment and remain distinct from these local tests.
