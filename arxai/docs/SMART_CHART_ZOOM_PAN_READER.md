# Smart Chart: navigation and embedded reading

The chart can zoom around the visible midpoint, pan through loaded history, and explain source-identified closed candles inside its own frame. Automatic reading follows the actual applied viewport. This is the initial embedded reader, not completion of the owner's full analysis and pattern catalogue.

## Interaction

- Earlier/Later move by a quarter of the visible window; Zoom in/out preserve its midpoint within the real loaded history.
- Pan mode disables drawing placement and editing while retaining chart navigation. Selecting a drawing exits Pan mode.
- When the price chart has keyboard focus, Left/Right pan, Plus/Minus zoom, Home fits loaded history, and End returns to the latest candles. Shortcuts do not intercept input fields.
- The reader presents up to three relevant pattern chips, one focused explanation and one automatic annotation. Additional findings, statistics and evidence remain collapsed until requested.
- Automatic annotations use actual candle timestamps and prices. Head-and-shoulders necklines connect the two observed neckline anchors; a sloping neckline is not drawn as a horizontal historical level.
- Automatic geometry does not add synthetic price points, change autoscaling, intercept pointer input, or modify saved user drawings. Competing server structure is hidden while a focused automatic annotation is displayed.
- Timeframe selection updates in the click turn instead of waiting 200 ms. The native chart keeps its canvas mounted while observations, transient drawing anchors, crosshair state and manual price scaling reset before the new context paints. Linked time windows are reapplied to the retained engine.

## Evidence boundaries

Current raw API observations must match the expected symbol, timeframe, provider and opaque source identity. The confirmed endpoint must match the response's evidence. An explicitly forming final tip is excluded; contradictory finality, interior forming bars, invalid quality flags and conflicting overlapping observations withhold analysis.

Older history needs its original public-provider evidence. Each page is checked against its own closed-candle boundary before accumulation. A disagreement between two pages permanently withholds automatic analysis for that accumulated context, even though the existing display-only history behavior is retained. Account-era history that lacks original evidence is not promoted into verified analysis.

The reader checks its source observations against OHLC actually applied to the visible chart. During a mismatch it clears findings and annotations. Panning into history does not use subsequent candles for confirmation. Historical and stale-feed messages can appear together.

The native view rejects responses whose symbol, timeframe or candle provider differs from the selected context. Stream callbacks check ownership before the old connection's passive cleanup, so an intervening old frame cannot update the retained canvas. Legacy server structure is also withheld after an observed provider or opaque identity change unless the response carries matching source evidence. Its existing initial display remains unverified; this containment does not add missing account-era attestation to the legacy intelligence API. Saved manual drawings remain browser preferences scoped to symbol and timeframe.

The core analyzes at most 600 selected closed bars and discloses that limit. Visible-window statistics describe observed prices: change, mean, median, population standard deviation, high/low range and running-peak close drawdown. These are not strategy returns. Elapsed gaps are reported without claiming an outage or a market closure. Inverted axes are labeled visibly; line and nonlinear views disclose their interpretation in details. No volume, order flow, forecast, significance or probability is invented.

## Validation and remaining work

The core model and extraction are documented separately in `SMART_CHART_AUTOMATIC_ANALYSIS.md`. The normalized owner inventory is `SMART_CHART_OWNER_REQUIREMENTS.json` (24 analysis families and 104 named candlestick entries). A requirement's presence in that inventory is not evidence of implementation.

The first local full frontend run passed 1,408 tests, with nine explicitly optional tests skipped. Focused checks cover navigation without candle rewrites, drawing ownership, finality/source binding, conflicting historical pages, actual-viewport mismatch/recovery, selection completeness, stale historical context, sloped neckline geometry and price statistics. Two earlier reader assertions expected the word “doji” in the plain-English explanation; those incorrect expectations were repaired without changing runtime behavior, and the failed log is retained.

Production builds, final guards, real desktop/mobile/touch rendering and interaction timing are recorded in the external validation receipt when completed. Computation timing alone does not establish browser responsiveness, 60 fps, or parity with TradingView/MT5. Full-catalogue coverage and a matched competitor comparison remain open.

The native-context follow-up adds regression checks for same-turn selection, retained canvas, linked ranges, scale reset, stale response and stream exclusion, interrupted drawings, and stale derived structure after source changes. The full frontend suite and dashboard production build pass; exact counts and retained earlier test failures are recorded in the follow-up receipt. The earlier watchdog source assertion was extended for the additional source-context dependency. Actual browser interaction timing is still a separate integration gate.
