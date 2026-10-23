# COMMAND — STALE-FEED DOWNGRADE INTEGRATION TEST (#794, symmetric sibling of the thin-feed test)

Read this entire command before changing anything. This is a TEST-ONLY task — add one router-backed integration test. Do NOT change production code, gates, scanner logic, or the floor. The thin-feed downgrade now has an end-to-end integration test (`scannerThinFeedDowngrade.test.ts`) proving a fresh-but-thin LIVE feed is forced to `AWAITING_FEED`/`no_data` so it can't show a live-grade score. The STALE_FEED honesty path has NO equivalent router-backed test — it's only asserted at the derivation level. Close that gap the SAME way, with the SAME pattern.

## WHAT TO PROVE

A row whose feed is STALE (candles exist but are too old to be live — past the freshness threshold) must NOT surface a live-grade execution/feed score. It must downgrade so `executionQualityFor` yields the honest low STALE value (30), and the row is non-selectable/non-tradeable — proven by driving the REAL call path, not by hand-constructing a STALE_FEED object.

## PATTERN TO MIRROR (do not invent a new approach)

Copy the structure of the existing `artifacts/api-server/src/lib/__qa__/scannerThinFeedDowngrade.test.ts`:
- Same real call path, NO module mocks: `scanSymbolTimeframe → analyzeViaRouter → routeCandles → mt5Provider` (the in-memory `mt5_broker` seam that pulls in `@workspace/db` via the router).
- Same in-memory provider seam used to inject candles.
- Same assertion style on the resulting op (`dataSource`, `dataStatus`, selectability/tradeability fields).

The ONLY difference is the input condition: instead of *too few fresh* candles, inject *enough candles but STALE timestamps* (older than the LIVE freshness threshold in `resolveSymbolFeedVerdict` — use the same threshold constants the thin-feed test referenced, set the latest closed-bar time far enough in the past to be STALE, not LIVE/LIVE_DELAYED).

## TEST CASES (both poles — required, same as the thin-feed test)

1. **STALE feed → downgraded:** push a feed with sufficient bar COUNT but timestamps old enough to be stale → assert the row's `dataSource === "STALE_FEED"` (or whatever the real stale resolution is — confirm against `resolveSymbolFeedVerdict`, don't assume the literal), `executionQualityFor(dataSource)` would be 30 (the honest stale value), and the row is non-selectable/non-tradeable. Assert it does NOT surface as live-grade (not LIVE_FEED, not Exec 80).
2. **Contrast — fresh sufficient feed stays live:** the same symbol with fresh + sufficient candles stays `LIVE_FEED`/live and selectable. (This proves the downgrade is FRESHNESS-driven, not that everything downgrades — without this pole the test is one-sided and could pass while breaking live rows.)

## STEP 0 — VERIFY THE SEAM BEFORE WRITING (read-only)

- Read `resolveSymbolFeedVerdict` to confirm the EXACT freshness thresholds and the STALE resolution (what timestamp age yields STALE vs LIVE_DELAYED vs LIVE) — set the test's stale timestamps from the real thresholds, not a guess. STALE and LIVE_DELAYED are different; make sure the injected age lands on STALE.
- Confirm `executionQualityFor("STALE_FEED")` returns 30 (the honest value the test asserts).
- Confirm the op field names for selectability/tradeability match what the thin-feed test used (reuse them).

## WIRING (same as the thin-feed test)

- Add a `test:scanner-stale-feed-downgrade` script to `artifacts/api-server/package.json` (mirror the thin-feed script).
- Add it to `INTEGRATION_LANE_TESTS` in `scripts/src/ci/runIntegrationCiTests.ts` (integration lane ONLY — it needs `DATABASE_URL`, must NOT go in the offline `ci` lane).
- Run the wiring guard to confirm the allowlist/lane stay in sync (the count should increment by one).

## NON-NEGOTIABLE
- TEST + wiring only. No production code, no gate, no scanner-logic, no floor, no SL, no import-boundary change. Diff = the new test file + the two wiring lines.
- NO module mocks — drive the real router path (the whole point is to prove the downgrade FIRES, not to assert a hand-built object's score).
- Reuse the real threshold constants / op field names; don't hardcode guessed literals.

## VERIFY
- Run the new test with `DATABASE_URL` set → both cases pass. Paste output.
- Run the wiring guard → in sync (integration-lane count +1). Paste.
- Typecheck the affected leaf packages (api-server + scripts) → green.
- Confirm `git status` / diff is limited to the new test file + the two wiring entries.

## FINAL REPORT
Step 0 confirmations (the real stale threshold + that `executionQualityFor("STALE_FEED")===30`); the new test file path; both poles' assertions; wiring added; test + guard + typecheck outputs; confirmation no production code changed.

## COMPLETION STANDARD
- A router-backed integration test (no mocks) proves a STALE feed downgrades via the real `scanSymbolTimeframe` path and cannot surface a live-grade score (honest 30, non-selectable), with a contrast case proving a fresh sufficient feed stays live.
- Wired into the integration lane only; wiring guard in sync.
- Test-only diff (new file + two wiring lines); no production/gate/floor/SL change; typechecks green; outputs pasted.
