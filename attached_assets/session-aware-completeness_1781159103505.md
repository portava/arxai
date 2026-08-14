# Fix candle completeness check: session-aware expected grid (no hardcoded calendars)

## Confirmed diagnosis (do not re-diagnose)

The chart-read quality layer computes "expected bars" on a naive 24/7 calendar. For EURUSD this counts market-closed slots as missing bars: H1 reported 96 missing (= exactly two Fri 21:00Z → Sun 21:00Z weekend closures), D1 reported 33 missing (= 33 consecutive Saturdays). Zero genuine gaps exist. Result: H1/H4/D1 read quality=partial, aiUsable=false on a perfectly complete broker feed, and Ruby downgrades to limited read on those timeframes.

The fix belongs ONLY in the sequence-completeness / expected-grid calculation. Do NOT touch candle ingestion, broker_candles, backfill, the router/source-priority, or the EA contract.

## Required approach: learned weekly session profile

Do NOT hardcode session calendars or fixed boundary times. The broker's weekly close/reopen boundary (currently Fri 21:00Z / Sun 21:00Z) is DST-dependent and shifts to 22:00Z part of the year; per-symbol sessions also differ (forex vs metals vs Deriv 24/7 synthetics). Hardcoding will produce false gaps twice a year.

Instead, derive the expected grid from observed data:

1. For each (symbol, timeframe), build a weekly presence profile from stored broker_candles history: bucket every stored bar by (day-of-week, time-of-day slot). A slot is "expected" only if bars are present in that weekly slot in a sufficient share of the observed weeks (e.g. >=50% of weeks where any data exists). Slots that are absent week after week are market-closed, not missing.
2. Completeness then counts a bar as MISSING only if its slot is expected by the profile and the bar is absent.
3. Classify absences in the quality output:
   - missing in expected slot -> genuine gap (counts toward partial/aiUsable=false as today)
   - absent in never-present slot -> market_closed (does NOT count)
   - one-off absence in a normally-present slot (e.g. a holiday) -> counts as a gap but report it under a distinct reason ("isolated_closure_or_gap") so it is distinguishable; aiUsable threshold may tolerate a small number of these (e.g. <=2 per window) without flipping false — pick a threshold and document it.
4. Minimum history guard: if fewer than 3 weeks of stored history exist for the series, fall back to the current 24/7 grid but tag qualityReason="insufficient_history_for_session_profile" instead of asserting missing bars as fact.
5. Cache the profile per (symbol, timeframe) with invalidation on new ingest days — do not recompute it on every chart read.
6. The DST boundary shift must be tolerated naturally: when the weekly boundary moves by an hour, the profile sees both the old and new slots as sometimes-present; the >=50% rule plus the isolated-closure tolerance must not flag a false gap in the transition weeks. Add a test for this.

## Downstream effects (verify, do not redesign)

- aiUsable flows from quality: with the fix, EURUSD H1/H4/D1 must read clean/aiUsable=true on live data.
- Ruby read confidence follows aiUsable — confirm Ruby gives a full read on H1/H4/D1 after the fix.
- Deriv 24/7 synthetics (e.g. Volatility indices): profile is fully present, behavior unchanged — a genuine mid-stream hole must still flag partial.

## Tests

- EURUSD-shaped fixture with two weekend closures in an H1 window: quality=clean, 0 missing, aiUsable=true.
- Same fixture with one genuine mid-week hole added: that hole (and only it) reported missing; aiUsable per threshold.
- D1 fixture with weekly Saturday absences: clean.
- 24/7 synthetic fixture: unchanged behavior; injected hole still flags.
- DST transition fixture: boundary moves 21:00->22:00 mid-history; no false gaps.
- Insufficient-history fixture (<3 weeks): falls back with qualityReason="insufficient_history_for_session_profile", does not assert missing bars.
- Existing candle suite passes unchanged. Typecheck passes.

## Acceptance

- Live EURUSD chart read returns quality=clean, aiUsable=true on M1, M5, M15, H1, H4, D1.
- Ruby full read available on H1/H4/D1.
- No changes outside the completeness/quality layer and its tests.
- Response names the exact file(s)/function(s) changed and shows the before/after live read for H1 and D1.
