# Classic pitchfork — 2 November 2026

Application commit `e0fc450b94bf1f4b4215f7d6ee4ec542c75fe84a`, based on `782bb0c0606c95b9e0415e8b023bb5f350b93a6e`. Offline native Scanner fixture `bbfde3d499eeb9dc`. This adds a missing chart tool; it is not a release-green or parity verdict.

## Competitor evidence and scope

Retrieved 2 November 2026: [MetaTrader 5 Andrews’ Pitchfork](https://www.metatrader5.com/en/terminal/help/objects/channels/andrews_pitchfork) documents a median from the first anchor between two later anchors, parallel tines, editable coordinates and left/right extension. [TradingView Pitchfork](https://www.tradingview.com/support/solutions/43000518141-pitchfork-drawing-tool/) documents three-point placement, extension and configurable additional lines, styling and variants. These documents establish capabilities, not speed or profitability.

ARX now has a **classic manual Andrews’ Pitchfork** in the existing native drawing tool picker. Three real candle anchors are required, with the first earlier than the other two. The median goes through the displayed midpoint of B/C; tines run parallel through B and C. Projection happens before geometry so logarithmic/inverted modes retain visible parallelism and no invented midpoint candle is required. Without extension each segment has one A-to-midpoint vector. That finite-endpoint convention is explicit and not claimed identical to competitor defaults.

The same drawing engine supplies persistence, undo/redo, color/width/dash, exact price edits, three draggable handles, whole-object movement across real candle indices, locking/hiding and left/right extensions. Geometry does not add prices/timestamps to the market series or autoscale. Local manual annotations do not become Truth evidence or trading signals. No duplicate chart system was added.

## Validation

- Six feature tests failed before implementation; retained.
- Full frontend: **4,788 passed, 12 skipped, 0 failed**; dashboard typecheck and production build passed. Existing large-chunk warning remains.
- Guards **85/87**; exact same 43 normalized failure lines as previous checkpoint.
- Independent source review found no scoped blocker. Reviewer did not run tests.
- Actual Scanner browser fixture: **23 checks passed**, including exact intercepted-source/canonical/displayed OHLC equality, three pointer anchors, undo/redo, selected third-handle drag with single undo, logarithmic inversion, extension settings, lock/hide/reload, original candles unchanged and no embedded chart/logo.
- Primary agent visually inspected both screenshots: regular and inverted logarithmic views show three parallel lines with the anchors. Numeric geometry is covered by unit tests; a screenshot is not a pixel-level verifier or performance measurement.
- Browser driver was expanded after the application commit; application files remained identical. Final driver hash and exact build metadata are in the receipt. The fixture is isolated production configuration, not the deployable bundle.

Retained failed checks: a toolbar test initially expected hidden objects to disappear from configuration (the renderer retains hidden flags); and a browser test dragged an unselected object after undo/redo. The latter correctly translated all three anchors. The corrected journey selects first, then checks independent handle motion; the failed output and state remain saved. No application behavior was weakened to pass either test.

Evidence directory: `/Users/areyouok/arx-tier1-release/chart-pitchfork-20261102/`.

## Repeatable offline check

Build and serve using `scripts/scanner-qa/shared-chart-fixture/build.mjs` per its README. In a fresh isolated browser run `shared-chart-setup.js` with `SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD=true`, then `scripts/scanner-qa/pitchfork-acceptance.js`. Set `SCANNER_QA_OUTPUT_PREFIX` to an existing receipt directory. Inspect returned `passed`, failures and network records; CLI exit success alone is insufficient. All external requests and writes must remain blocked. Close browser and server when done.

## Remaining gaps

Schiff/modified Schiff/inside variants, configurable extra signal levels, per-line styling, automatic pitchfork qualification, physical mobile/touch acceptance, time-coordinate form editing and a matched competitor benchmark remain open. No claim of full TradingView/MT5 parity, faster execution or profitable predictions. Existing wider chart, replay, calendar, performance and Truth gaps remain. No main merge, Replit sync, deployment, existing database change or broker/live/demo test occurred.
