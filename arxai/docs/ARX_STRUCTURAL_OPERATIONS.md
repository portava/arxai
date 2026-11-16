# Operating the integrated structural forecasts

## In ARX

Open the native chart, choose M1, then **Forecast next hour**. The API obtains
existing paginated history and the current normalized chart feed, fits a cached
model in a worker, and saves the snapshot. Toggle the available 60m ghost paths;
choose 1/3/5/15/30/60m probabilities separately. **Refresh saved forecasts**
resolves closed horizons and loads recent history without issuing a prediction.
**Update each minute** polls while the tab is visible. It stops on unmount; this
is not an installed unattended monitoring service.

The API requires the existing authenticated user session. Both methods are at
`/api/me/structural/forecasts`, with `symbol` in POST JSON or GET query.
User identity comes from the session, never the request body. Models are shared
per provider/symbol, cached for one hour (maximum 12), with one concurrent fit
per process and a 30-second worker timeout. Requests receive honest refusal
codes for unavailable data, fit contention, stale tips or persistence failure.

Prerequisites are the existing ARX database schema and configured market feed.
The runtime reuses `getCandleHistory`, `getChartCandles` and candle normalization;
there is no new broker transport, schema migration, model download or service.
Historical missing windows are excluded and counted. Current 120-bar windows
must be contiguous. A provider change refuses mixed-source fitting/evaluation.
Existing MT5 history depth limits remain real limits.

## Receipts, outcomes and retention

`chart_decision_receipts.intelligence_snapshot` holds immutable forecast,
issuance time and fitted manifest. Fingerprints hash the forecast. Separate
`chart_decision_outcomes` rows hold versioned horizon evaluations. Receipt row
locks serialize concurrent append attempts; the original JSON is never updated.
The repository enforces ownership for reads and writes. This is application-level
immutability; it is not a claim that database administrators cannot edit rows.

The API loads 250 recent records per user/symbol. No automated retention/deletion
job is introduced; older snapshots remain stored. Before sustained release,
measure JSONB growth, agree retention/export limits and add paginated history.
Scoring needs the future candles still reachable by the existing history service;
missing bars remain unresolved. Browser polling is not an outage-recovery worker.

## Rollback and improvement

Removing the structural router mount and M1 panel disables the feature without
changing trading/data services or deleting receipts. Rejected/OOD/quarantined
heads fall back to the empirical or gated predecessor model as documented.
Quarantine remains latched for the policy/provider in recent stored history;
there is no automatic re-enable button. A reviewed version change and explicit
new evidence are required for an improvement. Model approval for trading is
outside these statistical candidate gates; no forecast is connected to orders.

Next work, in order: independent longer data capture and prospective soak;
regime/shift and latency/abstention diagnostics; versioned higher-timeframe
features and active FVG lifecycle; calibrated path distributions; durable
model registry, retention and background outcome catch-up. The release follow-up
repairs the frozen-lockfile mismatch and verifies a clean install and builds.

## DEMO economic evaluation protocol — not executed

An authorized future protocol should freeze strategy entry/exit/risk rules and
comparator before a new period, then use the existing DEMO authority flow.
Measure spread, slippage, fees, fill latency, rejection/fill rate, drawdown and
risk-adjusted net returns. Keep forecast score separate from economic P&L.
This implementation did not send DEMO or LIVE orders and did not alter any of
the 18 execution gates, kill controls, user arming or permission settings.

## LIVE readiness assessment

Local feature integration is demonstrated. Trading promotion is not ready:
prebreak gates rejected all five markets; the accepted geometry head degraded
on untouched holdout; the capture spans only about 5.5 days; original arrival
replay is unavailable; unattended operational reliability and calibrated paths
are unproven. Production broker E2E and load/retention controls remain necessary. The owner
authorized merging PR #150 and will handle deployment on Replit separately.
The post-merge hook installs dependencies only and does not change the schema.
Preserve the Replit deployment configuration and existing workspace hardening
when synchronizing the reviewed GitHub changes; the deployed app uses a nested
`arx/` source directory rather than this repository at workspace root.
