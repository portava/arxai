# Scanner toolbar layout-containment experiment — 31 October 2026

Verdict: **HELD — do not import or use as the next accepted application base.** The original startup target is still unmet. This branch preserves a rejected experiment and its evidence, not a release improvement.

Candidate application `632ac5af564463a2dce25e7adc82b3194d622cf7` adds only `contain: inline-size layout` to the chart workbench root. Base `b90d5b3fa957fe493d3b4c5af8eeea56c0f757e9` contains accepted application `5f9a1c82ee9f0cca12c99c1dc48b59c68b4e263d` and QA-only observer `5ac145e02db4d7579db062f1c458b9f48c8f7f96`. **Continue accepted work from b90d5b3f, not this branch.**

## Hypothesis and scope

The previous CPU trace identified synchronous workbench measurement as a layout cost. This candidate tests whether isolating the toolbar's inline sizing/layout helps without hiding, delaying or removing any controls. It retains the existing synchronous measurement, ResizeObserver and focus/disclosure behavior. It is different from the previously held offscreen content-visibility and observer-only toolbar experiments; those remain excluded.

The W3C [CSS Containment Level 2 draft](https://www.w3.org/TR/css-contain-2/) describes isolation of layout and inline-size dependencies. [MDN's contain reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain) notes containment also creates formatting/containing contexts. These documents motivate a test; they do not prove ARX benefits or establish compatibility for every chart overlay.

## Matched local navigation measurements

Unchanged baseline fixture `caa203fa46f4cb69` at clean observer commit `5ac145e0`; candidate fixture `72657e516b17ea2d` at clean application commit `632ac5af`. Both ordinary minified production-runtime fixtures, not diagnostic/profiling builds. Same actual Scanner route/providers/styles, fixed 80ms synthetic candle response, all API traffic intercepted, no live analysis or broker. Prepared browser resources; each attempt reloads the full document. This is not a cold browser process or the owner's published app.

Order: baseline 4× slowdown, baseline normal, then fresh candidate browser 4× slowdown and normal. Five desktop and five phone-width attempts per batch. No competing owned tests/builds ran during measurement. Host-wide contention is not proven absent. All **40 planned attempts recorded and source/visibility valid**, no retries or discarded outliers. The 150ms ready-to-click gate and 100ms source-correct visible completion gate are unchanged. Completion compares every canonical/displayed OHLC value, actual series/source/timeframe and unobscured plot across rendering frames; early shells do not count. Rendering opportunities do not prove hardware paint.

| Build / CPU | Desktop median / max ms | Phone-width median / max ms | ≤100ms |
|---|---:|---:|---:|
| Baseline / 4× |354.1 /411.2|341.4 /411.2|0/10|
| Candidate / 4× |376.7 /402.5|344.7 /393.5|0/10|
| Baseline / normal |56.2 /57.1|51.8 /54.5|10/10|
| Candidate / normal |53.6 /58.5|52.5 /55.2|10/10|

No reliable benefit: slowed desktop median worsened22.6ms, phone-width median worsened3.3ms. Some maxima improved, but normal results are essentially unchanged and all slowed runs fail. Small sequential groups do not support a statistical superiority claim. No further timing runs were justified for this candidate.

## Validation and retained failures

Focused workbench suite40/40 passes; isolated production fixture build succeeds. No full regression/backend/root/database suite is claimed for this rejected one-line candidate. Corrected actual-Scanner functional run18/18 passes: delayed response keeps the same focused search field and its value, the field stays visible/unobscured, all canonical/displayed OHLC match, real provider-source change resets old controls while retaining the engine, no horizontal overflow or page exception on desktop and phone width. Both screenshots inspected. This does not override the failed speed outcome. Initial functional harness compared JSON property order instead of corresponding OHLC fields and stopped at source equality; it retained the failed result. The library's display points put `time` last, while the authority puts `time` first. Corrected harness projects the same five exact fields (time/open/high/low/close), preserves array order/count and captures full evidence; no numeric tolerance or source gate was relaxed. The same normalized comparison already exists in the strict navigation runner.

The first summary helper accidentally looked for nested timing fields and displayed nulls; raw results already held valid top-level times. The corrected summary reads those top-level fields. No measurement was repeated or changed because of that reporting mistake.

## Continuation

Replit still reports the existing accepted drawing-shortcuts/DMI update busy; read-only questions were not queued, no replacement job started. Individual study-line controls from b90d5b3f remain locally accepted/pushed and await their own selective development import after the current remote result is verified. Keep API activation deferred and preserve concurrent auth/safety/Truth/funds/recorder work.

Next startup work needs a different mechanism: diagnose remaining React mount/effect and stylesheet/layout invalidation costs, or a critical-path data/cache delay with exact source evidence. Do not reintroduce this or older held experiments, substitute early feedback for full completion, or relax acceptance. TradingView/MT5 capability gaps, fair competitor timing, physical device/provider/owner-authenticated acceptance and original launch-readiness work remain open.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-toolbar-containment-20261031`. Portable archive and hashes: `docs/validation/chart-toolbar-containment-20261031/manifest.json`. Owned local browsers/servers closed. No main merge, Replit application import, deploy/publish, existing-database change, API/worker activation, funds movement or live/demo broker test.
