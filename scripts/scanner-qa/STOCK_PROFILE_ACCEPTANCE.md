# Offline Scanner stock / Volume Profile acceptance

These journeys run the actual Scanner page, comparison picker, native chart,
manual settings, selected-pane assistant and research controls. They do not
import a second production calculator or change the application. An independent
O(bars × rows) test reference checks the real profile's bins, total, POC and value
area against the original synthetic provider response.

`shared-chart-setup.js` remains the single request boundary. Its optional hooks
provide the stock response and local conversation reads; all non-GET API calls,
external origins and websockets stay blocked. Existing callers without hooks
retain their prior data and behavior. A fulfilled response receipt is recorded
only after `route.fulfill` resolves, with a unique request ID. Source-change
checks require the exact AAPL/M15 **limit=300** response, successful fulfillment,
an advanced actual adapter data revision and the expected installed state.

## Run

Use installed repository dependencies and an installed `playwright-cli`. No
package install, application API, provider or broker is required. From a clean
checkout, build and serve the existing frozen actual-page fixture:

```sh
node scripts/scanner-qa/shared-chart-fixture/build.mjs
node scripts/scanner-qa/shared-chart-fixture/build.mjs --serve=BUILD_ID_FROM_OUTPUT
```

The server listens on `http://127.0.0.1:4199`. In another terminal generate one
new output directory per journey/run; generation deliberately refuses to
overwrite a prior directory, including a failed run:

```sh
node scripts/scanner-qa/prepare-stock-profile-acceptance.mjs /absolute/new-run-directory desktop
playwright-cli -s=arx-profile-desktop open
playwright-cli -s=arx-profile-desktop run-code --filename=/absolute/new-run-directory/browser-journey.js > /absolute/new-run-directory/cli.log 2>&1
playwright-cli -s=arx-profile-desktop close
```

Use `mobile` in place of `desktop` with a separate session/output directory for
the accepted 390 CSS-pixel comparison journey. Close only the session and static
server started for this run. The generator does not start either process.

The CLI log's `### Result` JSON is the acceptance result. An exit status alone is
insufficient: require no `error`, every `checks[].pass` true, matching runtime and
manifest build IDs, clean recorded source, and no browser exceptions/external
requests/model or order writes. Retain the whole log, screenshots, exported PNG,
provenance JSON and unsuccessful attempts. The desktop export still needs human
visual inspection; downloading a PNG alone does not prove its pixels or labels.
Diagnostic/profiling builds are rejected. Both journeys share one strict network
validator: only blocked HTTP 503 POSTs to `/api/me/activity-ping`,
`/api/me/chart/ai-alerts/scan` and `/api/me/scalp/focus` are expected. Every other
write, websocket or external request fails acceptance. Unavailable GET reads are
retained in the raw log. If the page disconnects during failure diagnostics,
already accumulated checks and receipts survive alongside collection errors.

## Provenance and boundaries

`fixtures/stock-normalized-20261101.json` is preserved **byte-for-byte**, SHA-256
`47431eb58f1a539aa84a66461dccd8b95e05cb001186565bfa27c976cb0735df`.
It records synthetic Twelve Data AAPL/M15 responses passed through backend
commit `084a036957cc59f28bb3f364c7b2cc4fd24cd68a`. The original normalized flags,
including seven session-gap `STALE_FROM_PREV_TF` rows, remain present. Its
research market evidence is null, feed is not live-confirmed and AI entry use is
false. Never rewrite its symbol, timeframe, prices, time basis or flags to make a
journey pass. The primary EURUSD tick-only data is separately constructed and
does not represent a provider qualification receipt.

The quantity, missing-volume, source-identity, clock, finality and symbol-mismatch
variants are explicit mutations of cloned normalized responses for client
robustness testing. They are not evidence that an upstream producer supplied the
mutated data. Volume Profile is uniform OHLC allocation, not observed
transactions-at-price, bid/ask order flow, complete-session or lower-timeframe
coverage. This suite does not measure navigation speed, physical paint, live
readiness or TradingView/MT5 parity.

## Retained prior failures

The accepted desktop journey originated in the local 2026-11-01 profile
validation, whose report remains `docs/SMART_CHART_VOLUME_PROFILE_2026_11_01.md`.
Its earlier unsuccessful attempts remain part of the evidence:

1. Original session-gap flags exposed a product mapping issue; the engine was
   corrected. The fixture was not stripped of those flags.
2. The endpoint selector needed focus to populate the existing bounded choices.
   The journey now performs that real user action before selection.
3. Source-change waits matched another reader's request before the actual
   comparison had installed its response.
4. A request-start observation was mistaken for a completed comparison poll.
   Exact limit=300 matching and adapter revision checks corrected both poll
   races; this portable package further requires exact response ID and fulfilled
   status, excluding cancellation.

Prior accepted browser results apply to their recorded application/build only.
This packaging change needs a fresh desktop/mobile run before claiming portable
browser acceptance. Static tooling checks prove composition and boundaries, not
the application journey.

```sh
node --test scripts/scanner-qa/stock-profile-fixture.test.mjs scripts/scanner-qa/shared-chart-tooling.test.mjs scripts/scanner-qa/shared-chart-storage-reload.test.mjs
```
