# Native chart default and actual-consumer acceptance — 2 November 2026

Application: `19ac1b21b72b825bd9ef97cccfbbf94d89bd1807`. Production fixture build: `474715bccdca076a`. Development branch only. **Not release-green, not deployed, no TradingView/MT5 parity or speed-superiority claim.**

## Source and repair

`5c93c5e6` selects the existing ARX native adapter as the real factory default. The normal production fixture now observes that default without a source override. The legacy adapter remains explicitly selectable for comparison; its attribution was not hidden. Actual Scanner primary/comparison, replay, secondary chart routes and position preview use the common factory.

`be2fb6e7` makes navigation QA recognize the actual native candle-layer identity and require completed rendering, not queued input. Source/display OHLC equality, two rendering frames, trusted navigation, unobscured viewport intersection and the 100 ms target are unchanged.

The actual position-picker browser check failed at `5c93c5e6`: mobile selection created a canvas/container resize loop. Recorded widths grew from 13,240 to 13,424 pixels in about one second, with thousands of repaints. This was an application failure, not dismissed as test noise. `19ac1b21` measures implicit canvas dimensions from available content space, aligns the mini-chart observer and constrains the mobile grid so its canvas cannot expand its track. Explicit dimensions retain their existing plot-size contract.

Four new sizing regressions failed before repair. Final focused sizing tests: 110 passed. Independent exact-source review found no scoped blocker. Six actual-parent mobile observations after repair keep the main chart at 332 px and mini container at 284 px, both at two completed paints. No overflow-hiding workaround was used.

## Exact-head functional and build evidence

| Check on 19ac1b21 | Result |
| --- | --- |
| Scanner layouts, links, replay prefixes/HA/export | 24/24 browser checks |
| Source-clock labels/export and native position preview | 31/31 browser checks |
| Four secondary routes, desktop/mobile, source selection and role boundaries | 192/192 browser checks |
| Actual picker, request-bound history prepend/ceiling, selected-position switching and mobile stability | 19/19 browser checks |
| Full frontend | 4,605 pass, 1 fail, 12 skip |
| Typecheck and production build | Pass; existing build warnings retained |
| Architecture guards | 85/87; all 44 normalized failure-block lines match the earlier baseline |

The frontend failure is the unchanged admin-403 role-gate test in `autopilot-control-center.roleGate.test.tsx`. Its isolated rerun passed 4/4; the full-run failure remains recorded and is not converted into a green full-suite result. Initial restricted IPC/browser startup failures are retained. A root browser rerun mistakenly reused an initialized fixture, producing an exposeFunction registration failure; corrected fresh-session results are separately named. Earlier results on `5c93c5e6` are not attributed to the final head.

All fixtures use synthetic historical candles and synthetic position rows. API writes were blocked; incidental non-trade attempts are retained. No actual account, terminal or broker was exercised. No broad visual-design acceptance follows; inherited sticky-header layout issues remain outside this scope.

## Scanner first navigation — target still fails on slower CPU

Normal no-override build; immediate trusted first actionable click after full-document reload, no intentional dwell. Five desktop and five mobile attempts per CPU setting. Every attempt had source-correct displayed OHLC and two visible rendering opportunities. Resources were primed by setup and HTTP caching disabled by routing; this is not cold browser-process startup, hardware paint, hosted-app latency or a competitor benchmark. The fixture uses an 80 ms candle delay. CPU throttling was applied through CDP; other owned heavy validation was paused, but shared-host interference cannot be excluded.

| Software CPU setting | Viewport | Median visible completion | Maximum | At or below 100 ms |
| --- | --- | --- | --- | --- |
| 1x | Desktop | 66.0 ms | 67.8 ms | 5/5 |
| 1x | Mobile | 67.0 ms | 68.0 ms | 5/5 |
| 4x | Desktop | 279.9 ms | 338.4 ms | 0/5 |
| 4x | Mobile | 255.9 ms | 358.8 ms | 0/5 |

All 20 attempts and diagnostics are retained. The slower-CPU target fails; the normal-CPU result cannot establish instant loading for users. Small sample maxima are reported instead of implying reliable tail estimates. No matched old-engine or competitor speed comparison was run.

## Outstanding work

Profile and fix actual Scanner slow-CPU first navigation, then repeat matched quiet measurements. Preserve full-workload, calendar-interval, tool coverage, session/cloud, multi-chart/replay, physical-device, provider/broker and TradingView/MT5 comparison gaps. Native source default and scoped functional acceptance do not complete the architecture.

The owner's latest monetary priority continues separately: whole-account native reports must not be confused with per-user positions or allocation ledgers; remaining transport/clock/order/currentness and terminal-to-render latency gaps are open. The account panel's existing report retains `currentVerified: false`.

Raw receipts: `/Users/areyouok/arx-tier1-release/native-default-acceptance-20261102/`. Portable receipts and manifest: `docs/validation/native-default-acceptance-20261102/`. No main merge, deployment/Replit sync, database change, worker activation or broker test.
