# Actual Scanner / shared Smart Chart acceptance

This fixture imports the real dashboard `src/main.tsx`, including its App,
routes, authentication gate and providers. It adds the fixture-only adapter
observer before mounting. It does not replace the Scanner, chart, API hooks or
truth hooks. It uses an isolated Vite production configuration and output; it
is not the deployable dashboard bundle.

Tailwind's default scan base would be the small fixture folder. A fixture-only
pre-transform appends an explicit dashboard `src` source to the real imported
stylesheet, before Tailwind compiles it. The build then requires representative
layout and visibility utilities. No application stylesheet is edited.

Build from a clean committed checkout, then serve the returned build ID:

```sh
node scripts/scanner-qa/shared-chart-fixture/build.mjs
node scripts/scanner-qa/shared-chart-fixture/build.mjs --serve=BUILD_ID
```

The server listens only on `127.0.0.1:4199`. It cannot proxy an API, and returns
503 for unhandled API calls or writes. Each build gets a new ignored directory,
source commit/status, runtime marker check and asset SHA-256 manifest. Serving
checks every recorded asset. It never empties or overwrites dashboard `dist`.
The fixture entry embeds an immutable build ID; acceptance requires the ID in
the executing page to match the fetched metadata, so a newer metadata file
cannot validate an older open page.
Close the server after the check. Do not start it during another agent's timing
window.

In a **new isolated Playwright CLI session**, run these two arrow-function
scripts sequentially:

1. `scripts/scanner-qa/shared-chart-setup.js`
2. `scripts/scanner-qa/shared-chart-acceptance.js`

For example, following the local Playwright CLI skill:

```sh
playwright-cli -s=arx-scanner-shared open about:blank
playwright-cli -s=arx-scanner-shared run-code --filename=scripts/scanner-qa/shared-chart-setup.js
playwright-cli -s=arx-scanner-shared run-code --filename=scripts/scanner-qa/shared-chart-acceptance.js
playwright-cli -s=arx-scanner-shared close
```

Preserve both complete outputs and generated screenshots. The acceptance
script returns failures and partial evidence; **CLI success is not PASS**.
Inspect its `passed`, `failure`, `networkFailure` and full `network` fields.
Optional evaluator bindings are `SCANNER_QA_BASE_URL` (loopback only),
`SCANNER_QA_EXPECTED_COMMIT` and `SCANNER_QA_OUTPUT_PREFIX` (existing parent
directory). No evaluated bindings are needed for the default server.

The setup labels historical data synthetic, provides disabled account gates
and unavailable analysis truth, and intercepts every HTTP request. It blocks
external HTTP, WebSockets and every write, including the app's presence ping
and scheduled chart AI-alert scan. Those two exact POST routes are recorded
as blocked background attempts; they never reach a server.
The exact `POST /api/me/scalp/focus` is separately recorded as blocked analysis.
`EleanorScalpFocusCard.tsx` invokes it on symbol/mode changes; `meScalp.ts` calls
`evaluateScalpForSymbol`, which gathers read inputs and returns analysis with
advisory traces. It is not an order route. It still receives 503 in this fixture;
this classification does not authorize running the analysis or its traces.
Unknown API reads return 503 and remain in the report; they are not fabricated
as valid data. Known trade routes and other unclassified write attempts, external attempts
and page errors fail acceptance independently. `noTradeRequests` describes the
trade-route classification; `noWritesBeyondKnownNonTradingRequests` covers all
unclassified writes too. No order control is clicked.

Acceptance requires the shared chart inside the actual Scanner, no old Scanner
renderer or embedded widget, exact full canonical **and real displayed** OHLC
arrays after selection/timeframe changes, and visible canvas geometry. It
rechecks both arrays and the full series context after the rendering opportunity,
not just when the initial polling predicate succeeds. It awaits the expected
response on the runner side and passes it to a synchronous
browser predicate: the installed runner can mistakenly treat an async false
predicate's Promise as truthy. A missing response times out instead of passing.
Mounted canvas dimensions are distinct from viewport visibility; the desktop
screenshot separately requires at least a 100 by 100 pixel plot intersection.
It checks actual logical ranges after zoom, pan buttons, keyboard and pointer
drag; mobile disclosure must preserve engine identity and canonical data.
The new reader must explain unavailable truth rather than claim a ready read.

This is a bounded functional check. It does not establish latency, hardware
paint, active automatic-analysis performance, broker correctness, production
readiness, or TradingView/MT5 parity. It deliberately fails on the old Scanner
until the shared-chart integration lands. Source and screenshots must be tied
to the integrated build actually checked.

Tooling checks (no browser/build required):

```sh
node --test scripts/scanner-qa/shared-chart-tooling.test.mjs
node --check scripts/scanner-qa/shared-chart-fixture/build.mjs
node --check scripts/scanner-qa/shared-chart-setup.js
node --check scripts/scanner-qa/shared-chart-acceptance.js
```

## Secondary-page acceptance (separate result)

The exact static SPA route list also includes `/live-chart`, `/live-manual`,
`/live-ai-assist` and `/live-ai-auto-test`; no general navigation fallback or API
proxy is added. After the same setup, run
`scripts/scanner-qa/shared-chart-pages-acceptance.js` in its own fresh session.
This loads every real page, checks the executing build, obtains fresh page
response evidence bound to the chart request (including its 300-bar limit,
separate from 200-bar truth/ticket requests), and verifies full canonical/displayed candles after market
and interval changes. It records desktop/mobile chart screenshots and checks
the mobile disclosure without touching order controls.

It only clicks chart controls plus AI Assist's GET-only Analyze action. The
M5 chart must remain separate from the explicitly labelled M15 AI read, whose
synthetic WAIT response must expose no approval button. Manual review remains
unopened; audit-loop Start is never clicked and the loop stays stopped. Review
and Start controls may be enabled by the existing page semantics; this does not
mean live permission is granted. This test does **not** execute server risk
gates, test authorization for other roles, or prove that every control is disabled.
Tester intent submissions count as forbidden write attempts as well as live
orders. All existing request barriers remain in effect across navigation.

The four-page result is independent from the Scanner result. Prepared scripts,
helper-test success and a successful browser CLI exit do not mean these pages
passed; inspect `passed`, every page record, failures, screenshots and network.

```sh
node --test scripts/scanner-qa/shared-chart-pages-acceptance.test.mjs
node --check scripts/scanner-qa/shared-chart-pages-acceptance.js
```


## Timing and idle-work diagnostics

After fresh offline setup, `shared-chart-latency.js` measures the actual Scanner
at desktop/mobile sizes and normal/4× CPU. It retains 80 measured samples per
control, warmups, missing/failed actions, pending input and outliers. Use a quiet
window, verify the executing build, and report completed chart state separately
from control acknowledgement. The extra frame is a rendering opportunity, not
physical paint. Inspect every control: native style selection may be unsupported
by the runner; those controls stay incomplete and the overall result stays FAIL.
A programmatic selection is allowed only for preparation/recovery outside timing.

For a separate idle-work comparison, in a fresh session run
`shared-chart-idle-setup.js` **before** `shared-chart-setup.js`, then
`shared-chart-idle-observer.js`. The fixture supplies one synthetic saved note;
the observer places one local drawing and counts work for 18 seconds. It checks
current engine/series/attachment ownership, full data and note values, and restores
all instrumented methods. Only `valid:true` receipts can support a work-reduction
claim. Note-handle churn is reported independently. Counts do not measure latency.

```sh
node --test scripts/scanner-qa/shared-chart*.test.mjs
```

## Durable first-navigation receipts

`shared-chart-first-navigation.js` uses a fixture-only journal in addition to its
returned report. The loopback fixture server prints its receipt directory:
`scripts/node_modules/.scanner-shared-chart-qa/BUILD_ID-navigation-receipts/`.
Each run gets a new private `.jsonl` file. The ten-attempt plan, each pending
attempt, each collected result (including failures), and final summary are
appended and flushed before acknowledgement. This survives loss of the browser
or outer runner. Writes take place before document navigation and after measured
completion, never during the measured click-to-chart interval. A write failure
stops the run; it cannot silently turn missing receipts into success.

The runner uses its direct HTTP request context to the exact loopback journal
endpoint with an ephemeral server token. The endpoint rejects browser-originated
requests. Application HTTP/WebSocket interception and all trading barriers stay
unchanged. No application server, application database or application route is
involved. The receipt directory is outside the immutable build asset directory.

Recover after interruption, even after stopping the server:

```sh
node scripts/scanner-qa/shared-chart-fixture/navigation-journal.mjs /absolute/path/to/RUN_ID.jsonl
```

A started attempt without a result means **incomplete**, not zero attempts and
not PASS. Recovery rejects malformed/truncated records, mismatched source or run
identities, out-of-order results and premature completion. A complete journal
still carries the original measured verdict; recovery itself is not a new test.
Archive the complete receipt directory before removing the checkout or container.
The journal is not resumable after a server restart; use a fresh run and retain
both files. It cannot survive deletion of its filesystem.

The report now records browser version, viewport/UA, runner call timestamps,
link bounds changes, long tasks, frame gaps, and browser Resource Timing for
candles/modules/styles. Diagnostic arrays are bounded and disclose overflow.
Mock `ended` timestamps mean response preparation before `route.fulfill`, not
browser receipt. Even browser `responseEnd` does not prove JSON parsing or query
cache readiness. Link visibility is not the complete Playwright stability check.
These observations locate delays; overlap alone does not prove causation.
Diagnostics add observer cost; do not silently compare this harness with old
measurements as though instrumentation were identical. The 100 ms completion and
150 ms immediate-click gates are unchanged. Record external throttling/load and
outer runner timeout separately; the harness cannot infer them.

```sh
node --test scripts/scanner-qa/shared-chart-first-navigation.test.mjs scripts/scanner-qa/shared-chart-fixture/navigation-journal.test.mjs
```
