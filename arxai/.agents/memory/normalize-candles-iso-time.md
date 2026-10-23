---
name: normalizeCandles requires ISO-8601 time in fixtures
description: Why OHLC test fixtures fed through normalizeCandles silently vanish unless time is ISO
---

normalizeCandles (artifacts/api-server/src/lib/data/chart/candleNormalization.ts)
parses each bar's `time` with `Date.parse(c.time)` and DROPS any bar whose
timestamp is unparseable (flag TIMESTAMP_INVALID) or whose close is in the future
(FORMING_BAR). A test fixture using an epoch-number string (e.g. `String(epochMs)`)
parses to NaN → every bar dropped → the producer returns an honest empty/null read,
and a composition test that expected a detection gets `null`.

**Rule:** any fixture candle that will pass THROUGH normalizeCandles (i.e. through
buildPatternTruthVerdict / buildPatternLibraryRead / buildMarketIntelligenceSnapshot,
not the raw domain detectors) must use ISO-8601 `time` strings
(`new Date(ms).toISOString()`) and past-dated timestamps so nothing is treated as a
forming bar.

**Why:** detectors in lib/domain/src/market/ take bare {open,high,low,close} and
don't care about time, so direct-detector tests pass with any time — but the
api-server composition normalizes first, and normalization is the layer that
enforces honest timestamps. The two layers have different input contracts.

**How to apply:** when a composition/producer test returns null where the bare
detector finds a structure, suspect normalizeCandles dropping bars on time before
suspecting the detector. timeframeMs is seconds-scaled but that's irrelevant —
the gate is Date.parse on the string.
