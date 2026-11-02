# Strategy evidence validity — 2 November 2026

Application commit: `d662844787474bab881714dfcd7d0d3dd760cf83`.
Base: `3502f4afde7ee017e260ea60b27985770fe60478`.
Branch: `codex/strategy-evidence-validity-20261102`.

Verdict: scoped library hardening verified offline. This is not universal engine accuracy or release acceptance.

## Problem and correction

The strategy-edge scorer used the host clock instead of the supplied evaluation clock. Future-dated observations could award more than ten recency points and produce scores above 100. Nonfinite statistics could fall through comparison checks or produce nonfinite results. Invalid or implicitly local timestamps could also produce misleading evidence.

The scorer now validates finite win rate (0–1), finite nonnegative profit factor, nonnegative safe-integer sample size, finite expectancy and an explicitly zoned valid ISO observation time no later than evaluation time. Invalid evidence produces score zero and a DATA blocker identifying the fields. No malformed numeric evidence is echoed into its JSON report. Valid historical evaluation uses `ctx.now`; omission uses the current clock.

Existing valid score arithmetic, sample thresholds, weights and the 60-day stale-warning rule are unchanged. The inaccurate “log-scale” comment now describes the existing linear contribution. No calibration, AI entry policy or override policy was created or changed.

## Reachability and limits

Source searches found calls inside the confidence-gate library but no application caller for `runConfidenceGate` or `scoreStrategyEdge`. This change must not be credited as a current Scanner, screenshot or order-dispatch correction. The aggregate library already turns a DATA blocker into a blocked verdict; its separate override mechanism was not changed.

Numeric validity does not prove provenance, sample outcome correctness, calibration, account/symbol correspondence or approved AI confidence. The scorer assumes its required typed context and Date object. Whole-context schema validation is outside this change.

## Evidence

- Original 30-case suite on the base source: 3 passed, 27 failed. These are test cases, not 27 independently counted bugs.
- Final validity suite: 31 passed; includes omitted-clock fallback, offset equivalence, future-by-1ms rejection, impossible calendar date, NaN/infinity, invalid counts, retained valid loss/sample blockers and bounded valid extremes.
- Exact committed combined run: 107 passed, zero failed/skipped (31 validity and 76 Profit Mission regressions).
- Shared-library and API type checks passed on the same source bytes.
- Test-wiring guard passed: new API test script is in root CI. Full root CI was not run.
- Independent review clear; independent 31-case rerun passed; final source/test hashes match its receipt.
- No new builds, full frontend suite, browser checks or broker tests are claimed on this commit. Previous chart evidence remains tied to its original commits.

Raw before/after failures, independent review, type logs, wiring check, reachability search and source manifest are in `/Users/areyouok/arx-tier1-release/strategy-evidence-validity-20261102/`.

## Remaining accuracy work

1. Other confidence-gate dimensions need validity review. Forward validation currently awards neutral/default scores for incomplete evidence and does not enforce timestamp age; its policies must not be silently treated as calibrated confidence.
2. A complete engine audit must prove runtime callers and source/account/currency/symbol/timeframe/observation identity, not infer coverage from file counts or test totals.
3. Actual chart/Scanner/Truth contradictions and stale account money remain separate end-to-end acceptance work. This library fix does not prove their resolution.
4. Native chart trusted-input timing, throttled Scanner navigation, calendar intervals and documented TradingView/MT5 gaps remain open.

No main merge, deployment, Replit sync, existing-database changes, workers, trading or broker interactions were performed.
