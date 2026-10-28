# Actual Scanner / shared Smart Chart acceptance

This fixture imports the real dashboard `src/main.tsx`, including its App,
routes, authentication gate and providers. It adds the fixture-only adapter
observer before mounting. It does not replace the Scanner, chart, API hooks or
truth hooks. It uses an isolated Vite production configuration and output; it
is not the deployable dashboard bundle.

Build from a clean committed checkout, then serve the returned build ID:

```sh
node scripts/scanner-qa/shared-chart-fixture/build.mjs
node scripts/scanner-qa/shared-chart-fixture/build.mjs --serve=BUILD_ID
```

The server listens only on `127.0.0.1:4199`. It cannot proxy an API, and returns
503 for unhandled API calls or writes. Each build gets a new ignored directory,
source commit/status, runtime marker check and asset SHA-256 manifest. Serving
checks every recorded asset. It never empties or overwrites dashboard `dist`.
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
Unknown API reads return 503 and remain in the report; they are not fabricated
as valid data. Known trade routes and other unclassified write attempts, external attempts
and page errors fail acceptance independently. `noTradeRequests` describes the
trade-route classification; `noWritesBeyondKnownBackground` covers all other
writes too. No order control is clicked.

Acceptance requires the shared chart inside the actual Scanner, no old Scanner
renderer or embedded widget, exact full canonical **and real displayed** OHLC
arrays after selection/timeframe changes, and visible canvas geometry. It
checks actual logical ranges after zoom, pan buttons, keyboard and pointer
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
