# Smart Chart control placement — 31 October 2026

Status: locally validated usability change; not deployed or imported to Replit. ARX remains NOT COMPLETE. The first-navigation target still fails under slower CPU. No competitor-parity claim.

Tested application: `2f7262980e6be13ccee02c1c4cb65511308a106e`; production offline fixture `07d89bfa924ea08d`. Base: `53203e8693f83bff6ab1af7bc2d2ca7f1813167a` (application `b43b0b9f`). Held toolbar/containment experiments are excluded. This report's commit adds evidence only.

## User-visible changes

Assistant, Search and Quick Actions have 44×44 places in the primary chart header. They no longer float over the chart's tools or pan controls. Their panels retain one instance and their existing behavior; navigating or opening fullscreen does not start voice, send a message or trigger an action. Unsent assistant drafts survive docking and leaving the chart. Other pages retain floating launchers. The dock scrolls with the chart header; it is not a permanently visible toolbar.

Fullscreen comparison temporarily takes the controls and returns them to the primary chart on exit. Search consumes Escape before the underlying fullscreen chart. Quick Actions' own close button remains above its backdrop.

## Validation on the exact application commit

- Frontend: 176 files passed, 1 skipped; 2,565 tests passed, 11 skipped, 0 failed.
- Dashboard typecheck and production build: pass.
- Guards: 87/87. Bridge binding checks: 7/7.
- Desktop 1440×1100 and resized mobile 390×844: all three launchers unique and reachable; search open/close; Quick Actions open/own-button close; assistant draft preserved through fullscreen and Scanner exit; no horizontal overflow; exact canonical/displayed data and engine identity preserved.
- Two-chart layout: fullscreen comparison gets the controls; Escape closes Search only; exiting returns them to primary; both engines and exact data unchanged.
- Browser requests intercepted; assistant services unavailable in fixture. No messages sent, no menu action executed, no broker calls. Synthetic bars retain their existing historical/safe-mode status; this is not validation of feed health or AI analysis.
- Root/backend lanes were not rerun for these frontend-only changes.

| Offline measured action | Attempts | Median | Maximum | ≤100 ms |
|---|---:|---:|---:|---:|
| Zoom, normal CPU | 10 | 48.4 ms | 50.3 ms | 10/10 |
| Zoom, 4× CPU slowdown | 10 | 46.0 ms | 47.2 ms | 10/10 |
| First Scanner navigation, desktop normal CPU | 5 | 40.4 ms | 43.6 ms | 5/5 |
| First Scanner navigation, mobile normal CPU | 5 | 40.0 ms | 92.7 ms | 5/5 |
| First Scanner navigation, desktop 4× slowdown | 5 | 318.2 ms | 331.5 ms | 0/5 |
| First Scanner navigation, mobile 4× slowdown | 5 | 263.4 ms | 284.0 ms | 0/5 |

All 20 navigation attempts are valid data/rendering witnesses; the 10 slowed-CPU samples fail the timing budget. At these small sample sizes nearest-rank p95/p99 equal the maximum and are not robust tail estimates. Normal and slowed runs are separate sequential runs; small zoom differences are not evidence that slower CPU improves performance. Navigation median/max on the earlier accepted source were 39/95 ms desktop and 38.5/82.2 ms mobile at normal CPU. This is not a first-load speedup claim.

Measurement starts at a trusted click, verifies exact source and displayed candles and actual chart/series identity on two consecutive rendering frames, and requires a visible unobscured 100×100 plot region. Zoom additionally verifies range change in the intended direction. Navigation clicks occur within 150 ms of first actionable link with no deliberate dwell, following a full-document reload. Browser resources were initially prepared, intercepted candle delay is 80 ms, historical synthetic sample has 200 candles. Two frames are not physical paint. Resized desktop Chromium is not a physical phone; no real provider, published app, broker or matched TradingView/MT5 timings were measured.

## Failures retained and corrected

- Baseline settled mobile sample: Assistant overlapped Chart tools by 7.73×32 px; Search overlapped Pan by 15×15.5 px. An earlier sample during the old geometry transition is retained separately. Candidate obstruction check showed zero overlap.
- First test used a textarea selector for an actual input. Corrected the harness; retained failure.
- Initial application `06398c79`: typecheck TS7030 on optional layout-effect cleanup; explicit undefined return fixed in `b09c5ccb`.
- Browser at `b09c5ccb`: docked Quick Actions could not close itself because the backdrop intercepted it. Fixed in `6451a29d` and rerun successfully.
- First zoom harness referenced an undefined hardwareConcurrency variable before collecting samples. Corrected to navigator.hardwareConcurrency; failure retained.
- Comparison at `6451a29d`: Escape also exited fullscreen. Fixed in `2f726298`, regression tested and browser verified.
- Prior Replit navigation 0/20 and prior slow-CPU/held performance failures remain open; local normal-CPU success does not replace them.

## Reproduction and evidence

`docs/validation/chart-assistant-dock-20261031/manifest.json` contains per-attempt timing summaries, exact source, checks and hashes of all 74 raw files at `/Users/areyouok/arx-tier1-release/chart-assistant-dock-20261031`. Raw files include failed runs and screenshots. Portable browser runners are alongside the manifest.

At the tested application commit, build/serve the ordinary `scripts/scanner-qa/shared-chart-fixture/build.mjs` fixture. Use a fresh isolated Playwright CLI browser and `setup-preserve-storage.js`, then `functional.js`, `comparison.js`, and `zoom.js`. For first-navigation runs, use a separate fresh browser and the standard `scripts/scanner-qa/shared-chart-setup.js`, then the supplied `navigation-1x.js` and `navigation-4x.js`; these enforce the tested commit. Do not reuse the functional session's blocked assistant requests for navigation acceptance. Keep build/test jobs stopped during timing. The fixture writes durable navigation receipts before/after each measured attempt. Close only owned browser/server processes afterward.

## Limits and next steps

The existing Replit feature import remains busy; this dock has not been sent to it. Retrieve its exact source/checkpoint and validation outcome without interrupting concurrent work. Then consider a selective dock import preserving auth, Truth, trading gates and Replit setup. No publishing or deployment is authorized.

The first actionable Scanner render at slow CPU and on Replit remains a priority. Full keyboard modal/focus behavior, physical touch, large-history frame budgets, full indicator/drawing catalog, replay, alerts, scripts, cloud synchronization and matched competitor workloads remain incomplete. No completion percentage is assigned.
