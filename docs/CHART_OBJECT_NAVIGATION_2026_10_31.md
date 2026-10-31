# Smart Chart object navigation — 31 October 2026

Accepted locally, not imported to Replit or deployed. Architecture and instant first navigation remain incomplete.

Tested application: `f1fc30925e43d301cb9101477c6c7918533da7f4`, branch `codex/chart-object-navigation-20261031`. Parent: `773c28de2176513fc498009f2b70d2c98660a14a` (accepted source-binding work). Production-runtime offline fixture: `5317929c7cab3a18`, source unchanged and clean. Initial implementation: `97929738`; final follow-up brings the plot into view. These commits include no held performance experiments.

## Behavior

The Objects list now provides **Go to start** for each saved drawing. It uses the existing source-bound UTC-time navigation to center the first loaded candle at or after the start anchor. Search preserves original object numbering. Successful navigation selects visible drawings, closes Objects, and returns keyboard focus to this chart's plot with an immediate scroll into view. The native chart and private replay supply their own plot references.

Drawing anchors, visibility, locking, stored data and undo history are unchanged. A locked drawing can be navigated to. Hidden drawings remain hidden, with an explicit message. Navigation does not promise that a drawing's price is on screen: the message explains that the price can remain outside the visible scale. The underlying chart may autoscale normally when the visible time range changes.

Unavailable engines/candles disable the control. An unloaded anchor reports the limitation without claiming success or changing focus/range. Replay reports the revealed-window limit instead of offering unrevealed future bars. It does not seek the replay cursor forward to satisfy the jump.

## Competitive scope

[MetaTrader 5's official object-list documentation](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list) describes moving the chart to a selected object. This closes part of that workflow gap in ARX: direct navigation to the loaded start anchor. It does not yet provide automatic whole-object/price fitting, fetching an arbitrary unloaded anchor, object naming, grouping, or layer ordering.

[TradingView's Advanced Charts object-tree documentation](https://www.tradingview.com/charting-library-docs/latest/ui_elements/object-tree/) documents managing visibility and removing drawings, indicators and symbols. ARX's drawing-only list is narrower. This is a documentation-based comparison, not a measured TradingView/MT5 performance comparison. No parity claim.

## Checks on the final application commit

- Frontend: **2,590 pass, 11 skipped, 0 failures**; 178 files passed and one skipped.
- Dashboard typecheck and production build: pass.
- Safety guards: **87/87**; bridge bindings: **7/7**.
- Six added checks cover filtered/locked navigation with no edits or undo entry; focus/closure only after success; unloaded history; global and individual hiding; unavailable engine/candles; replay-window limits. The first four fail on the unchanged baseline (29 prior checks pass). The two follow-up tests were added during self-review.
- Root CI, backend and database integration: not run for this frontend-only change. Review was self-review, not an independent agent review.

Retained preparation failure: the first full run on `97929738` passed 2,589 frontend tests, build and guards but failed typecheck because the new checkout lacked generated domain declarations (`TS6305`, followed by inferred-type errors). Building the existing domain project corrected the environment. The full final run above passed. Both receipts remain; the earlier result is not attributed to the final commit.

## Actual Scanner browser validation

All APIs were intercepted in the offline production-runtime application using 200 synthetic historical candles. No broker connection or orders. Both 1440×1100 and 390×844 layouts passed filtered navigation, off-window refusal without range change, global hiding, individual hiding, focus return, collapsed Objects, unchanged saved geometry and no horizontal overflow. Canonical/display OHLC, source, interval, symbol and engine identities remained exact. No page exceptions. Expected unavailable-service console errors and blocked requests are retained. The mobile final screenshot was inspected.

Sixty trusted clicks alternated loaded anchors 20 and 170 under 4× CPU throttling. Completion required the correct centered logical range, exact data/source/engine, focused chart, a visible unobscured 100×100 plot region and two consecutive rendering frames. Every attempt remains in the receipt.

| Viewport | Attempts ≤100 ms | Median | p95 | p99 / max |
| --- | --- | --- | --- | --- |
| Desktop 1440×1100 | 30/30 | 45.6 ms | 47.0 ms | 47.0 ms |
| Mobile layout 390×844 | 30/30 | 44.8 ms | 46.0 ms | 47.9 ms |

This measures the new object-jump action, not first page navigation. No owned builds or test suites were running during timing; other host activity was not controlled. CPU throttling is relative to this host. Resizing desktop Chromium is not physical-phone/touch testing, and two frames are not hardware paint. No matched competitor, real-provider, active-AI or heavy-history benchmark was run. No before/after speedup claim: the baseline had no object-jump button.

## Saved evidence and next work

Portable scripts, complete compressed JSON/results/logs, screenshots and raw-file SHA-256 manifest: `docs/validation/chart-object-navigation-20261031/`. Raw local files: `/Users/areyouok/arx-tier1-release/chart-object-navigation-20261031/`. The helper script's absolute local paths must be adjusted to reproduce elsewhere. Owned browser and fixture server were closed.

Replit's render-isolation development import was still busy at the last read-only check; the question was not submitted or queued, and the job was not restarted. Object controls, source bindings and this navigation follow-up still await selective development integration and checks on the exact resulting source. Published `.replit.app` and development source must not be conflated. Available owner browser tabs were at login, so authenticated published-page timing remains unavailable without a fresh private sign-in.

Keep the prior first-navigation failures open (roughly 288–317 ms medians in the last slowed local source-binding comparison, and separate slower Replit failures). Continue investigating those independently. Broader chart catalogue, physical device, large history, cloud workspace, alert/script and matched TradingView/MT5 gaps remain. No main merge, publication, deployment, existing database mutation, worker/trading activation or broker test occurred.
