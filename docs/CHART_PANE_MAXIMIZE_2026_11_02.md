# Native indicator pane maximization — 2 November 2026

Status: implemented, independently source-reviewed and accepted in the offline Scanner fixture. The full competitive chart and launch-readiness goals remain incomplete. This is not TradingView/MT5 parity or a performance-superiority claim.

## Exact source

- Base: `063db1c4c79b17912e164f5722d8e03163ba1cec` (divider resizing checkpoint).
- Initial implementation: `675da1dfb30d4466555b27b2850841d7afdc39ab`.
- Final application: `7b091106acbef02eafe6d62dad639a91af9c230d` (also cancels unfinished price drawings).
- Final browser driver: `6d83a2e307aa98c3b25daac9a3ad70fc716fe776`. Its application tree is byte-identical to `7b091106`; subsequent commits only position screenshots and wait for visible controls to finish updating.
- Branch: `codex/chart-pane-maximize-20261102`.
- Evidence: `/Users/areyouok/arx-tier1-release/chart-pane-maximize-20261102/`.

## Capability and source comparison

TradingView documents pane buttons that move, collapse, maximize and remove panes: [How to configure your Supercharts](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/), Buttons section, checked 2 November 2026. This change addresses maximization of existing independent native indicator panes. Whole-chart fullscreen, saved pane sizing, and collapsing are separate existing features. It does not prove MetaTrader gesture equivalence or overall competitor parity.

Each open indicator pane now has a Maximize button. It temporarily receives the entire plot, and Restore layout returns its saved geometry without modifying studies, weights, collapsed state, canonical candles or calculations. Horizontal time navigation and observation inspection remain available. Maximization is temporary, resets on reload/source or interval replacement, and is withdrawn if its owner is removed or collapsed. A collapsed pane must be expanded first.

Price candles, price-axis labels, drawings, price/position overlays, volume profiles, automatic annotations and other pane plots are hidden in indicator-only view. Old scanner-surface leases cannot convert indicator coordinates to market prices. Pointer and pinned inspection return no market price for an indicator Y coordinate. Price-axis gestures and divider resizing cannot act on the hidden price pane.

The chart notice, reader and export header describe the hidden presentation. An explicit assistant show/comparison restores the full layout before displaying the requested tool; explaining an installed study preserves maximization. Selecting a price drawing restores price view. Entering maximization cancels unfinished price-drawing anchors so they do not revive on return. Calculations remain available as observations and never gain trading authority from this view change.

## Review and retained failures

Independent source review covered all application files and the acceptance driver. Four findings were repaired: inaccurate reader/assistant visibility, divider hit-area overlap, explanation unexpectedly changing the view, and export wording promising an absent list. Parent review also found unfinished drawing anchors surviving maximization, repaired with a failing-before regression.

- Initial feature baseline: 5 failures (missing capability).
- Assistant restoration regression baseline: 1 failed / 120 passed; repaired.
- Drawing retirement baseline: 1 failed / 53 passed; repaired, then 54/54 passed.
- Source review receipt contains 17 file hashes. Final verification matches all 16 application/test files; the driver alone subsequently changed to capture the pane controls and await visible-control completion. These driver changes are preserved in Git.
- Initial browser run at `675da1df`: 15/15 passed.
- Expanded run at `5ef25062`: failed after 3 checks because it treated completed native paint as completion of React controls. The failure screenshot shows the new indicator canvas with old control positions. This failure is retained; it is not a successful end-to-end latency result.
- Final driver waits for the actual drawing selector to clear, then rechecks native completed paint. It retains the assertion and default timeout. Final run passes. No latency target was inferred from this wait.

## Final validation

Application checks on `7b091106`:

- Frontend: **4,956 passed, 12 skipped, 0 failed**; 288 test files passed, 2 skipped; original deadlines, two workers; 81.28 seconds. Earlier runs (4,954 and 4,955 pass) remain separately logged.
- Type checking: passed.
- Production build: passed; existing large-chunk warning remains.
- Guards: **85/87**. The same two existing failures and 43 normalized failure lines match the preceding divider checkpoint. This is not all-green CI.

Final browser on `6d83a2e3`, clean native production-default fixture **`ab550aca5cb5a80e`**:

- **16/16 checks passed** on the actual Market Scanner route, synthetic historical candles and intercepted APIs.
- Checks include upper-edge button hit, unfinished drawing retirement, no dividers in maximized view, reachable restore button, larger indicator plot, unchanged preferences/canonical candles/all indicator observations, truthful hidden-layer notice/reader, keyboard restore, exact geometry and focus restoration, temporary state on reload, and narrow-screen keyboard operation.
- 91 requests; 6 expected blocked POSTs; 0 unexpected requests; 0 page errors. 63 console errors from the offline fixture's intentionally unavailable endpoints are retained.
- Desktop and 390px screenshots inspected. No TradingView embed/logo in the tested native fixture.
- Browser closed; owned localhost servers stopped. No workload left running by this checkpoint.

## Limits and next work

No physical touch or assistive-technology acceptance, broker/demo/live tests, deployed-app acceptance, p95/p99 latency claim, native MT5 comparison run or full root/backend CI claim is made here. Earlier navigation/4x-CPU performance failures remain open. The prior early browser image also exposed a toolbar visibility caption during pending paint; transient caption completion deserves a dedicated cross-panel presentation test, rather than treating canvas completion as universal UI completion.

Remaining comparison scope includes modifier-double-click pane shortcuts, arbitrary pane merging/main-chart relocation, whole-chart layout splitters, MT5 scale-by-line behavior, independent status-line/axis controls, detachable Data Window, multi-symbol/timeframe studies, scripting, deep qualified history, remaining drawing/chart families, cloud workspace/server alerts, and fair repeatable competitor performance measurements.

The separate optimization chat's changes were not installed. Held performance experiments remain excluded. No main merge, PR76 merge, Replit sync, deployment, database migration, worker enablement, email, funds movement or broker orders occurred.
