# FVG source qualification and withheld output — 1 November 2026

Status: development correctness increment; **not release-green, not deployed, no parity claim**.

Application source: `a01817bb0f69e0ce6fa054b5f9af4a8d076e78fe`, based on `7182f339271c36737109e1428e1bf43caef6b634`.

## What changed

Both the shared chart-assessment service and the Scanner FVG decorator previously fetched raw H4/H1/M5 candles and inferred usability mainly from provider names and failed-attempt text. A valid primary read could therefore carry FVG analysis from forming, unconfirmed, stale or differently attributed secondary observations.

Both paths now use one captured-input helper over the existing normalized chart service. It excludes forming bars, requires each interval's feed verdict and original UTC evidence, and checks the returned market, interval and last closed candle. Secondary source provenance must match the primary assessment or Scanner row. An unknown clock is recorded separately from known staleness. Missing evidence withholds analysis rather than manufacturing confirmation.

The original source digest includes an interval-specific source ID, so comparing it across intervals would wrongly reject every valid combination. The new opaque venue digest retains provider, subprovider, bridge, user, environment and broker-symbol distinctions while excluding that validated interval-specific ID. Existing source identities remain unchanged. Scanner row spreads retain the opaque binding; serialization does not expose it. Same-symbol rows with different or missing attribution cannot inherit one another's FVG result. Scanner calls still use its shared data budget.

The structural-only output filter previously nulled top-level prices while leaving a nested zone, generated price prose, a BUY/SELL signal, an entry stage and score. It now removes the zone and price prose, returns WAIT / WITHHELD / no_trade with no score, clears canSignal and active-entry tags, and preserves only structural trend context. Repeated withholding is idempotent. Assistant instructions explicitly prohibit reconstructing an entry from withheld fields; actual model compliance is not established by this source change.

Broader regression checks exposed a timestamp defect: Scanner rawClosed converted all assistant providers to close-stamped times, despite the actual Polygon FX and Twelve Data stock parsers supplying opening times. Scanner now reuses the normalizer's existing provider timestamp convention. The test fixture independently names open-stamped and legacy close-stamped providers; it does not borrow the implementation helper to derive expectations.

## Evidence on the application commit

- Captured-input suite: **59 pass, 0 fail/skip**, including actual structural service and pure FVG engine under mocked provider/DB boundaries; the Scanner decorator is AST-extracted verbatim with module/scheduler boundaries replaced.
- Provenance and existing Truth suites: **46 pass, 0 fail/skip**, using an import mock that refuses simulator access.
- Existing FVG script: **21 checks pass**, extended for nested zone/prose, signal, stage, score, tags, purity and idempotence.
- Full frontend: **3,861 pass, 0 fail, 11 skipped**; 228 test files pass and one is skipped. The jsdom navigation warning remains.
- All four CI typecheck groups pass; API and dashboard builds pass. Dashboard large-chunk warning remains.
- Guards: **85/87**. The same 43 failure/header lines as the prior checkpoint: 38 risky-wording findings and three internal UI-name findings. No waiver or release-green claim.
- Two independent source reviews are pinned to the application commit. They found the clock-evidence and retained-stage/score gaps during development; both were corrected and re-reviewed.

Eleven initial service regression tests failed against the old implementation; the stronger withholding check failed too. The old timestamp test also failed on the exact baseline; correcting its stale provider assumption exposed the actual rawClosed shift, which was fixed. An initial existing provenance/Truth run imported an in-memory simulator timer and did not terminate: it was stopped (exit 130), and the final isolated run passes. All failures and outliers are retained. Counts overlap; they are not a unique-test coverage sum.

Raw receipts: `/Users/areyouok/arx-tier1-release/chart-fvg-qualified-input-20261101/`. Repository archive: `docs/validation/chart-fvg-qualified-input-20261101/`.

## Limits and next work

These are separately captured interval observations, not an atomic multi-timeframe snapshot. Captures are not re-aged at the end of a long request. No new expiry/confidence policy was invented. Matching provenance does not establish missing broker/account authority. Copied normalized metadata does not mint runtime producer witnesses.

MT5 and Deriv history without original historical UTC qualification remains withheld by this FVG path. A syntactically valid timestamp or current heartbeat offset does not supply that evidence. Completing reviewed original-provider clock evidence is still needed for those sources; no blanket bypass was introduced.

Normalized reads and capturing have additional work/copy cost. Deployment load, end-to-end latency and actual scheduler concurrency were not measured in this slice; the new Scanner test proves grouping, budget invocation and output projection. No browser, HTTP, provider, terminal or matched competitor acceptance was performed. Full root CI and database-backed integration were not run.

Independent audit also confirmed a separate unresolved issue: changing a plan can leave the previous draft's chart assessment visible, including a late completion. Chart/scalp panels can share a market key despite different plans. The audit and required regression scenarios are retained in the archive; a coordinated shared-store binding fix is next. Cross-surface account/source/window/age binding, slower-device first-click failures, monetary real-time acceptance and the original chart capability/TradingView/MT5 comparison gaps remain open.

No main/PR76 merge, app deployment, Replit update/restart, existing database mutation, live/demo broker test or order occurred.
