# Scanner Smart Chart integration — 28 October 2026

Status: development implementation; no deployment or release-green claim.
Draft PR #103 remains stacked on `claude/pr99-round3` (`0b519bd8`).

## Owner target and implementation

The actual Scanner page now uses the shared ARX Smart Chart. The former
Scanner-only chart renderer was removed. Scanner still owns its position,
pending-order, annotation, read/receipt and confirmation controls; a view-only
surface bridge binds them to the shared engine. Native owns candle/history/
stream rendering. The shared query preserves the original API response, so
finality, source identity and volume evidence are never reconstructed from
an OHLC-only projection. Unsupported server overlay/receipt intervals are
explicitly unavailable, with no nearest-interval substitution.

The old TradingView widget loader and its four callers are removed:
`live-chart`, `live-manual`, `live-ai-assist`, `live-ai-auto-test`. They now render
ARX Smart Chart. View selection does not bypass trading or account gates.
AI Assist labels its separate M15 analysis. No external chart iframe remains.

ARX Smart Chart uses Lightweight Charts as its rendering dependency. This is
not the TradingView embedded product and is not a renderer written from scratch.
Required library attribution remains below the plot; the plot logo is disabled.

The shared chart offers 19 fixed-duration intervals, zoom/pan buttons and keys,
pointer navigation, studies/drawings, style selection, templates and its reader.
Mobile advanced tools collapse while zoom/pan remain visible. W1/MN1 stay
unavailable pending provider-calendar correctness. No active AI confidence policy
or trading permission was introduced.

## Evidence

Final application source: `23698959c7f097bcf712847a9d81b23e5ec62f16`.
All later changes in this receipt commit are documentation/evidence only.
The final quiet run passes **164 frontend files: 2,322 passed / 9 skipped**,
dashboard typecheck, the production build, **87/87 guards** and **7/7 binding
assertions**. Tooling tests pass **18/18**. Build warnings about bundle size and
fixture sourcemap diagnostics remain. No uncaught page exceptions were observed;
64 console errors and 58 unknown-read attempts were expected blocked/unmocked
HTTP failures. This does not describe an error-free connected app.

Actual Scanner browser acceptance passes all **38 assertions** on the clean,
unchanged production fixture `0b73849de1482966`, with an executed build-ID check
and asset hashes. It verifies full canonical and displayed candle arrays after
EURUSD→GBPUSD and M15→M5 selection, formula-correct Heikin Ashi with unchanged
canonical data, retained engine identity, actual zoom/pan ranges, keyboard and
pointer navigation, honest unavailable reader truth, and mobile disclosure with
zoom/pan visible. Every mutation attempt was blocked; no trade request or
external connection was observed. This is functional evidence, not latency.

Reviewable receipts: [validation directory](validation/scanner-smart-chart-20261028/),
[browser summary](validation/scanner-smart-chart-20261028/browser-summary.json),
[raw browser JSON (gzip)](validation/scanner-smart-chart-20261028/browser-acceptance.json.gz),
[desktop screenshot](validation/scanner-smart-chart-20261028/scanner-final-desktop.png),
[mobile screenshot](validation/scanner-smart-chart-20261028/scanner-final-mobile-closed.png).
Full working receipts remain in `/Users/areyouok/arx-tier1-release/chart-mobile-20261028/`.
Pre-final application source `c6c7b360`: 163 frontend files, 2,316 passed and
9 skipped; typecheck and production build pass; 87 guards and 7 bridge-binding
assertions pass. The poisoned disabled-intelligence-cache regression fails when
the ownership guard is removed (mutation receipt retained).

## Retained failures and corrections

- An earlier full frontend run alongside builds had one role-gate failure.
  Its focused rerun and the subsequent quiet full run passed. Original log kept.
- Missing local esbuild binary and a guards command run from the wrong directory
  failed setup. Corrected runs are separate receipts, not erased failures.
- First Scanner acceptance reported empty data after a market change. The local
  Playwright runner returned immediately for an async false predicate (1ms
  reproduction), so this did not prove a post-success withdrawal. The corrected
  waiter acquires expected data outside the browser poll, then synchronously
  checks actual series data and rechecks after two animation frames.
- A traced rerun passed market/timeframe/style/navigation checks but failed
  mobile controls because the isolated fixture omitted dashboard Tailwind
  utilities. Fixture-only explicit source scanning and an emitted-CSS guard
  fix this; no application CSS was changed for the test.
- The existing scalp-focus analysis POST was initially unclassified. Its exact
  route is now reported as blocked analysis. All non-GET requests still receive
  503; no request is permitted by classification.
- Review found the seven-interval overlay restriction had incorrectly disabled
  server intelligence for supported intervals such as H8. The endpoint's own
  full interval contract is used, while seven-interval routes retain their gates.
  Six integration cases cover H8, source changes, mismatched context and calendar
  refusal; the focused new/existing context lane passes 14/14.

## Limits and next work

This isolated production fixture imports the real App, providers and Scanner
route with an observer and synthetic historical data. It is not the deployable
bundle or a broker/feed test. Reader truth is deliberately unavailable. Owned
position/pending-order overlays and active automatic analysis are not browser
accepted by this fixture. Secondary live pages have source/component checks;
full browser acceptance of all four is separate work.

Actual integrated Scanner latency, sustained streams/history, active analysis,
and TradingView/MT5 comparison gaps remain open. Prior standalone performance
misses remain in the comparison report; no percentage or parity is asserted.
No main merge, deployment, existing database modification, worker/trading enable,
email or live/demo broker operation was performed.
