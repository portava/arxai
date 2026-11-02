# Native Smart Chart indicator panes — 2 November 2026

Application and browser-driver commit: `9411a40a01ad461af3a019bb9f290f63346900bd` on `codex/chart-indicator-pane-controls-20261102`, based on `c60fb309788cd359b83aaa39a2291ca06f7d823e`.

Verdict: scoped offline feature accepted. Architecture, launch readiness and TradingView/MT5 parity remain unproven. No main/PR76 merge, deployment, Replit sync, database changes, worker activation or broker tests occurred.

## Problem and behavior

Native oscillator panes previously discarded saved reference-level and scale settings. They now support up to twelve finite reference levels per pane-owning study, with descriptions, visibility, color, width and dash style. Clear removes all guides; restore reinstates catalogue defaults. Settings use existing preferences/templates; no separate chart system was added.

Pane scale can remain at the study default, fit visible values and guides automatically, or use explicit minimum and maximum bounds. Both fixed bounds must be valid and ordered before applying. Invalid or blank drafts preserve the study and previous settings. Fixed limits display an unconditional clipping warning; calculated observations remain unchanged in the data window. User guides do not alter AI rules, signals, thresholds or risk policy.

Linked overlays inherit the actual oscillator owner's scale, even when listed before it. Presentation changes reuse existing point checkpoints instead of recomputing indicator math. Independent price OHLC and the main price scale are unchanged. Nested settings are copied during validation and frozen in native snapshots.

## Verified competitor comparison

MT5 documents configurable reference values/descriptions and line appearance, plus fixed minimum/maximum, scale inheritance and scale-by-line controls. ARX now covers custom horizontal pane guides and a both-bounds fixed range. Independent one-sided limits and scale-by-line remain gaps. MT5 also supports offset levels on price overlays; this implementation intentionally does not claim that feature. [Official MT5 indicator settings](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators).

TradingView documents per-indicator settings accessible beside the title. That page alone does not establish equivalent fixed-minimum/maximum behavior; no TradingView feature-parity claim follows from it. [Official TradingView settings help](https://www.tradingview.com/support/solutions/43000480333-how-to-adjust-the-indicator-settings/).

Sources checked 2 November 2026. No side-by-side platform timing was performed.

## Validation

All application/test files in the run match application commit `9411a40a`; checks started on the working tree subsequently committed without application edits. The browser used clean committed production fixture `688ee0671b2b9950` from that exact commit.

| Check | Result |
|---|---|
| Baseline new engine tests | 5 failed, 1 passed; failures retained |
| First engine implementation | 6 passed |
| Focused renderer/linked-study/settings checks | 85 passed |
| Full dashboard suite, original timeouts, maxWorkers=2 | 4,850 passed, 12 skipped, 0 failed; 277 files passed, 2 skipped |
| Dashboard typecheck | Passed |
| Dashboard production build | Passed; existing large-chunk warning retained |
| Guards | 85/87; exactly the same 43 normalized failure lines as preceding linked-studies checkpoint |
| Actual Scanner production-browser acceptance | 13 checks passed |
| Independent static review | Two concrete findings and UI coverage gap resolved; final file hashes match |

Browser checks used synthetic historical candles, intercepted APIs and blocked external requests. They covered invalid limits, atomic fixed limits, custom guides, shared linked pane, unchanged complete RSI/SMA observations and OHLC, reload restoration, auto/default selection, 390px layout and absence of TradingView embeds/logo. Network: 90 requests, 6 expected blocked POSTs, 0 unexpected requests, 0 page errors; 38 expected offline console errors. Desktop fixed-scale and mobile controls screenshots were visually inspected. This is not a physical-device, broker, deployed-preview or performance acceptance result.

Independent review caught an unbounded spread of visible values, which could overflow the argument limit on large histories. It was restored to iterative accumulation and covered by an actual auxiliary-painter regression with 150,000 points. Review also caught a misleading clipped-count interpretation at fractional viewport edges; the caption now makes the general clipping behavior explicit without claiming a count. Stateful UI tests prove invalid drafts preserve settings and clear/default/duplicate operations remain distinct.

No numerical or trading calculation changed. Tests establish reuse of point arrays on presentation changes; no new browser-latency or 60 FPS claim is made. Large-history regression coverage is correctness evidence, not a paint-speed benchmark.

## Reproduce and evidence

Evidence packet: `/Users/areyouok/arx-tier1-release/chart-indicator-pane-controls-20261102`.

- `baseline.log`, `engine-first.log`, `focused.log`, `full-tests.log`, `typecheck.log`, `build.log`, `guards.log`.
- `guard-comparison.json`, `independent-review.json`, `review-source-verification.json`.
- `build-manifest.json`, `browser-result.json`, browser logs and screenshots.
- Browser scenario: `scripts/scanner-qa/study-pane-controls-acceptance.js`; fixture setup and wrapped driver preserved in packet.

From repository root, the dashboard checks are `pnpm --filter @workspace/trading-dashboard exec vitest run --maxWorkers=2`, `pnpm --filter @workspace/trading-dashboard exec tsc --noEmit`, and `pnpm --filter @workspace/trading-dashboard build`. This Mac used the existing offline environment wrapper and read-only dependencies. Guards use the established scripts runner. The wrapper is environment configuration, not itself a network sandbox; browser routes provide explicit isolation.

## Remaining scope

- One-sided pane limits, scale-by-line, arbitrary pane movement/merging, independent scales for overlays and price-offset indicator levels.
- Guide label collision handling for coincident user levels; native controls are not implemented in the legacy renderer. No legacy parity claim.
- Cross-symbol/timeframe indicator sources, user scripting and timeframe-specific study visibility.
- Same-main-chart relative overlays, multi-symbol comparisons and qualified deep history.
- Calendar intervals and remaining chart/drawing families; cloud workspace and server-side alerts.
- First-navigation/4x CPU response budgets, physical touch/accessibility and fair competitor performance benchmarks remain open. Held performance experiments stay excluded.
- Replit source/version and live broker accuracy are not established by this packet. Existing guard failures and skipped tests remain visible.

The separate owner-created performance chat owns broad optimization. No changes from it were integrated here.
