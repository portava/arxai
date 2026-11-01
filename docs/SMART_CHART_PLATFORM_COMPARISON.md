# Smart Chart: TradingView and MetaTrader 5 comparison

Research updated 2026-10-27; implementation status updated 2026-10-31. Scope:
ARX Smart Chart development branch / draft PR #103, not a deployment. **Full platform parity and speed superiority remain unproven.**
The checklist below drives implementation; it is not a weighted completion score.
A feature count alone cannot establish professional quality.

## Products and evidence boundaries

TradingView Supercharts is the end-user platform. Advanced Charts is a separate
embeddable library; its public demo is useful for observing interactions but does
not contain the entire Supercharts service. Trading Platform adds broker-facing
integration APIs. The former free hosted widget could not be fed ARX candles or manipulated as
an owned chart. Its four page integrations and loader have now been removed
from this development branch; those pages use ARX Smart Chart. ARX uses Lightweight Charts v5 behind
its own adapter. No approved proprietary Advanced Charts bundle or license grant
was found in this repository. [TradingView products/API](https://www.tradingview.com/charting-library-docs/latest/api/),
[datafeed integration](https://tradingview.com/charting-library-docs/latest/connecting_data/).

The official Advanced Charts demo was inspected read-only in Chromium. Observed
controls include symbol search, compare, intervals, studies/templates, layout
management, snapshot, measure, zoom, drawing persistence mode, object tree, date
presets, go-to, timezone, session, percentage, log and auto scale. This confirms
those controls are present in that demo; it does not benchmark Supercharts or
MT5. Reference: [official demo](https://charting-library.tradingview-widget.com/).

MT5's help documents up to 100 simultaneously open charts. Its marketing material
also uses broader wording, so this comparison uses the explicit help limit.
MT5 documents 21 timeframes and 38 built-in indicators. Its analytical-object help currently lists 46 tools (checked 2026-11-01), while older marketing material cited 44; this comparison uses the specific [object help](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects).
ARX's 17 study types include four separately listed moving-average methods;
these counts must not be treated as equivalent catalog coverage.
[MT5 charts](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts),
[technical-analysis catalog](https://www.metatrader5.com/en/trading-platform/technical-analysis).

ARX now exposes 19 fixed-duration intervals: M1, M2, M3, M4, M5, M6, M10,
M12, M15, M20, M30, H1, H2, H3, H4, H6, H8, H12 and D1. The shared picker,
layout state, Scanner timeframe bus and replay use the same interval definitions.
W1 and MN1 remain explicitly unavailable: epoch-aligned weeks and fixed-length
months do not establish the provider's calendar boundaries. Stored calendar
selections are not silently replaced. Server intelligence accepts the exact fixed-duration chart interval. Smart
layers, saved annotations and decision receipts still accept only their seven
original intervals; unsupported intervals receive no nearest-timeframe substitution.

The actual Scanner page now mounts `ARXNativeChart` with its existing shared
candle query and original response evidence. Native owns candle rendering,
streaming and history; Scanner retains its owned-position, pending-order,
annotation, context-menu and confirmation controls through a view-only surface
bridge. Standalone native performance figures cannot be attributed to Scanner. A bounded
actual-Scanner check is now recorded separately in the 28 October follow-up;
its missing native-menu style samples keep its overall timing verdict partial.

## Comparison and implementation checklist

Status meanings: **Implemented** means code exists with the listed local evidence;
**Partial** means material capability is missing; **Open** means unavailable in
this Smart Chart implementation. None means production verification is complete.

| Capability | Reference behavior | ARX status and concrete gap |
|---|---|---|
| Candles / OHLC bars / line | All three in MT5 [M1] | Implemented; real-browser style switching retains canonical OHLC and viewport |
| Extended time-based styles | TV area, baseline, hollow, Heikin Ashi and others [T1] | Partial: close area, close baseline, Heikin Ashi and hollow candles added to the style picker, with canonical studies, drawings, price lines and Last line; legend keeps canonical OHLC and adds a labelled HA suffix in Heikin Ashi. Differences from the cited TV help pages: the baseline base is the first loaded close, not TV's chart-height percentage [T13]; the HA first-bar seed (O+C)/2 is not stated by TV [T12]; hollow equal-price and first-bar handling are ARX conventions [T11]. Seven-style standalone browser switching is accepted in the [round-3 receipt](SMART_CHART_ROUND3_BROWSER_ACCEPTANCE_2026_10_28.md); integrated Scanner Heikin Ashi replacement is accepted in the [Scanner receipt](SCANNER_SMART_CHART_INTEGRATION_2026_10_28.md). The four new style-switch latency groups remain unmeasured. Other [T1] types remain open, for example line with markers, step line, HLC area, high-low, column, and volume candles (which also need trustworthy volume) |
| Price-based charts | TV Renko, Kagi, point-and-figure, range, line break [T1] | Open; aggregation and nonstandard-price labeling required |
| Footprint / TPO / volume profile | TV specialized chart types [T1] | Partial: estimated loaded-bar fixed-range Volume Profile accepted offline on f6e64fbe; configurable rows/value area, POC and exact source-bound ranges. Lower-timeframe/full-session profiles, footprint, TPO and order flow remain open. See [profile acceptance](SMART_CHART_VOLUME_PROFILE_2026_11_01.md). |
| Pan / zoom / return to latest | MT5/TV chart navigation [M1,T2] | Implemented; history anchoring, Latest/Fit/Reset, Home/End |
| Scale modes | TV regular, log, percentage and indexed-to-100 [T2] | Implemented: regular/log/percentage/indexed modes |
| Scale inversion / auto / price-only | TV scale settings [T2] | Partial: automatic scale, inversion and [price-only fitting](SMART_CHART_PRICE_ONLY_SCALE_2026_10_31.md) implemented; fixed/one-to-one scaling remains open |
| Date jump / range presets | Observed in official demo; TV navigation [T2] | Implemented: go-to in the chart's selected display time zone (UTC by default and on daily bars; clock-change gap times are rejected, repeated times use the earlier occurrence) and 1D/5D/1M/3M/1Y loaded-history ranges; unavailable history is explicitly reported |
| Timezone / session / countdown | TV chart settings [T2] | Partial: display timezone selectable; validated forming-candle countdown shared with Scanner; session shading remains open. Per chart view, not saved in templates; a new comparison view starts from the primary view's choice. UTC (default), browser local and 8 named IANA zones relabel the time axis, crosshair, candle legend, object list, go-to, replay seek and labels, chart reader and PNG capture time, each with its zone abbreviation. Display only: candle times, drawings, links and data requests stay UTC seconds. Kept in UTC: link events, the deep-history request cursor, the market-closed last-quote banner, machine-readable time attributes, and every surface on daily (D1) charts, whose bars keep UTC day labels. Axis limitation: lightweight-charts 5.2.0 places day, month and year ticks at UTC boundaries, so in other zones those ticks show a local date or time rather than falling on local midnight. No selectable zone represents broker server time. Evidence: artifacts/trading-dashboard/src/lib/chart-engine/chartTimeZone.ts |
| Custom intervals | MT5 21 presets; TV interval controls [M1,T3] | Partial: 19 fixed-duration intervals exposed across the shared chart and Scanner; W1/MN1 explicitly unavailable pending calendar-boundary correctness. Server overlays/receipts retain seven supported intervals and explain when unavailable; no user-defined intervals. See timeframe note above |
| OHLC inspection | MT5 crosshair/data window [M1] | Implemented, canonical values also for line style; area, baseline, Heikin Ashi (HA values labelled separately after the canonical OHLC) and hollow are unit-tested and checked in the isolated real-browser workbench; see [round-3 acceptance](SMART_CHART_ROUND3_BROWSER_ACCEPTANCE_2026_10_28.md) |
| Study-value data window | MT5 indicator values in data window [M1] | Implemented in this branch; inspect the same timestamp across price/oscillator panes |
| Study catalog | MT5 38; Advanced Charts 100+ [M2,T4] | Partial: 22 entries (19 OHLC studies, tick count and two conditional traded-volume studies), searchable library, including [Wilder DMI/ADX](SMART_CHART_DMI_2026_10_31.md) and [Donchian Channels](SMART_CHART_RANGE_STUDIES_2026_10_31.md); remaining MT5/TradingView studies and matched-platform numerical validation are open |
| Moving-average methods | MT5 SMA, EMA, SMMA, LWMA [M3] | Implemented; explicit SMA seeds and tested weights |
| Multiple copies of a study | Configurable study workspaces [T3,T4] | Implemented; stable IDs, independent settings, up to 12 active instances |
| Applied-price sources | MT5 price/indicator inputs [M4] | Partial: eight OHLC sources; no study-on-study chaining |
| MACD convention | MT5 uses SMA signal [M5] | Implemented signal-method selection; EMA remains legacy default; seed and histogram presentation differences disclosed |
| Oscillator panes | MT5 separate indicator windows [M4] | Implemented; resizable panes and reference levels |
| Indicator custom scripting | Pine/MQL5/platform APIs [T3,T4,M4] | Open; no user script execution sandbox |
| Volume studies / VWAP | MT5 distinguishes tick and actual traded volume [M4] | Partial: separate tick/trade histograms and source-bound anchored VWAP; actual Scanner manual/AI arithmetic and withdrawal accepted offline on9982b545. Only qualified provider trade units; real entitlement and broader sources remain open. Exact source-bound saved-anchor clock labels are aligned on f6e64fbe. See [selection acceptance](SMART_CHART_ANALYSIS_SELECTION_2026_11_01.md) |
| User levels / trend / Fibonacci | TV drawing families [T5] | Implemented: nine tools including manual text notes and [parallel channels](SMART_CHART_PARALLEL_CHANNEL_2026_10_31.md), real candle anchors, reversible edits; actual Scanner notes accepted in46 browser assertions plus desktop/mobile/PNG visual inspection on1e879563; browser-emulated touch note placement/move/lock/cancel accepted separately on0af7ebd7; physical-device coverage remains open |
| Pointer/touch placement | Drawing interaction [T5] | Implemented; rapid two-anchor mouse/touch tested |
| Drag handles / whole object | MT5 graphical objects / drawing interaction [M6,T5] | Implemented: selection, whole-object/anchor mouse and touch drag; one undo entry, cancel rollback |
| Snap / lock / styling | MT5 object settings [M6] | Implemented: OHLC magnetic anchors, geometry locks, width/dash/color and exact prices; no object groups |
| Rays / channels / geometry / text | TV/MT5 drawing families [T5,M2] | Partial: rays, extended/vertical lines, rectangles, time/price-anchored manual text notes and [parallel channels with optional extensions/midline](SMART_CHART_CHANNEL_EXTENSIONS_2026_10_31.md) implemented; fixed-screen labels, rich text styling, other channel families and broader tools remain. Mobile warning-occlusion fix accepted on1e879563; see [workspace acceptance](SMART_CHART_WORKSPACE_ACCEPTANCE_2026_10_31.md) |
| Gann / Elliott / pitchfork / patterns | TV/MT5 analytical families [T5,M2] | Open |
| Object management | TV object tree / MT5 object list [T5,M6] | Partial: list, hide-all, per-object hide/search, go-to-start, delete and undo/redo; focused-chart drawing keyboard shortcuts added in [the shortcut receipt](SMART_CHART_DRAWING_SHORTCUTS_2026_10_31.md). No groups, multiselect or reorder |
| Multi-chart workspace | TV layouts; MT5 chart profiles [T6,M7] | Partial: one/two/four responsive charts, independent instruments/intervals/settings and explicitly selected local assistant; comparison-only stocks do not expand primary trading scope. Larger layouts and cloud profiles remain open |
| Crosshair / time-range synchronization | TV selectable chart synchronization [T6] | Implemented within workspace: optional links on UTC seconds (each view labels times in its own display zone), own-instrument candle close, clipped/unavailable loaded-history disclosure |
| Different-symbol comparison | TV compare/overlay [T3] | Partial: independent comparison panes implemented; overlaid/normalized comparison series remain open |
| Drawing synchronization | TV within/across layouts [T6] | Partial: browser-local matching symbol/timeframe sync; no account cloud sync |
| Templates / profiles | TV layouts; MT5 templates/profiles [T7,M7] | Partial: autosave plus up to30 named browser settings templates with guarded JSON import/export. Account/cloud and named multi-chart workspaces remain open. Template interaction fix accepted in30 actual-Scanner browser assertions on1e879563, including delayed source binding; see [workspace acceptance](SMART_CHART_WORKSPACE_ACCEPTANCE_2026_10_31.md) |
| Bar replay | TV select start, seek, step, speed, multi-chart replay [T8]; no equivalent MT5 bar-replay criterion in this row (MT5 visual strategy tester [M8] is documentation, not measurement) | Partial: single-chart replay of up to 5,000 closed bars from the loaded response window ("Replay loaded bars", `components/charts/ARXNativeChart.tsx:1112`) with Start, Previous/Next, Play/Pause at 0.5–8 bars/s, position slider, close-time seek in the selected display zone (UTC by default) and arrow/Space keys; studies receive only the revealed prefix; private `/chart-replay` route outside the live layout unmounts prices, Truth, positions and tickets. View-only; not a backtest or fill simulation. Latency (Apple M4 Pro, 4× CPU throttle, 5,000 constructed bars, 12 studies, 37-name reader): step second-rAF p95 36.9 ms; full forward-seek second-rAF p95 105.7 ms, **FAIL** against 100 ms; no competitor comparison. Remaining: multi-chart replay, saved sessions, deeper attested history (older paginated history excluded), order simulation, costs/slippage. Evidence under `artifacts/trading-dashboard/src/`: `lib/chart-engine/chartReplay.ts`, `components/chart-replay/ChartReplayPlayer.tsx`, `components/chart-replay/ChartReplayBoundary.tsx`; [replay](SMART_CHART_REPLAY.md), [completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md) |
| Strategy testing | Pine strategy tester / MQL5 tester ecosystem [T3,M2] | Partial: existing causal one-unit EMA/ATR historical workbench, frozen ledger/overlays and chronological partitions; source-qualified UTC/BID or MID required. General scripting, account-currency sizing, benchmarks, deep attested history and matched-platform equivalence remain open. See [requirements census](SMART_CHART_REQUIREMENTS_CENSUS_2026_11_01.md) |
| Server alerts | TV price, study, strategy and drawing alerts [T9] | Open for native chart drawings/studies; a browser timer would not be equivalent |
| PNG export | MT5 Save As Picture [M6] | Implemented; symbol, interval, capture time (selected display zone with abbreviation, plus UTC ISO when not UTC), feed status and study settings included |
| Workspace sharing / cloud recovery | TV saved layouts [T7] | Open; local storage is not cloud durability |
| Data freshness / gaps / backfill | Product behavior depends on datafeed [T10,M1] | Partial: ARX explicit status/watchdog/history handling; production coverage still unverified |
| Quote and execution-price identity | Feed/broker-specific, not a renderer feature [T10] | Open operational validation; no claim that independent vendors' prices must match |
| Mobile and accessibility | Product-specific interaction quality | Partial: responsive/touch/fullscreen/focus checks; no comprehensive screen-reader or every-device certification |
| Sustained rendering performance | Requires equivalent controlled workloads | Partial: ARX-only measurements; no fair TV/MT5 speed comparison. Owner targets: visible feedback within 100 ms p95 for local interactions and smooth 60 fps on documented reference hardware. Replay (Apple M4 Pro, 4× CPU throttle, 5,000 constructed bars, 12 studies, 37-name reader; [completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md)): step second-rAF p95 36.9 ms, below 100 ms at that checkpoint (an inference, not a recorded PASS; the later 65-name catalogue and descriptive reader have not been validated in this replay workload, per [completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md) line 13; the current 81-name catalogue is likewise unvalidated in this workload ([v5](SMART_CHART_CANDLE_CATALOGUE_V5.md))); full forward-seek second-rAF p95 105.7 ms, **FAIL**. Streaming stress (development Mac, Chromium, no CPU throttle stated; [acceptance](SMART_CHART_ACCEPTANCE.md)): 10k bars p95 frame interval ~16.7 ms; 50k bars p95 frame interval 33.3 ms, ~1,128 ms setup and a ~1,065 ms initial long task. Frame intervals and rAF are scheduling proxies, not paint; sustained 60 fps is unproven. Display-style switching beyond candles/bars (line/area, area/baseline, baseline/Heikin Ashi, Heikin Ashi/hollow) has harness groups in `interaction-latency.js` but no measurement yet; the existing candles/bars switch already measured p95 191–205 ms at 4x, **FAIL** ([acceptance](SMART_CHART_ACCEPTANCE.md#local-control-interaction-latency)) |

### Reference key

- [T1 — TradingView chart types](https://www.tradingview.com/support/solutions/43000703407-chart-types-available-on-tradingview/)
- [T2 — Chart configuration](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/)
- [T3 — Supercharts overview](https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/)
- [T4 — Advanced Charts custom indicators](https://www.tradingview.com/charting-library-docs/latest/custom_studies/)
- [T5 — Drawing-tool families](https://www.tradingview.com/support/solutions/43000703396-drawing-tools-available-on-tradingview/)
- [T6 — Multi-chart layouts](https://www.tradingview.com/support/solutions/43000629990-leveraging-multi-chart-layouts-in-your-analysis/)
- [T7 — Layouts, charts, drawings and indicators](https://www.tradingview.com/support/solutions/43000692404-layouts-charts-drawings-indicators-and-their-interaction/)
- [T8 — Bar Replay](https://www.tradingview.com/support/solutions/43000712747-bar-replay-how-and-why-to-test-a-strategy-in-the-past/)
- [T9 — Alerts](https://www.tradingview.com/support/solutions/43000520149-introduction-to-tradingview-alerts/)
- [T10 — Datafeed API integration](https://tradingview.com/charting-library-docs/latest/connecting_data/)
- [M1 — MT5 price charts](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts)
- [M2 — Technical analysis](https://www.metatrader5.com/en/trading-platform/technical-analysis)
- [M3 — Moving-average formulas](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/ma)
- [M4 — Technical indicators](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators)
- [M5 — MACD formula](https://www.metatrader5.com/en/terminal/help/indicators/oscillators/macd)
- [M6 — Chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage)
- [M7 — Templates and profiles](https://www.metatrader5.com/en/terminal/help/charts_advanced/templates_profiles)
- [M8 — Visual strategy testing](https://www.metatrader5.com/en/terminal/help/algotrading/visualization) (as cited in [SMART_CHART_REPLAY.md](SMART_CHART_REPLAY.md); documentation, not a measurement)
- [T11 — Hollow candles](https://www.tradingview.com/support/solutions/43000745270/) (linked from [T1]; read 2026-10-28: fill compares close with open, colour compares close with the previous close)
- [T12 — Heikin Ashi](https://www.tradingview.com/support/solutions/43000619436/) (linked from [T1]; read 2026-10-28: open and close formulas; no first-bar seed stated)
- [T13 — Baseline](https://www.tradingview.com/support/solutions/43000690232/) (linked from [T1]; read 2026-10-28: base level set as a percentage of chart height, 50% by default)

## Implementation order and proof required

1. **Study foundation:** independently checked math, repeated studies, applied
   prices, named conventions and pane inspection. Implemented in the current
   development changes; browser and regression results recorded separately.
2. **Drawing interaction:** shared layer, selection/drag, OHLC snapping and locks
   implemented with reversible mouse/touch edits. Expand channels, text,
   future-space annotations and keyboard editing.
3. **Professional navigation/workspaces:** scale modes, go-to/ranges, multiple
   symbols, linked crosshair/time range, named templates/import/export.
4. **Replay:** immutable history snapshot, no lookahead, deterministic stepping,
   speed/seek; clearly distinguish all historical prices and disable any
   execution-adjacent inference from replay state. Status: met for a single
   chart's loaded window (frozen snapshot, prefix-only studies, step/play/speed,
   slider and close-time seek in the selected display zone (UTC by default),
   labelled historical view outside the live layout);
   partially met overall. Multi-chart replay, saved sessions, deeper attested
   history and order simulation remain open, and full forward-seek feedback p95
   of 105.7 ms still **fails** the 100 ms target
   ([completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md)).
5. **Measured performance:** visible chart under sustained streaming, 10k/50k
   history, many studies/drawings, pan/zoom and memory lifecycle; repeat on slow
   CPU/mobile. Preserve identical data/workload/environment for comparisons.
6. **Long-tail capability:** volume provenance, custom study sandbox, server-side
   alert delivery, specialized aggregation, cloud workspaces. A licensed advanced
   engine may reduce renderer work but does not supply ARX data truth, alerts,
   execution safety, a Pine ecosystem, or production acceptance automatically.

Scanner now uses the shared native chart, so these features reach its real page.
Integrated Scanner acceptance and performance must still be tested independently;
prior standalone measurements are not Scanner results. Self-trading reliability is also a separate
workstream; chart quality is not evidence of trading profitability or readiness.

## Performance reporting rules

The earlier five-study fixture measured synchronous adapter work over 5,000
bars, not paint latency. The new visible stress harness uses 10,000 bars, 12
studies, 40 Fibonacci drawings and 1,800 paced updates, recording setup, burst
CPU, frame intervals and long tasks. Frame intervals reflect browser scheduling;
they are not direct paint-completion timestamps. Public TradingView demo data
and a broker-fed MT5 terminal are not equal-input control groups. Do not label
ARX faster until an appropriately controlled comparison supports that claim.

The replay workload is separate: 5,000 constructed closed bars and 12 actual
studies with all APIs intercepted, at 4× CPU throttling on an Apple M4 Pro host,
recording installation, next display opportunity and second-animation-frame
feedback separately. Its first checkpoint (Headless Chrome 155;
[replay](SMART_CHART_REPLAY.md)) recorded previous/next second-frame p95 of
72.5/73.5 ms and first→5,000th bar p95 of 136.8/142.3 ms (**FAIL**) across the
two retained-candidate trials (of four alternating build trials). The later paired run
([completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md), 37-name
reader) recorded step 36.9 ms and full forward-seek 105.7 ms (**FAIL**)
second-rAF p95. Raw evidence is retained outside the repository in
`arx-tier1-release/smart-chart-replay-20261026` and
`arx-tier1-release/chart-replay-completion-performance-20261026`. The 4×
throttle applies only to the replay figures; the 10k/50k stress runs state no
CPU throttle. Report replay against the owner's 100 ms p95 target, and do not
describe stepping as PASS unless a run records one.

Measurements from the six held branches listed in the
[27 October checkpoint](ARX_CHECKPOINT_2026_10_27.md)
(`codex/chart-replay-earned-checkpoints`, `codex/replay-cache-combined`,
`codex/replay-checkpoint-packing` and the three `codex/chart-reader-lazy-*`
branches) are excluded. Their 217.2 ms cold completion, 130.5 ms first rewind
and 147.1–152.7 ms forward-seek figures describe held experiments, not the
combined source.

See [calculation conventions](SMART_CHART_STUDY_CONVENTIONS.md) and
[acceptance evidence](SMART_CHART_ACCEPTANCE.md). The Tier 1 architecture gate
score is independent of this feature checklist and must not be reused as a
Smart Chart completion percentage.

Integrated Scanner replacement and exact-source browser evidence: [28 October integration receipt](SCANNER_SMART_CHART_INTEGRATION_2026_10_28.md).


28 October follow-up: Scanner zoom/pan and mobile Tools each have 80 retained
samples per CPU setting on `cc7ad0e0`, below 100 ms p95 in the bounded 200-bar
unavailable-analysis fixture. Trusted native style selection could not be exercised,
so the overall run remains FAIL/partial. The small mixed before/after differences
do not establish faster clicks. Idle note/drawing work decreased in a separate
18-second diagnostic; neither result supersedes the heavy-load and replay misses
above. All TradingView logos are disabled in the two runtime constructors at
`8e87e55d`; required plain-text library credit remains. See the exact sources,
controls, failures and limitations in the [follow-up receipt](SCANNER_SMART_CHART_INTEGRATION_2026_10_28.md#follow-up-no-chart-logos-and-measured-scanner-work).


Final functional source `e011f25a`: 43 ordinary-user Scanner assertions and
158 synthetic-admin assertions across the four former embed pages pass, including
logo absence and full horizontal mobile chart/control bounds. This fixes a verified
AI Assist mobile grid clipping defect; earlier failures remain in the receipt.
Required library credit is plain text. The bounded timing source remains `cc7ad0e0`.


## 31 October follow-up: price-only automatic fitting

Source6f170f84 adds the previously missing choice to exclude overlay indicators from automatic main-price fitting, with oscillator data/scales unchanged and persistence/private-replay wiring. Actual Scanner synthetic200-bar wide-band fixture passes40measured toggles:normal/4xCPU p95=49.0/48.1ms, with a source-identical visible price span expanding10.3→308.1pixels. This is a scoped ARX-only offline result; MT5 fixed/one-to-one scale features, mobile acceptance and matched competitor performance remain open. See [source, tests, all samples and limits](SMART_CHART_PRICE_ONLY_SCALE_2026_10_31.md). Older measurements above are retained for their original sources; they are not replaced by this different interaction.


## 31 October follow-up: parallel channels

Sourceb107f1db adds manual three-anchor parallel channels with width/whole-object edits, locking and local undo/persistence. Final264e53d1 actual Scanner fixture passes20mouse/emulated-touch placements, logarithmic rendering and source-correct reload; maximum third-press completion84.7ms in this small offline workload. Extensions,fills,extra channel levels,physical touch and matched competitor performance remain open. See [full channel evidence and limitations](SMART_CHART_PARALLEL_CHANNEL_2026_10_31.md). Replit navigation still fails its own acceptance independently of these channel results.

## Selected-chart reference check — 1 November 2026

TradingView consumer documentation distinguishes layout-wide and chart-specific settings; indicators are per-chart unless explicitly applied to the layout. It currently describes one to16 charts depending on subscription. ARX supports up to four; larger layouts and cloud syncing remain gaps. [Official consumer layouts](https://www.tradingview.com/support/solutions/43000692404-layouts-charts-drawings-indicators-and-their-interaction/)

The separately licensed Trading Platform library documents indexed charts and an activeChart owner, and up to eight charts. This is a different product from the consumer service and from ARX's rendering library; its limits are not interchangeable. ARX now has its own selected-pane assistant owner, not this platform API. [Official library layouts](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/multiple-chart-layout/)

MT5 documents chart-scoped controls and distinguishes Forex tick volume from exchange trade volume. The current ARX validation retains that distinction without claiming matched terminal calculations or speed. [Official MT5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage/)

Current offline evidence and limitations: [9982b545 selected-pane acceptance](SMART_CHART_ANALYSIS_SELECTION_2026_11_01.md). Research responses are retained in the raw validation directory; no broker or competitor benchmark was performed.

### Scanner first-view evidence — 1 November 2026

`43ff8bb6`, actual Scanner offline build `6e228bd25378ed10`: source-correct visible
first-click completion passes 10/10 normal-speed attempts (desktop median56.0ms,
max62.3ms;390px phone median51.8ms,max53.5ms). Controlled4x CPU still misses100ms
in all10 attempts (desktop median271.8ms,max377.1ms;phone median262.5ms,max296.5ms).
These synthetic-history, prepared-browser, two-frame observations are not physical
paint, published-app/provider timing or TradingView/MT5 comparison. Very narrow
and later-warning layout gaps remain. Earlier failed attempts and host contention
are retained in [the exact-source report](SCANNER_FIRST_VIEW_ALIGNMENT_2026_11_01.md).
No parity, superiority or completion percentage is inferred.

The final normal candle requests began108.6–128.6ms before clicking through the
existing app warmup; these are post-click display timings, not click-initiated
fetch-plus-render. Mock preparation completion is not browser receipt.


## Compact evidence and source-bound stream followup — 1 November 2026

Application31a45ff9 keeps restriction names visible, exposes full explanations by keyboard-accessible disclosure, removes false reconnect warnings from nonstream sources, and skips unused anchor-evidence updates. Actual Scanner22Truth+275desktop+35phone stock assertions pass;frontend3319pass/11skip. Normal firstclick10/10within100ms;4xCPU0/10. No broadspeed,provider,parity orcompletionclaim. See [exact source and limitations](SMART_CHART_COMPACT_EVIDENCE_2026_11_01.md). Existing strategy sizing/equity/benchmark and broader natural tool commands remain open; separate frozen-result followup work is not included in this receipt.


## Selected historical outcome followup — 1 November 2026

Applicationf85d1c03 extends the existing selected frozen-ledger explanation with “Why did this trade lose?” and fixes polite requests clearing the prior result. Current binding and explicit selection remain mandatory; positive/zero results are not described as losses. Combined3332frontendpass/11skip,87guards,7bindings,typecheck,ordinarybuild and36actualScanner browser assertions pass. This does not add capital/sizing/equity/benchmark or general strategy language. Replit importb3029eb8 excludes this newer increment. See [receipt and limitations](SMART_CHART_FROZEN_TRADE_FOLLOWUPS_2026_11_01.md).


## Source-bound support/resistance increment — 1 November 2026

On `831e958d`, the existing horizontal-object owner renders two confirmed-pivot candidates through manual controls or the selected-chart assistant. Keep/edit preserves original evidence separately from manual anchors. 56 actual Scanner browser assertions pass. Fixed strict two-neighbor pivots are not Standard Pivot Points, full zone discovery, or matched competitor output. Normal first-click 10/10 meets 100ms; 4x CPU 0/10. No speed superiority or platform parity follows. See [the exact-source receipt](SMART_CHART_SUPPORT_RESISTANCE_2026_11_01.md).


## Study assistant settings — 1 November 2026

Application `35fd2aa2` exposes existing MACD periods and signal method plus Bollinger deviation through the same manual validator. Independent calculations match actual Scanner series; manual and assistant settings agree. This is not general-language or matched-platform acceptance. TradingView oscillator-type selection remains a gap; phone MACD label crowding and slower-device loading remain open. See [verified references and exact acceptance](SMART_CHART_STUDY_EXPLANATIONS_2026_11_01.md).


## Assessment identity followup — 1 November 2026

Application `adc7a76f` makes Scanner/scalp interval aliases share assessment state and requires response market/interval echoes to match the request. Full frontend 3,860 pass/11 skipped; typecheck/build pass; 85/87 guards with unchanged violations. Account/source/window/time and draft binding remain open. This is a correctness increment, not competitor parity or browser latency evidence. See [exact validation and limits](SMART_CHART_READ_MARKET_IDENTITY_2026_11_01.md).


## Captured assessment followup — 1 November 2026

Application `5648453f` prevents primary assessment inputs and broker enrichment from switching observations across awaits, restores canonical higher-timeframe mapping, and uses the actual pivot period/latest closed bar. New suite 40 pass; existing backend 145 pass; structure 9/9; frontend 3,861 pass/11 skipped. Builds/typechecks pass; guards remain 85/87 with unchanged findings. A counterbalanced offline 200-bar builder comparison measured approximately **0.45 ms added cost**, not a speedup. Cross-surface source/account/window/age binding, slower-device loading and platform parity remain open. See [exact source, receipts and limits](SMART_CHART_CAPTURED_ASSESSMENT_2026_11_01.md).


## FVG source and output followup — 1 November 2026

Application `a01817bb` shares normalized, source-bound FVG inputs across the assessment and Scanner, fully withholds entry signals/price prose when restricted, and fixes Scanner provider timestamp preservation. 59 capture/FVG tests, 46 provenance/Truth tests, 21 FVG script checks, all four typechecks and both builds pass; frontend 3,861 pass/11 skipped. Guards remain 85/87 with unchanged findings. MT5/Deriv without original UTC evidence stay withheld; no latency or competitor parity claim follows. Draft binding and broader comparison gaps remain open. See [exact source, evidence and limits](SMART_CHART_FVG_EVIDENCE_2026_11_01.md).

## Exact draft assessment binding — 1 November 2026

Application `27a4605f` withdraws assessments after plan changes and isolates different chart/scalp plans while retaining exact-plan sharing. Focused 132 pass, full dashboard 3,904 pass/11 skipped, all four typechecks and production dashboard build pass. Seven actual Scanner browser checks pass with synthetic history and restricted replies; guards remain 85/87 with identical baseline failures. This proves local request-plan handling, not account/source/window/expiry authority or competitor performance. The ordinary build still shows a TradingView rendering-library credit; the owner's no-TradingView requirement remains open. See [exact evidence and limits](SMART_CHART_DRAFT_BINDING_2026_11_01.md).


## 1 November 2026 — independent renderer foundation (50b3adaf)

The owner’s own-renderer/no-branding requirement remains open. Scanner overlays now use an ARX-owned revocable interface; a staged native Canvas price layer independently renders all seven existing styles with canonical-price coordinates. It is not registered as an app engine. The default remains Lightweight Charts until the existing studies, drawings, gestures, history, replay and all chart surfaces are migrated and accepted.

Full dashboard validation: 3,996 passed / 11 skipped; typecheck and build passed; guards 85/87 with unchanged findings. Seven actual Scanner offline draft checks pass for the facade. The separate native laboratory has 67 unit checks, 7 caught mutations and synthetic desktop/narrow browser checks. Its small Canvas submission timings are not app first-click latency, hardware presentation or competitor evidence. Original slower-device failures and TradingView/MT5 feature/performance gaps remain. See [exact evidence and migration requirements](SMART_CHART_NATIVE_RENDERER_2026_11_01.md).


## 1 November 2026 — independent viewport (5f734e30)

The staged ARX renderer now has axes, pointer/wheel/touch navigation, canonical crosshair, history anchoring and export. Thirteen synthetic desktop/mobile browser groups pass; it is still not the Scanner engine. The native full-refresh measurement retains a 26.9ms outlier under 4x CPU. No actual-app speedup or competitor parity is claimed. Axis dragging, full adapter/study/drawing migration and all-surface acceptance remain open; the default external renderer and credit remain. See [exact source, metrics and comparison boundaries](SMART_CHART_NATIVE_VIEWPORT_2026_11_01.md).


## Native studies foundation — 1 November 2026

Application `650c4728` migrates the existing 23-kind calculator catalogue into native Canvas overlays/panes without new indicator math. 199 focused tests, 4,137 full frontend tests, seven study browser groups and 13 viewport groups pass; typecheck/build pass, guards remain 85/87 unchanged. This is not yet the Scanner adapter. Five-study initial setup takes 152–157 ms at 4x CPU; full-history preparation p95 34.7–35.1 ms remains a frame-budget gap. No instantaneous loading or competitor parity follows. See [exact receipts and limits](SMART_CHART_NATIVE_STUDIES_2026_11_01.md).
