# Independent indicator pane boundaries — 2 November 2026

Application/browser-driver commit: `f2ff6f0ed75035a1a777bec44a018b030c41dbdf`, branch `codex/chart-independent-pane-bounds-20261102`, based on `2f87017e3651079ec76037f0726e0974d4f1b69c`.

Scoped offline acceptance passed. The broader charting/architecture goal remains incomplete; no release-green, performance improvement or platform-parity claim. No main/PR76 merge, deployment, Replit sync, existing-database changes or broker testing occurred.

## Behavior

The existing native study controls can now fix the minimum, maximum or both pane boundaries. An unchecked boundary adapts to visible study values and reference guides. The fixed boundary is preserved exactly, including when every observation lies outside it. Pane captions identify whether lower or higher values are clipped; the original data-window values and underlying candles remain unchanged.

UI checkboxes select the boundaries to apply. Unchecked drafts are not saved; invalid or empty selected bounds preserve the existing study and settings. Both unchecked asks the user to select a boundary or choose automatic scaling. Reload and duplicate operations preserve the distinction between an omitted bound and a numerical zero.

Automatic bounds use normalized arithmetic and pad only the free edge. If very small numbers round the free edge onto the fixed edge, it moves one representable floating-point step outward. This is a display-bound correction, not an alteration of observations. Impossible finite one-sided ranges (minimum at maximum representable number or maximum at its negative) are rejected. Linked overlays retain their parent pane scale.

## Comparison evidence

MT5 documents independently selectable fixed minimum and maximum controls, as well as scale inheritance and scale-by-line. ARX now covers the independent-bound control with tests of its own stated behavior; exact MT5 autoscale/padding equivalence was not established. The scale-by-line percentage convention remains insufficiently specified in the consulted sources and is not implemented or claimed. [MT5 indicator settings](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators).

The official MQL5 book describes adaptive visible-range scaling and fixed chart/subwindow properties. This supports the comparison category, not a claim that ARX reproduces terminal internals. [MQL5 vertical scale documentation](https://www.mql5.com/en/book/applications/charts/charts_scale_price).

Research checked 2 November 2026. TradingView equivalent independent-limit behavior was not established by this turn; existing comparison gaps remain open.

## Validation and failures retained

| Check | Result |
|---|---|
| New tests against prior implementation | 4 failed, 7 passed |
| Initial focused implementation | 78 passed |
| Expanded focused checks | 84 passed |
| Reviewer-reported subnormal case before fix | 2 failed, 16 passed |
| Focused checks after representability fix | 86 passed |
| Full dashboard suite, maxWorkers=2, original timeouts | 4,863 passed, 12 skipped, 0 failed; 277 files passed, 2 skipped |
| Dashboard typecheck and production build | Passed; existing large-chunk warning retained |
| Guards | 85/87; same 43 normalized failure lines as preceding checkpoint |
| Actual Scanner browser | 15 checks passed on clean production fixture `e6a98666e162c1f8` |
| Independent source review | Tiny-bound collapse found, reproduced, corrected and re-reviewed; final hashes matched |

Tests/build ran against application/test contents subsequently committed unchanged as `f2ff6f0e`. Browser manifest confirms that exact clean source. The full-suite duration is not a speed comparison: unrelated machine activity was uncontrolled.

Engine tests cover fixed edges, adaptive bounds under viewport changes, all-values-clipped cases, zero/extreme/subnormal limits and original-value preservation. Stateful UI tests cover independent controls, unchecked drafts, validation, duplicate restoration and switching back to automatic scale. Existing shared-pane tests remain passing.

The browser checked the actual Scanner route with synthetic historical observations: both-fixed and minimum-only settings, reload, maximum-only settings at390px, shared RSI/SMA pane, unchanged complete study observations and price OHLC, guides, defaults, native rendering and no TradingView embed/logo. Network90 requests;6 expected blocked POSTs;0 unexpected requests;0 page errors;38 expected offline console errors. Screenshots visually inspected. No physical-device, deployed-preview, broker or latency acceptance claim.

## Evidence and remaining work

Packet: `/Users/areyouok/arx-tier1-release/chart-independent-pane-bounds-20261102`. Contains baseline/reproduction/full logs, guard comparison, independent review and source hashes, browser scenario/setup/output/screenshots, clean build manifest and cleanup receipt. The checked-in browser scenario remains `scripts/scanner-qa/study-pane-controls-acceptance.js`.

Reproduce frontend checks with `pnpm --filter @workspace/trading-dashboard exec vitest run --maxWorkers=2`, `pnpm --filter @workspace/trading-dashboard exec tsc --noEmit` and `pnpm --filter @workspace/trading-dashboard build`. Local runs used the established offline environment wrapper/read-only dependencies; browser routes, not the wrapper itself, enforce external-request blocking.

Remaining: scale-by-line, arbitrary pane placement/merging, independent overlay scales, guide-label collision handling, timeframe-specific study visibility, cross-symbol/timeframe indicator inputs, user scripts, main-chart relative/multiple-symbol overlays, qualified calendar/deep history, remaining drawing/chart families, cloud/alerts, physical touch/accessibility and fair competitor latency evidence. Prior first-navigation/4x-CPU failures stay open. Held performance experiments and the separate optimization chat's changes were not installed. Neither existing guard failures nor skipped tests were hidden.
