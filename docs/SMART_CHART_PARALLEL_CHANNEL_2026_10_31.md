# Smart Chart parallel-channel drawing

Application **b107f1db1da17502ab978fccefee9f162efff8f4**, final measurement tooling **264e53d16f90f65835aeb22ee7257aa71e83fa2c**, branch `codex/chart-parallel-channel-20261031`, based on price-only-scale backup76f66280. Actual Scanner production fixture **b4b5b7945ebbe212**. No main merge, deployment, existing database changes, workers/trading or broker tests. Not installed in Replit.

## Comparison and scope

TradingView's [parallel channel](https://www.tradingview.com/support/solutions/43000518117-parallel-channel-drawing-tool/) provides channel geometry and coordinate editing; MT5 lists [equidistant channels](https://www.metatrader5.com/en/terminal/help/objects/channels) with parallel lines, and its [object reference](https://www.mql5.com/en/docs/constants/objectconstants/enum_object/obj_channel) describes three anchors and optional left/right extension. Official sources inspected31October2026. These are capability references, not measured competitor performance.

ARX previously had no channel drawing. It now supports three-point placement: two different candles establish a baseline, the third candle/price sets the parallel boundary. The two boundaries are finite over the baseline's endpoints. Three handles allow independent baseline/width edits; whole-object movement shifts all anchors through real candle indices. No weekend timestamps or market prices are invented. Exact stored prices, colour, width, dash, locking, hide/show, delete, undo/redo and context-specific local persistence use the existing Objects system. Cancelling a partial placement writes nothing. Channels are manual analysis annotations, not automated recommendations or executable orders.

Projection occurs before parallel offset calculation, keeping the displayed boundaries parallel in regular, logarithmic and inverted price scales and across irregular time gaps. All three anchors must have loaded source candles before geometry appears. The third point may reference the baseline's extrapolation outside its finite endpoints; it does not extend the drawn boundaries. Channels add no market series or autoscale extent.

Still open: ray extensions, fill, midline/additional levels, regression/Fibonacci channels, cloud/cross-account workspaces, physical touch validation and matched competitor interaction/performance. No full channel parity claim or scope exclusion.

## Evidence

- New regressions before implementation: **4fail/50pass**. Final focused workspace/primitive/editor/controls: **55pass**. Covers malformed/missing anchors, non-degenerate baseline, regular/log/inverted parallelism, unloaded third anchor, independent width movement, real-bar whole-object translation, one commit per drag, cancellation rollback, locks, three-click creation, no early persistence, undo/reload.
- Exact applicationb107f1db: **2,555frontend pass/11skip/0fail**,174filespass/one opt-in benchmark file skipped; dashboard typecheck/build,87guards and7bindings pass. Final264e53d1 changes the browser wait only; application unchanged. No full root/backend/database lanes run.
- Final actual-Scanner browser: **20/20trusted placements** across mouse/emulated touch and1x/4xCPU. Each channel's anchors, two actual last-rendered strokes, matching slopes, unchanged full source/display OHLC, chart/series identity and horizontal range are checked over two frames. Partial placements never commit. Width-handle drag changes only the third anchor; one undo restores the original;20channels/40strokes stay parallel on log scale and reload with the exact source data. Source-aware waiting is mandatory: stored object count alone cannot prove rendered completion.

| Final264e53d1,5samples per condition | Median third-press to two-frame completion | Maximum |
| --- | --- | --- |
| Mouse,normalCPU | 28.7ms | 30.8ms |
| Emulated touch,normalCPU | 73.7ms | 76.6ms |
| Mouse,4xCPU | 24.2ms | 33.6ms |
| Emulated touch,4xCPU | 76.4ms | 84.7ms |

Start is the trusted third pointer press, including its release; completion verifies actual adapter geometry after rendering, not only button state. Native pointer points are checked unobscured before placement. Five samples per condition cannot establish a stable p95/p99 or a general responsiveness guarantee. The browser reports HeadlessChrome156,Macintosh-compatible user agent,14logical processors,DPR1,1440x1100visible viewport. User-agent architecture is not proof of physical CPU architecture. No build/test jobs ran during final timing. Emulated touch is on this desktop viewport, not a mobile-layout or physical-device result. Two frames are scheduling opportunities, not physical paint or sustained60fps. No real feed/AI reader/broker measurement.

Earlier run retained: all20placements,edit/log checks completed, then the reload assertion failed because it checked20saved objects while candle count was still0 and strokes0. A read-only follow-up found200bars/40strokes with unchanged saved objects. The harness now waits for exact source/display data and completed geometry before checking reload. The application did not change for this repair. The failed run is not described as a full pass. All timing outliers and intermediate receipts remain.

Final diagnostics:85requests,54unknown reads,5blocked requests,59HTTP-denial console errors,0page exceptions. All external traffic and API mutations denied; not an error-free production console. First-channel screenshot inspected; synthetic historical source remains explicitly in safe mode. Owned browsers/servers closed. Local code review covered all three anchors across persistence, projection, drag/cancel and UI state; no independent-agent review requested.

Receipts and SHA-256 inventory: `docs/validation/chart-parallel-channel-20261031/manifest.json`. Documentation changes no checked application code.

## Integration and next work

Replit's preceding idle-loading update is now complete at applicationf3467de7c5f60038a139a60f00abe56d563f0cc4/checkpointcaf608b984e2d62d52d5a79b1ea69903efad07dd. Its tests pass, but all20immediate navigation attempts fail:ready-to-click666.6–796.6ms exceeds150ms and completion122.0–181.5ms exceeds100ms. Prefetched candles finished530.8–676.2ms before click. The1500ms-idle run timed out after45seconds without persisted samples; incomplete, not passed. Its different-source/environment results do not inherit the Mac's earlier passing measurements.

Read-only diagnosis of those saved Replit timings is pending. Next: retain the real remaining navigation delay, inspect module/actionability/rendering evidence, recover or preserve timeout partials, then selectively integrate tested price-only scaling/channel changes while preserving Replit-local fixes and checking the exact resulting source. All original heavy-history/replay, real-provider, physical-device and broad TradingView/MT5 comparison gaps remain. Architecture not complete; release not green.
