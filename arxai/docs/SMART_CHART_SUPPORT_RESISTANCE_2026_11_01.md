# Smart Chart support and resistance — 1 November 2026

Application `831e958d5688402eb20bb7b1f9c7589539b26fc0`, ordinary actual Scanner build `f2164502522451fb`, extends development checkpoint `0e95a162`. This is local functional acceptance, not release readiness, deployment or competitor parity. It supersedes the unfinished implementation status in `SMART_CHART_APPLIED_WINDOW_2026_11_01.md`; that report's earlier receipts remain tied to their original source.

## Existing owners extended

“Show me support and resistance” and the manual Drawing selector now use the same causal pivot calculation and native horizontal drawings. No new chart, model service, drawing manager or backtest engine was added. The selected asset, interval and displayed original closed-candle window remain authoritative. Requests for unsupported assets, periods or compound actions refuse rather than silently changing context.

The method chooses the latest strict pivot low below the last closed price and pivot high above it, with two observed closed bars on each side. Equal highs/lows are excluded. Explanations disclose each pivot anchor, its later confirmation time, source, reference close and subsequent observed closes beyond the level. These are historical candidates, not zones, untouched-level claims or predictions. Missing evidence or an incomplete two-sided range refuses; timestamps keep the original clock caveat.

Candidates render as a nonpersistent preview. Source/window changes withdraw it before accepting or exporting. Keep levels and edit creates two adjustable objects using the existing history, storage, visibility, selection and undo/redo controls. Each keeps archived pivot provenance distinct from its current manually edited price. Repeated keep preserves existing edits and prevents duplicate original pairs. Renderer failures, capacity limits and explicit hidden drawings do not become false success claims. Assistant commands explain, hide, show and remove the explicitly selected saved annotation; they never substitute another pane or another side.

## Exact-source evidence

- Frontend: 3,357 pass, 11 skipped, zero failures; 211 files pass and one skipped.
- Dashboard typecheck and immutable ordinary Scanner build pass.
- Architecture guards: 87/87; bridge binding: 7/7 assertions.
- Actual Scanner browser: 28/28 desktop and 28/28 at 390px. Independent arithmetic verifies pivots, confirmation times, reference closes and rendered anchors. Manual/assistant equivalence, atomic undo/redo, editing, selected explanation, hide/show, duplicate prevention, source withdrawal and reload persistence pass. Canvas screenshots were inspected. This is an emulated phone viewport, not physical-device acceptance.
- Prior implementation fails six of seven new Workbench tests; the candidate passes. Failed runner setup attempts are retained: missing executable, denied local IPC, then missing workspace dependency. The final correctly linked offline runner passes; no application code was changed to fix those setup errors.

The helper agents stopped at their usage limit. Root preserved their partial work, completed the implementation and reviewed the final changes. A final independent review is still outstanding.

## Navigation results retained, including failures

| Scenario | Desktop median / max | 390px median / max | Within 100ms |
|---|---|---|---|
| Normal CPU | 56.4 / 67.8 ms | 54.8 / 57.5 ms | 10/10 |
| 4x CPU throttle | 277.6 / 321.8 ms | 258.6 / 259.8 ms | 0/10 |

All 20 planned attempts produced valid source-correct display evidence; all slower-device misses and outliers are retained. Owned test/build workloads had finished, but the whole host was not isolated. The existing route warmup can start the intercepted GET before the click. This measures click-to-displayed canonical chart in a production offline fixture, not click-initiated network latency, physical hardware paint or the deployed app. Earlier normal and 4x results remain separate; the higher 4x values here do not justify a speed improvement claim.

## Remaining requirements

Automatic zones and adjustable discovery methods, editable market-structure/trendline workflows, broader natural-language tool controls, strategy capital/sizing/equity/benchmark, and matched TradingView/MT5 performance remain open. Existing fixed-pivot candidates are not TradingView Standard Pivot Point formulas. The earlier verified primary-source distinctions remain in `SMART_CHART_APPLIED_WINDOW_2026_11_01.md`. The 100ms slower-device target is not met. Historical calculations and chart commands do not authorize orders or change the AI entry-confidence policy.

Raw evidence is in `/Users/areyouok/arx-tier1-release/chart-support-resistance-20261101/`, with machine-readable counts and limitations in `docs/development-sync/CHART_SUPPORT_RESISTANCE_VALIDATION_2026_11_01.json`. Replit's prior `0e95a162` source-only import remains busy at the last read-only check; this newer feature is not claimed imported or visible. No main merge, deployment, runtime restart, existing database change or broker test occurred.
