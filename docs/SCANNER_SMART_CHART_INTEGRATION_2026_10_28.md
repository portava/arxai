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

Earlier application checkpoint: `23698959c7f097bcf712847a9d81b23e5ec62f16`.
The original receipt at `ae332d23` contained documentation/evidence only after that source.
The follow-up below records later application changes separately.
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
full browser acceptance of all four was pending at this earlier checkpoint; see the follow-up below.

Actual integrated Scanner latency, sustained streams/history, active analysis,
and TradingView/MT5 comparison gaps remain open. Prior standalone performance
misses remain in the comparison report; no percentage or parity is asserted.
No main merge, deployment, existing database modification, worker/trading enable,
email or live/demo broker operation was performed.


## Follow-up: no chart logos and measured Scanner work

Validated application checkpoint: `8e87e55d030547be4cb3cf1e3aab00b00dba792a`.
The full dashboard lane passes **164 files, 2,328 tests / 9 skipped**, typecheck,
production build, **87 guards** and **7 binding assertions**. Bundle warnings remain.
The clean immutable browser fixture is `eee7b37ce1e8f1f3`. Scanner functional
acceptance passes **43 assertions**, including full canonical/displayed data and
logo absence after completed chart rendering. Final four-page acceptance and the subsequent mobile correction are recorded below.

The owner explicitly requested no TradingView logos anywhere. An independent
source audit found two runtime chart constructors. The shared native adapter
already disables the logo (Scanner, Replay and the four replacement pages).
`PositionMiniChart` still inherited the library default; it now explicitly
disables the logo and uses the shared plain-text credit. Its component test
checks both the chart option and credit without images, SVG or canvas. The
empty-position browser fixture does not mount that preview, so this specific
renderer has component/source evidence, not new visual acceptance.
Required text/link attribution remains; it is not an embedded product or a logo.
The pinned [5.2.0 notice](https://raw.githubusercontent.com/tradingview/lightweight-charts/v5.2.0/NOTICE)
and [library logo option](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/LayoutOptions#attributionlogo)
permit this alternative.

Two performance fixes at `cc7ad0e0a1282a51f6ffe6efa369705747af13f4` preserve
unchanged note collections and avoid requesting a drawing repaint for an
unchanged selection. The two regressions failed before the fixes; the focused
lane then passed 14/14. Independent reviews found no remaining blocker. Real
note edits, source/interval changes and drawing/viewport changes still update.

The same hardened diagnostic observed 18 seconds with 200 synthetic bars,
one saved note and one actual browser-local drawing. It checks the active
engine, series and drawing attachment every 100 ms and on wrapped calls, and
restores all instrumentation. These probes are not a continuous execution trace.
Both observations were valid, with unchanged candles, note values and drawings:

| Idle work | Before: `23698959`, build `0b73849de1482966` | After: `cc7ad0e0`, build `0a98f2aa91d46955` |
|---|---:|---:|
| Price-line creation/removal | 39 / 39 | 2 / 2 |
| Repeated selection calls | 40 | 42 |
| Drawing repaint requests | 40 | 0 |
| Drawing view updates | 349 | 3 |

The remaining two line rebuilds are retained, and the original note handle did
change. This proves less unchanged work in that interval, not zero chart work,
an input-speed gain, physical paint timing or sustained 60 fps.

A separate actual-Scanner timing run used 200 synthetic bars, unavailable AI
truth, no active studies/drawings, desktop 1440×1100 and mobile 390×844, Chromium
156 on macOS arm64, 14 reported logical processors, DPR 1, normal/4× throttled
CPU. Our tests/builds and other agent browser work were stopped during timing;
other user applications were not controlled. Each successfully measured control/rate has two passes
of 40 retained measurements plus warmups. p99 is the nearest-rank maximum at
80 samples. Completion means correct context/data/range or disclosure across
two consecutive animation frames, including observer cost; it is not hardware
paint. Native-menu navigation time is excluded from the intended style measure.

| Control group | Before p95, normal / 4× | After p95, normal / 4× |
|---|---|---|
| Zoom in/out, pan earlier/later | 49.0–49.2 / 47.1–47.7 ms | 48.9–49.0 / 46.9–47.9 ms |
| Open/close mobile Tools | 32.7–32.8 / 29.2–29.6 ms | 32.5–32.6 / 29.7–30.1 ms |
| Style bars/candles | 0/80 each; unmeasured | 0/80 each; unmeasured |

All six measured controls/rate have 80 successful samples and none over 100 ms;
the candidate maximum is 54.5 ms. Baseline/candidate differences are small and
mixed, so **no click-speed improvement is established**. Overall timing verdict
is **FAIL / partial**: trusted keyboard input in this headless Mac browser never
committed either native style selection. Pending arms/key events and all skipped
samples remain recorded. Functional style switching is a separate passing test
using programmatic selection and is not substituted for trusted-input timing.

The original failed desktop measurement is retained. The corrected tool isolates
only style-control failures so they do not suppress navigation samples. Candidate
tooling adds a stricter final failure gate after review; this changes verdict
handling only, not sampling, and the baseline was already FAIL. Timing source is
`cc7ad0e0`, before the later mini-chart-logo change; final functional/source checks
are tied to `8e87e55d`. No results are attributed to a different commit.

Follow-up receipts are under [validation/followup](validation/scanner-smart-chart-20261028/followup/),
with full local raw logs in `/Users/areyouok/arx-tier1-release/scanner-performance-20261028/`.
Original failures and all outliers remain. Active reader/owned-position acceptance,
streaming/heavy-history loads, style input latency, calendar intervals and equal-
condition TradingView/MT5 comparisons remain open. No main merge, deployment,
existing database change or broker operation occurred.


### Final functional checkpoint after mobile correction

Final application source is **`e011f25aca6dfd2913dda134ca59c86a5b124a95`**,
immutable fixture **`c4d30f0544b392e4`**. The full dashboard lane again passes
**164 files, 2,328 tests / 9 skipped**, typecheck, production build, **87 guards**
and **7 binding assertions**; **54 tooling checks** pass. Bundle warnings remain.

The actual Scanner passes **43 assertions under synthetic USER**. All four
secondary pages pass **158 assertions under synthetic ADMIN**, the role required
by the legacy manual/AI tester routes. Both fixtures remain frozen, unarmed and
unallocated; manual/automatic trading permissions are false, and every write
receives 503. These are offline UI fixtures, not server authorization tests.
Exact candle/source/context checks, market and interval changes, unavailable
reader truth, mobile disclosure, engine retention and absence of graphic logos
pass. Eight secondary-page screenshots were inspected. Zero page exceptions,
trade requests, unclassified writes or external requests were observed. Expected
blocked/unmocked HTTP errors remain: Scanner 96 console errors / 89 unknown
reads; secondary pages 83 / 77. These do not prove a connected app is error-free.

The first four-page checks exposed two harness assumptions: the native chart
requests 300 bars while the trade panel also requests 200, and `getByLabel`
includes nested option text even though the exact accessible combobox name is
correct. The harness now binds the expected response to its actual endpoint,
symbol, interval and limit before inspecting any displayed array, and uses the
exact accessible role/name. An ordinary USER was also correctly redirected away
from the legacy manual route; this observation is retained, not bypassed in app
code. The explicit ADMIN fixture is separately labelled and checks disabled
account state on every page. An interrupted diagnostic retry is not acceptance.

An earlier ADMIN run passed 142 functional assertions but screenshots showed
13.6 px of horizontal AI Assist chart clipping; it is marked **VISUALLY_INCOMPLETE**.
A reversible CSS probe reproduced the cause: the implicit mobile grid track's
intrinsic minimum exceeded its container. Three page-class changes establish a
shrinking grid column, allow the left column to shrink and wrap its title/selector.
The shared selector and trading logic are unchanged. At a 390 px viewport the
final chart spans x=25–365 and the selector x=49–344. All four final pages pass
full horizontal chart/control bounds, in addition to the older document-width
check. This does not certify every device or every possible chart workload.

[Latest compact receipt](validation/scanner-smart-chart-20261028/followup/latest-summary.json)
and [file hashes](validation/scanner-smart-chart-20261028/followup/manifest.json)
identify the accepted source and retained failures. Timing remains tied to the
older `cc7ad0e0` workload with its explicit FAIL/partial result; these functional
checks do not upgrade missing style-input timing, sustained performance or
TradingView/MT5 parity. Everything remains development-only and unmerged.
