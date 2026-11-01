# Native drawing and editing increment — 1 November 2026

Application commit: `d09c82eb106b9d478ca6b2e7a2944112954e3076`, on the combined personal-account/native-study checkpoint `44b59dc0`. Development only; not deployed, not release-green, and not the registered Scanner engine. Earlier financial improvements remain included but were not revalidated against a broker in this increment.

## Delivered behavior

ARX's existing drawing geometry and Canvas painter now live in a vendor-independent module. The current Lightweight Charts primitive delegates to that same module, preserving its public exports. The native viewport reuses it for the existing ten drawing kinds: horizontal/vertical lines, trend lines, rays, extended lines, rectangles, Fibonacci retracements, text notes, parallel channels and price/time rulers. Hidden/locked objects, selection handles, notes, labels and exact loaded-time anchors remain governed by the existing validators. Horizontal levels remain price-only after their original time leaves the window. Source/proposal metadata is cloned rather than replaced with renderer-derived claims.

The native viewport uses the existing local drawing editor for placement, selection, drag previews, one completed commit, cancellation, delete and undo/redo callbacks. Projection maps CSS-scaled input to the price plot; auxiliary panes and axis gutters cannot become price anchors. Snapping uses canonical OHLC, including under Heikin Ashi, log, percent, indexed and inverted display. Drawings do not invent missing bars or expand the price scale. PNG export includes the same rendered layers.

During an edit, incoming candles continue updating while the price transform stays fixed and timestamp-based history rebasing retains the horizontal origin. If original or preview anchors disappear, history becomes disjoint/empty, or a trim forces the visible range to clamp, the edit cancels without committing shifted geometry. Explicit view/scale/style/resize/context changes also cancel. Context reset clears old objects and handlers; teardown removes the editor and pending paints.

Shared editor lifecycle checks prevent owner callbacks from resetting/replacing a chart and then continuing an old gesture. Controlled React selection refreshes have an explicit stable owner token, tied to the mounted adapter, epoch and drawing namespace. Matching owner/selection/snap updates preserve the gesture and its captured commit callback; a changed owner or explicit reset cancels. This is wired into the existing chart workbench, not only the laboratory. Drawing inputs and callback payloads are copied to prevent caller mutation from changing an in-progress edit.

## Exact-commit validation

| Check | Result on d09c82eb |
| --- | --- |
| Full dashboard suite | 4,230 passed, 12 skipped, zero failed; 243 passing files, two skipped |
| Focused workbench/editor/painter/native drawing and viewport suite | 192 passed; overlaps full suite |
| Dashboard typecheck and production build | Pass; existing chunk/module warnings retained |
| Architecture guards | 85/87; existing 38 wording and three internal-name findings remain |
| Native drawing browser acceptance | Seven groups, zero page errors |
| Existing native viewport browser acceptance | 13 groups, zero page errors |
| Existing native study browser acceptance | Seven groups, zero page errors |
| Native laboratory bundle audit | Zero Lightweight Charts/TradingView runtime inputs |

Guard failure blocks are not byte-identical: eight workbench line numbers move by three lines and the product-file scan count increases by one. The findings are identical after normalizing only line numbers and that count. This remains a failing guard result, not an exemption or release pass.

Browser checks used localhost synthetic observations, desktop 1280px and mobile 390px/DPR2. Trusted mouse and touch editing, live fixture replacement during drag, price-pane-only placement, transformed display, PNG, reset and existing navigation/study behavior passed. Desktop and mobile images were inspected. The initial browser console includes a favicon 404; final acceptance captures no JavaScript page errors. The native bundle is vendor-free; the full application still contains its current external renderer.

Independent reviews and tests found and closed original-anchor trimming, callback reentrancy, release-time placement replacement, controlled-selection cancellation, and Canvas nested save/restore cleanup issues. Fail-before logs are retained. The initial viewport run's 51 missing-method failures occurred before the parallel editor API landed; they are intermediate integration failures, not 51 independent runtime defects. Two local harness-write attempts used the wrong working directory, the first local server bind lacked permission, and an unrelated git inspection ran outside the repository; these tool errors made no application changes. Later runs and permissions resolved those setup errors.

## Repeatable local performance

Checked-in harness: `scripts/scanner-qa/native-drawings-timing.js`. Fixture: 20,000 loaded synthetic bars, approximately 200 visible, five existing studies, 40 drawing objects. Four counterbalanced runs (normal, 4x CPU, 4x CPU, normal), after other owned tests/builds stopped. Each run retains 15 range warmups plus 75 measured samples, and five history-replacement warmups plus 20 measured samples. All samples and outliers remain in the receipt.

| Run | Range request → RAF Canvas submission p95 / max | Full-history preparation p95 / max | History request → RAF submission p95 / max |
| --- | --- | --- | --- |
| Normal 1 | 18.3 / 19.7 ms | 8.0 / 8.1 ms | 17.0 / 17.1 ms |
| 4x CPU 1 | 18.5 / 19.0 ms | 34.6 / 35.8 ms | 41.5 / 42.4 ms |
| 4x CPU 2 | 18.8 / 21.9 ms | 33.2 / 35.2 ms | 39.6 / 42.4 ms |
| Normal 2 | 18.6 / 20.6 ms | 7.6 / 7.6 ms | 17.0 / 17.7 ms |

Table excludes labeled warmups only. Across all warmups, history preparation reaches 42.9 ms and request-to-RAF reaches 50.2 ms. The fixture deliberately includes overlapping objects; it measures their processing, not a recommended readable layout. These are local Canvas-submission measurements, not physical presentation, trusted click latency, real Scanner navigation, feed latency, or competitor timing. Full-history replacement still exceeds a 16.7 ms frame budget on the simulated slower CPU. Earlier five-study first-setup and real Scanner first-click failures remain open; no speedup or parity is inferred from this separate fixture.

## Remaining requirements

The native viewport is still not a complete `ChartEngineAdapter`. Scanner overlay leases, automatic structure/pattern/annotation layers, live-price affordances, analysis focus, replay/linked views, history callbacks, all app surfaces and default-engine migration require integration and acceptance. Axis dragging and other verified TradingView/MT5 comparison gaps remain. No branding removal, default-engine swap or actual Scanner performance acceptance is claimed here.

Full root CI/backend/database checks were not rerun for this frontend-only increment. No main/PR merge, Replit update, deployment, existing-database migration, trading/worker activation or live/demo broker test occurred. The prior goal turn restated status and was **no progress**; this turn revalidated the checkpoint and made implementation, review, acceptance and performance progress. The original architecture/chart objective remains active.

Raw receipts: `/Users/areyouok/arx-tier1-release/native-chart-drawings-20261101/`. Repository archive and hash manifest: `docs/validation/native-chart-drawings-20261101/`.
