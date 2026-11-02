# Global study readout controls — 2 November 2026

Implemented, independently reviewed and accepted offline. Competitive parity and launch readiness remain unproven.

## Behavior and comparison

[TradingView's official indicator visibility documentation](https://www.tradingview.com/support/solutions/43000659666-i-want-to-hide-the-values-of-individual-indicators/), checked 2 November 2026, describes global visibility settings overriding per-indicator scale/status choices. ARX now supports that relationship in the existing Studies settings:

- **Allow study status values** and **Allow study scale labels** apply to this chart only.
- Turning either off hides its numeric display without rewriting individual study choices, plots, calculations, Data Window settings or assistant evidence. A saved enabled choice explains when its chart-wide override hides it.
- Turning it back on restores only studies individually enabled for that surface. A study disabled while the override is off stays disabled afterward.
- Missing global preferences default to allowed, preserving earlier workspaces. Only booleans persist; strict template import rejects malformed switches. Both controls travel with templates.
- Native scale-label gating changes paint only. Pin, geometry and studies stay intact; repeating the same setting does not trigger another paint. A data-context replacement retains the chart preference.
- Global status hiding avoids study queries when the Data Window is also closed. An open Data Window remains independent.

## Exact source and checks

Parent: `f76bf8ae9c867dcb833cff14483c44acc930dd3a`.
Application and browser driver: `3ce5874e`.
Final tested head, with test-only selector correction: **`3a99014ffe5a543988a01793beab1c51ea1aa1de`**.
Branch: `codex/chart-global-study-readouts-20261102`.
Evidence: `/Users/areyouok/arx-tier1-release/chart-global-study-readouts-20261102/`.

- Focused controls/template/adapter/shell checks: **223 passed**, five files. Workbench selector repair: **55 passed**.
- Full frontend on final head: **4,985 passed, 12 skipped, 0 failed**, 291 files passed, two skipped; 129.42 seconds, two workers, original deadlines.
- Type check, production build and guards ran on application head `3ce5874e`; only a test selector changed afterward. Type check/build pass; existing bundle warning remains. Guards **85/87**, with the same 43 normalized failure lines. Not all-green CI.
- Independent review clear at final head; all **13 file hashes** matched.
- Actual Scanner route offline browser **15/15**, clean native production-default build `cd965288937cf00e` from final head. Synthetic historical candles and intercepted APIs only.
- Browser checks verify opt-in defaults, independent preferences, exact pinned historical RSI restoration and caption, unchanged candles/layout, and persistence of both disabled global overrides and enabled individual choices after reload. Desktop hidden/restored screenshots and 390px screenshot separately inspected: scale label disappears and returns, while the RSI plot remains.
- Browser records: 126 requests, 77 unavailable endpoint records, nine expected blocked POSTs, zero unexpected blocked requests, zero page errors, 86 offline console errors. This is not backend integration acceptance.

## Retained failures and limits

The feature baseline failed before implementation. One new adapter test initially called a nonexistent adapter getter; it was corrected to inspect the real viewport and its failure log retained. The first full run had 4,984 pass / 12 skip / one failure because the prior clock-withdrawal test selected the first legend, now the new global-controls heading. It now explicitly selects the VWAP study heading while retaining its source-clock warning assertion. The complete rerun passes. Review strengthened the browser restoration assertion from generic RSI text to the exact historical value, timestamp/pin state and Pinned candle caption.

No speed gain or parity claim follows from functional acceptance. Dense multi-study visual acceptance, further pane/drawing capabilities, qualified history, scripting, multi-symbol/timeframe studies, cloud workspace/server alerts and fair competitor performance remain open. Earlier navigation/4x-CPU failures remain open. Physical touch/assistive technology, deployed-app acceptance and full root/backend CI are not claimed.

Owned local server and browser session closed. No main/PR76 merge, deployment, Replit sync, existing database changes, worker/trading enablement, funds movement, emails or live/demo broker tests. The separate performance chat's changes were not imported.
