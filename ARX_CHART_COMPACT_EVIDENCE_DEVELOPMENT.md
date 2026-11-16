# ARX compact evidence — source-only development validation

## Outcome and exact source

Completed the reviewed incremental import and independent offline validation. This is **not runtime activation, a release-green result, first-click acceptance, or competitor parity**.

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `652d49e0ee69fd893e29b24f06c8360119d02d77`.
- Recovery branch: `codex/backup-before-compact-evidence-20261101`.
- Upstream: `portava/arxai`, `codex/chart-compact-evidence-integration-20261101`.
- Exact reviewed head: `b3029eb82f2223a521a66eb33ec1011cf58a483c`.
- Upstream tested application: `31a45ff99bbd4385b1c5f4ad56b0df2cc29a297b`.
- Combined application/QA commit actually tested: `4c36cd5a58243e9bdf7efca734f55caf8b21fec8`.
- Final workspace Git checkpoint is recorded after this report is committed in `generated-artifacts/arx-compact-evidence-validation/final-checkpoint.json` and the completion response. Application, library and script trees must remain identical to the tested commit.

## Reconciliation

The branch ref and saved/application artifacts/lib tree identities were verified remotely. Comparing the pinned base `f419a37b235ad7f7b9d83ac6e7d96fad674251f1` to the saved head found no non-document source changes outside the 15-file manifest. All 15 downloaded target SHA-256 hashes matched.

All eight existing application/test files matched that upstream base exactly. They were replaced with their reviewed target versions; seven previously absent QA/fixture files were added. All 15 resulting hashes match the pinned target. No unrelated ancestry or held performance branch was imported.

The runtime changes are confined to the existing native chart, workbench, watchdog and Scanner header: initial responsive chart height, compact evidence disclosure with active restrictions still visible, truthful source-bound stream eligibility/reset/retry state, and avoiding passive evidence-marker updates when no study consumes them. There is no second chart/study/assistant engine.

Preserved local differences include sign-out/authentication/startup fixes, Replit setup, dependency/lockfiles and test registrations, the corrected actual-app fixture builder and its mode/HTML/asset/source guards, the existing witness/recorder additions, Truth/frozen-result behavior, funds behavior and trading gates. No API or library application source changed in this round. No concurrent file edits were observed before integration or in the clean application checkpoint; Git status alone cannot establish that no external agent exists.

## Independent exact-combined-source checks

All 15 command records have exit code 0. These are this workspace's results, not upstream counts.

| Check | Pass | Fail | Skip / unfinished |
|---|---:|---:|---:|
| Full dashboard frontend | 3,317 | 0 | 11 skipped |
| Targeted offline backend suites | 521 | 0 | 0 |
| Existing navigation-recorder/disclosure tooling | 22 | 0 | 0 |
| New stock fixture/generator/network-boundary tooling | 9 | 0 | 0 |
| Guards | 87 | 0 | 0 |
| Binding assertions | 7 | 0 | 0 |
| Actual Scanner desktop portable journey | 275 | 0 | 0 |
| Actual Scanner phone portable journey | 35 | 0 | 0 |

Backend suite passes, separately retained: backtest 158; Truth component evidence 47; candle shape/evidence 155; quote freshness 57; chart Truth fixtures 52; forming-tip source gate 18; bridge liveness 34.

Workspace/library and artifact typechecks passed. API and dashboard builds passed in the disposable source copy. The ordinary actual-App Scanner fixture build passed separately. No build or typecheck command ran against the original application directories.

The disposable copy contains 7,499 tracked source files, with workspace dependencies redirected into that copy and existing external dependencies reused. Validation child environments contain no workspace credentials; their TCP egress is denied, with local Unix IPC permitted. API tests use mocks and synthetic inputs, not the existing API or database.

## Actual browser evidence

- Frozen actual-App build: `a5222444c85b1953`.
- Browser: headless Chromium `152.0.7977.64`; Node `v24.22.1`.
- Desktop 1440×1100; phone 390×844 CSS pixels, not physical-device acceptance.
- No driver-requested CPU throttling; shared-host contention was not independently controlled.
- Owned Node/Playwright driver, with a 600,000 ms outer deadline. Not a whole-action 45-second BrowserSDK invocation. Both journeys completed once; no retry-to-green.
- Generated journey SHA-256: desktop `0cdec354424b85827d11373b5b09b20675df645997fcebdf37c061644f3aa95e`; phone `7fe56f26bc509c53a0bebd530127501a433a046c57e9f7275cc13cc5035f3a1b`.
- Original normalized synthetic stock fixture SHA-256: `47431eb58f1a539aa84a66461dccd8b95e05cb001186565bfa27c976cb0735df`. Its producer provenance `084a036957cc59f28bb3f364c7b2cc4fd24cd68a` is not the combined application commit.

The unmodified portable journeys reached the actual Scanner and consumed the original AAPL/M15 response. They checked independent bins, total conservation, POC/value area, horizontal geometry, manual/assistant agreement, settings/styles, endpoints/pan/refreeze, multiple profiles, quantity/clock/finality/source withdrawal and forming-tail handling, reload and PNG export. “Backtest this chart” only opened the idea panel; it did not establish historical-calculation acceptance. Stock usage is analysis-only comparison, not expansion of primary Focus or trade permissions.

The phone journey verified chart fit and at least 100 pixels of actual plot visible with the compact assistant open. Its PNG was visually inspected: prices/profile and delayed/not-AI labels were readable, with microphone/input/send/expand/close controls visible. The assistant still covers part of the plot; this is **not full unobscured-chart acceptance**.

Desktop: 295 API requests = 107 synthetic GET 200, 179 explicitly unavailable GET 503, nine blocked POST 503. Phone: 64 = 21 synthetic GET 200, 40 unavailable GET 503, three blocked POST 503. All 12 background POST attempts were blocked (alert scan, scalp focus, activity ping); none reached an API. Both strict boundary checks passed with zero external-origin/WebSocket attempts and zero page errors. The 188 desktop and 43 phone console errors were retained 503 resource-load messages, not hidden or classified as passing API behavior.

The profile remains an estimated uniform OHLC allocation of declared trade units, not transactions-at-price, proof of shares, complete-market volume or order-flow authority. Original session-gap flags were retained. No real provider, broker, model, account or database was used.

## Failed attempts and retained limitations

There were no failed assertions in the 15 validation commands or the two portable journeys. Preparation errors were not erased:

1. A bulk file callback exhausted its 3 MB budget after partial new-file creation. Remaining files were copied from already hash-verified candidates; all 15 final target hashes were checked before the application commit.
2. An optional read-only `/proc/net/tcp` inventory was unavailable. `ps` identity/start snapshots were used instead; this did not restart or activate anything.
3. The final documentation staging command initially hit Replit's Git scrutiny guard. Its explicit per-command Git flag was used to save the already authorized checkpoint; no lock was deleted or history reset.
4. The auxiliary screenshot service returned HTTP 500 when asked to capture an image-only loopback endpoint. This was a tool failure, not an app HTTP 500. The Playwright-generated PNGs exist and were visually inspected; no screenshot-service success is claimed.

Earlier failures remain historical evidence, including prior incomplete USER-fixture routing/metadata attempts, the stock-producer 0/300 failure, composer focus loss, the unrecoverable 45-second isolated benchmark attempt, partial visibility, M2/no-data and inconclusive zoom/pan, hydration warnings, legacy-page 404s and ordinary automatic-alert POST limitations. The new portable journey supplies new positive analysis-only stock/profile evidence; it does not rewrite those older receipts or resolve unrelated cases.

No new first-navigation or zoom timing acceptance was run. Preserve the previous 0 valid / 1 invalid / 9 unstarted result (1393 ms readiness, 239.3 ms source-correct completion), 0 valid / 4 invalid / 16 unstarted, the earlier 40 invalid slots, sustained-zoom timeouts and slowed-touch failures. The reviewed source's own 4× CPU first-click target still failed; no remote speedup, immediate loading, physical paint, launch readiness or TradingView/MT5 parity follows from these functional checks.

Real-user sign-in, current provider timing/volume/UTC authority, unresolved composer-focus and broader historical research journeys were not rerun. No production adapter's UTC authority is fabricated. The older running API may lack optional evidence required by the newer source; that evidence must remain unavailable.

## Runtime preservation and cleanup

`runtime-preservation.json` verifies the original API PID **425**, start **Sun Nov 1 04:00:53 2026**, unchanged. All **11 API dist** and **305 dashboard dist** file hashes and path sets are identical before/after: no replacement, additions or deletions. Compiler outputs/cache metadata were generated only in scratch; no hash-preservation claim is made for other unbaselined caches.

No app/API/frontend workflow was started, restarted, refreshed or activated; no service setting or running bundle was replaced. Only owned loopback validation/image servers and fresh fixture browsers were created, and all were closed afterward. No operational worker/settlement/trading/email activation, database change/migration, funds movement, orders, broker tests, external calls, main merge or publishing occurred. Source and running-bundle acceptance remain distinct.

## Exact retained paths

- Reviewed guides/manifests: `arxai/docs/SMART_CHART_COMPACT_EVIDENCE_2026_11_01.md`, `arxai/docs/development-sync/CHART_COMPACT_EVIDENCE_2026_11_01.json`, `arxai/docs/development-sync/CHART_COMPACT_EVIDENCE_VALIDATION_2026_11_01.json`.
- Root evidence: `generated-artifacts/arx-compact-evidence-validation/`.
- Source proofs: `baseline.json`, `upstream-verification.json`, `download-audit.json`, `local-overlap.json`, `integration-audit.json`, `runtime-preservation.json`.
- Commands/logs: `combined-results.json`, `combined-0.log` through `combined-14.log`; `preparation-results.json`.
- Browser full records: `browser-desktop/journey-result.json`, `browser-mobile/journey-result.json`; each directory's `driver-start.json`, `driver-runtime.json`, `driver-terminal.json`, `driver.log`, `provenance.json` and immutable `browser-journey.js`.
- Images: `browser-desktop/profile-export.png`, `browser-mobile/phone-profile.png`, plus the timestamped manual/profile-VWAP PNGs in those directories.
- Final inventory/checkpoint: `receipts-sha256.json`, `final-checkpoint.json`.
