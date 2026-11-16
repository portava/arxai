# Prospective calibration evaluation

This explicit operator harness compares two frozen versions of one calibrator on the same future application signal cohort. It complements the existing purged forward selection and chronological holdout; it does not replace either, generate a trading strategy, activate weights, or authorize trading.

No cohort is registered by startup. Schema push creates tables only. An operator must explicitly apply `lib/db/migrations/2026-11-12_calibration_prospective_v1.sql`, then register a future observation window. The migration installs a receipt trigger on the existing Eleanor signal ledger. With no matching registration, no prediction receipts are written. Receipt collection covers only the specified user, exact symbol/timeframe, and Eleanor or scanner source. As in the existing refit worker, Eleanor includes scanner-originated signals; scanner is the subset with a scanner signal ID.

From the API-server directory:

```
node --import tsx src/scripts/calibrationProspective.ts register plan.json
node --import tsx src/scripts/calibrationProspective.ts report USER_ID RUN_UUID
```

Registration input:

```
{
  "userId": 42,
  "strategy": "eleanor",
  "symbol": "EURUSD",
  "timeframe": "M15",
  "candidateVersion": 2,
  "baselineVersion": 1,
  "collectionStart": "2030-01-02T00:00:00Z",
  "collectionEnd": "2030-01-09T00:00:00Z",
  "labelDeadline": "2030-01-16T00:00:00Z",
  "minSample": 100,
  "minImprovement": 0.005
}
```

Dates above are illustrative; choose the full window before observing its results. Both fit versions must already exist for that exact key, be measured by the current engine, and have fit/data dates preceding registration. Registration copies the entire artifacts into a hash-checked plan using database registration time. Later fit changes cannot change the experiment. Overlapping cohorts for the same user/source/key are rejected. Minimum thresholds can be made stricter, not weaker.

The database records prediction snapshots on insertion, later outcomes, changed prediction fields, and deletion. Reports include all captured predictions, regardless of the outcome. Missing labels, duplicates, edits, deletion, backdating, labels already known at insertion, unrecognized label methods, invalid scores, and outcomes observed after the fixed deadline refuse a positive result. Metrics remain hidden until that deadline. At least 100 fully resolved predictions and 10 per each of five time blocks are required. Candidate-versus-baseline Brier improvement must exceed the predeclared margin using the existing engine's conservative individual/block lower bound.

`CALIBRATION_IMPROVED` describes this finite captured cohort only. Labels come from the existing application resolver (`observed_move` or `closed_trade`), not independently verified external ground truth. Correlated observations, changes to raw-score generation, multiple non-overlapping experiments, and broader market regimes still limit inference. This does not prove profitable edge, causal benefit from AACI, or production effectiveness. `liveAllowed` and `autoPromotionAllowed` are always false. No runtime serving or promotion path consumes this report.

Rollback applies the matching `.rollback.sql`: it removes capture while retaining registrations and receipts. Registration/reporting then refuse unavailable capture. Reapplying the migration starts a new capture epoch and invalidates earlier runs' continuity; register new cohorts. Triggers and hashes detect ordinary application-level changes, not a privileged database administrator disabling triggers or rewriting tables. Keep this migration and its indexes in the normal reviewed deployment process; the harness never applies it automatically outside its disposable tests.

Tests run through the existing `test:calibration` and `test:calibration-store-db` lanes. The database test explicitly applies and rolls back the migration only in the CI/disposable database; never run that lane on a production database.
