# Native study scale labels — 2 November 2026

Implemented and independently reviewed; accepted in an offline synthetic Scanner fixture. The competitive chart and launch-readiness goals remain incomplete.

## Comparison and behavior

[TradingView's official indicator visibility documentation](https://www.tradingview.com/support/solutions/43000659666-i-want-to-hide-the-values-of-individual-indicators/), checked 2 November 2026, separates per-indicator scale labels from status values and describes global overrides. ARX now has independent opt-in scale labels for scalar studies. Global overrides remain open. This does not establish complete TradingView or MT5 parity.

- Latest loaded exact-time study observations only; no previous-value substitution for warm-up, absent quantities or missing timestamps. A loaded observation is not a live-feed assertion.
- Labels hide when the latest loaded candle is off-screen, their channels/interval/pane are hidden, their value is outside the scale, or there is insufficient space. Frozen volume profiles have no scalar last-value label.
- Linked overlays retain their owning pane's units. Main price overlays retain raw price units on percentage/indexed scales, explicitly marked as raw.
- Two-line labels identify the study's settings/channel and value. They use the existing native mapping and formatter without changing calculations, candles, autoscale or pinned inspection.
- Trade and last-price badges reserve their painted bands. Study labels may move at most 32 pixels from their preferred position; connectors retain the true value anchor and are clipped around reserved bands. Crowded labels are omitted, never piled over a trade badge. Full exact-time observations remain available in the Data Window/status readout.
- Preferences persist and duplicate independently. Simplified view hides scale labels with the studies. Existing workspaces default off.

## Exact source and evidence

Parent: `409c182b1dc828604dbb3f5b8faa6241caf6db2d`.
Application and browser driver: **`378d8098f3ddd036594ab41961e3b943df1811fa`**.
Branch: `codex/chart-study-scale-labels-20261102`.
Evidence: `/Users/areyouok/arx-tier1-release/chart-study-scale-labels-20261102/`.

- Focused: **209/209**, six files.
- Full frontend: **4,980 passed, 12 skipped, 0 failed**; 290 files passed, two skipped. 153.40 seconds, two workers and original deadlines. This duration is recorded, not a speed comparison.
- Type checking and production build pass; existing large-bundle warning remains.
- Guards **85/87**. The same two guards fail; 43 normalized failure lines match the preceding checkpoint. CI is not all green.
- Independent review clear; all 11 reviewed file hashes matched the committed source.
- Browser **9/9** for controls, persistence, geometry, pin preservation and native-renderer identity on the actual Scanner route. Clean production-default fixture `c234a47d30b3cba8`; all application APIs intercepted with synthetic historical candles. These checks do not by themselves prove pixels.
- Desktop and 390px screenshots separately inspected: RSI scale label shows **53.50052**, matching the latest raw study observation at display precision. Simplified screenshot removes the pane and label. No TradingView logo/embed observed.
- Browser: 88 requests, 55 unavailable endpoint records, six expected blocked POSTs, zero unexpected blocked requests, zero page errors, 61 offline console errors. These are not successful backend integrations.

## Retained failures and limits

Initial feature tests failed before implementation. Independent review found the label connector could cross a reserved trade badge even though the label box avoided it. The added painter regression failed **1/8** before connector clipping; it passes after the correction. A temporary test-locator capitalization edit caused eight settings-test failures; original names were restored and the failing log retained.

Unit/renderer evidence covers exact observations, missing values, crowding/reservations, transformed price axes, linked units, collapsed panes and hidden channels. Browser screenshots cover a single RSI; dense multi-study labels, physical touch and assistive technology have not received visual acceptance. Global scale/status visibility controls, other pane and drawing capabilities, deeper qualified history, scripting, multi-symbol/timeframe studies and fair competitor measurements remain open. Earlier navigation/4x-CPU failures remain open.

No deployment/Replit sync, main/PR76 merge, existing database changes, worker/trading activation or broker/live/demo testing. Owned fixture server and browser session were closed. The separate broad performance work was not imported.
