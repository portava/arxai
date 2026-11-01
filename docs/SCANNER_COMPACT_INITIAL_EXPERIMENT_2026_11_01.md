# Scanner compact initial toolbar experiment — 1 November 2026

**HELD: do not import this branch into accepted development source.** Candidate `d8c1651b23fe4b0d111cd2c1a7dcdff363941622` passes functional checks but does not establish a repeatable startup improvement. Accepted base remains `c9b3c6e215937a10b803217e22c3ebfbaf23bff4` (tested application `0ba7e8ddbb1ab12c8693da2f22a6c2692d63a063`). No launch readiness or competitor parity is claimed.

## Diagnosis and hypothesis

Two fresh diagnostic traces on accepted c9b3c6e used actual Scanner routes, providers and styles with synthetic responses, desktop 1440×1100 and phone-width 390×844, 4× CPU. These instrumented observations are separate from acceptance timing: diagnostic fixture `358467914caffe08` contains profiling machinery and the runner starts profiling before clicking.

In these traces, selected-candle JSON resolved 13.0ms before the desktop click and 17.6ms before the phone click. First 200-bar installation finished at 157.5ms and 137.1ms after click. First Scanner React commits appeared at 158.8ms and 137.3ms, with root render durations 59.8/59.3ms and effects 56.9/55.8ms. Inclusive component durations overlap; they must not be summed. The later duplicate 200-bar installation cost only 0.6/1.3ms.

CPU sampling attributed 47.1/44.3ms to the toolbar's layout-measurement callback across the whole capture. The source location reads computed style and pane width before setting compact mode. Sampling does not prove all of that cost belongs to first navigation, and much of the capture is unattributed. Chrome's guidance describes synchronous layout after style changes as a profiling target, not proof that this particular edit improves performance. [Official layout guidance](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing).

The candidate initializes compact mode when the viewport is below 640px, then retains the existing synchronous pane measurement, ResizeObserver and focus protection. It aims to avoid initially expanding and immediately collapsing phone controls. Unlike the older held observer-only experiment, it does not remove pane measurement or initialize desktop views compact. No feeds, trading paths or data semantics change.

## Exact-source functional evidence

On d8c1651b: frontend **2719 pass / 0 fail / 11 skip** (180 files pass, 1 skipped); domain build, dashboard typecheck and production build pass; **87/87 guards**, **7/7 bindings**. Actual Scanner functional acceptance **18/18** covers delayed data, focus retention, source replacement, exact canonical/display OHLC, engine continuity and desktop/mobile overflow. These are self-reviewed, offline checks, not independent review, API/backend/database acceptance or broker tests.

## Startup comparison: all attempts retained

Ordinary minified production fixtures: accepted baseline `0aca1b3ae8788cb6`, candidate `b1a4478760aebf4b`. Unchanged checked-in first-navigation runner, fixed 80ms synthetic candle delay, actual Scanner route, full document reload per attempt and fresh named browser context per batch. Browser resources are prepared; this is not a cold browser or real provider test. All owned builds/tests finished before timing; host-wide contention is unknown.

Completion requires exact canonical/display OHLC and actual series/source/context, an unobscured 100-pixel plot and two rendering frames. It is not physical GPU paint. The ≤100ms completion target and ≤150ms readiness-to-click validity gate were not relaxed. The final reversed-order pair was declared after mixed initial results; no further retries followed.

| Batch in execution order | Desktop median / max ms | Phone median / max ms | Valid / planned | ≤100ms |
|---|---:|---:|---:|---:|
| Candidate 4× |306.0 / 408.6|243.9 / 339.4|10/10|0|
| Candidate normal |54.9 / 58.6|49.6 / 50.1|10/10|10|
| Baseline 4× |260.3 / 341.9|248.0 / 341.9|10/10|0|
| Baseline normal |53.9 / 56.9|49.6 / 52.1|10/10|10|
| Baseline 4× repeat |262.3 / 312.9|248.7 / 350.1|10/10|0|
| Candidate 4× repeat |261.7 / 275.5|381.6 / 484.0|9/10|0|

Distributions use the existing runner's selected middle sample convention (upper middle for even counts) and valid attempts only. The invalid repeated phone attempt is retained: readiness-to-click **186.4ms**, observed completion **557.6ms**, excluded from the valid distribution because it exceeded the declared 150ms click window. It is not a passing result or discarded outlier. All 60 planned attempts recorded: **59 valid, 1 invalid; 20 normal attempts pass the target; 39 valid slowed attempts fail it**. No meaningful repeatable gain is established. The candidate stays held; do not attribute the mixed differences solely to this edit or to noise.

## Receipts and next action

Raw logs, JSON, diagnostic profiles and run scripts: `/Users/areyouok/arx-tier1-release/scanner-startup-refresh-20261101`. Portable gzip receipts and SHA-256 manifest accompany this report. The diagnostic build's original build.log was overwritten by the ordinary dashboard build log; diagnostic metadata survives in profile.json. This limitation is recorded rather than reconstructing a missing log.

Continue from accepted c9b3c6e, not this branch. Investigate initial route style/layout and rendering of secondary analysis without deferring essential controls or weakening timing/source/focus acceptance. Previous held panel-mount, containment, observer-only, toolbar-phase and resize experiments remain excluded. TradingView/MT5 capabilities and matched runtime performance remain unfinished; no percentage is assigned.

The existing Replit multi-chart/interval-following import is still busy according to read-only connector checks; bounced questions were not submitted or queued. This experiment was not sent to Replit. API activation remains deferred. No main merge, publish/deploy, existing database migration, worker activation, email, funds or broker test occurred. Owned fixture processes were stopped after validation.
