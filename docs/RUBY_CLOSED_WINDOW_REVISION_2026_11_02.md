# Closed-window assessment revisions — 2 November 2026

Application: `7222428cfc3190f0ccad63f008f3a624e0e80e6b` on `codex/ruby-window-revision-20261102`, based on `bbdbf9ea`.

## Behavior

A provider correction can change an older candle without changing source identity or the newest closed timestamp. Two component regressions proved that completed and pending assessments previously survived this revision (37 tests passed, two failed).

The existing chart-data producer now attaches a SHA-256 fingerprint of the same closed-candle projection used by Ruby/Eleanor. It includes ordered open times, OHLC and copied price/time/volume metadata. Object keys are sorted deterministically; receipt timestamps, display flags and forming bars are excluded. Empty, invalid OHLC, nonfinite inputs and duplicate/out-of-order projected times do not earn an identity. The fingerprint is versioned internally and is equality evidence, not a guarantee about data quality.

The chart query retains the server fingerprint rather than reconstructing it. Assessment matching now requires it. A revision invokes the previously reviewed cancellation and withdrawal path, including the shared header restriction. Missing or malformed fingerprints cannot keep a positive assessment current. Routine refetches and forming ticks preserve a matching closed-window identity. Server and client must carry compatible evidence; older responses are conservatively refused.

## Evidence

Validation ran on the application/test content committed above; subsequent documentation does not change it.

- Dashboard: 4,766 passed, 12 skipped, zero failed.
- Backend existing lanes: captured inputs 82; chart truth 23; forming-tip/source isolation 18; component evidence 47. All passed, with zero skipped/failed.
- Real chart producer tests verify that an older OHLC correction changes the digest while source/newest-close remain equal, and display forming ticks/refetch receipt changes preserve it. Component tests verify completed/pending withdrawal. These are offline fixtures, not broker evidence.
- All four type-check units passed; API typecheck passed again after fixture assertions changed. Both builds passed; dashboard chunk-size warnings remain.
- Guards: 85/87. The same two failures (`risky-wording-frontend`, `no-internal-names-user-ui`) have 43 matching normalized failure lines. Three supplemental checks passed separately.
- Independent static review found no blocker for this scoped change. No independent test rerun was claimed.

All receipts, initial failures and the review are under `/Users/areyouok/arx-tier1-release/ruby-window-revision-20261102/`.

The combined ancillary invocation first failed three strict object comparisons: expected objects omitted the already-emitted venue identity and, for the chart producer, the new digest. The assertions now preserve all prior comparisons and explicitly check the additional fields. One attempted edit used the wrong directory and the repeated failure was retained. A later combined runner retained its pure chart-test child after the final assertion; the exact process was inspected and explicitly stopped, and that run is not a pass. The existing separate commands then completed successfully. No test was weakened or skipped to clear this result.

## Remaining limits

This binds the primary closed analysis inputs only. HTF observations, current candles, quotes, same-user selected broker-account changes and assessment expiry remain separate work. Other Truth component comparisons have not been changed to require this digest. Equality does not establish correct prices, UTC authority, causality or calibrated confidence. Internal response mutability from the preceding checkpoint remains a hardening limit.

No full root CI, database integration, browser acceptance, running Replit source verification or performance measurement was performed. Fingerprinting adds linear work per feed build; no speed improvement is claimed. The separate **Optimize ARX AI performance** chat owns broad performance work; its compact status was inspected read-only, with no message sent or timing agreement assumed.

No main merge, deployment, Replit sync, existing database migration, worker enablement, trading or broker test occurred. The broader chart/architecture goal remains active and release status is **not green**.
