# Scanner candle delivery timeline — 31 October 2026

Status: diagnostic tooling and evidence; **no application performance fix or parity claim**. Application code remains the accepted `f9eb6c5d` through base `1fc600fe`. The held panel-mount experiment is not included.

## Exact source and evidence

Instrumented fixture source **d34a9a110cb25cfded13bb56841b6238ee4f3f95**, diagnostic build **5ab0630efba190d2**, clean source. Two visits: desktop1440×1100 and mobile390×844 at controlled4× CPU slowdown. Real Scanner App/providers/route/chart; 200 synthetic historical candles, APIs intercepted, trading disabled. React profiling and observers add overhead: these are not ordinary-runtime acceptance timings and must not replace previous failed latency measurements.

Final tooling source **ca1685c2f216aa9abda29180919742dc0d0da2ad** adds only one error-preservation test after that capture. Ordinary production-runtime fixture **e960a2c81a4dd54a** was built clean on this final source. Subsequent receipt commits do not change application or diagnostic implementation.

## Observed timeline (milliseconds from trusted Scanner click)

| Stage | Desktop | Mobile |
|---|---:|---:|
| Browser resource responseEnd |137.8|68.4|
| Fetch promise callback observed |327.2|234.5|
| Response.json started |327.2|234.6|
| Response.json resolved |373.5|279.9|
| Shared candle query success |374.4|280.9|
| Engine begins installing200 candles |412.9|339.6|
| Engine finishes installing200 candles |416.1|341.4|

No timeline events were dropped. Cache success follows JSON completion by0.9/1.0ms. Engine installation itself takes3.2/1.8ms. There are roughly189/166ms between browser responseEnd and the observed fetch callback, with multiple empty-chart renders/commits during startup. There is another46/45ms between starting and finishing the JSON promise; this elapsed interval includes scheduling and is **not a measurement of JSON parse CPU time**. Render events may be abandoned; separate layout-effect commit records identify committed renders.

Inference: main-thread startup work and response scheduling are higher-priority suspects than candle installation or cache processing. These observations do not prove every millisecond is CPU work, establish the same cause in Replit, or justify bypassing source validation. Next candidate should reduce unnecessary empty-chart/initial-layout work; retain the full source-correct witness and separately verify no-data/error states, delayed history, ticks, source changes and interaction readiness. Investigate with an ordinary-runtime trace before assigning exact CPU blame.

## Tooling isolation and checks

Only the existing `--react-profile` fixture on127.0.0.1:4299 installs the timeline. It refuses other origins and duplicate installation. Exact-anchor Vite transforms instrument the known App/query, Scanner panel and Native chart seams without editing application files; changed/missing seams fail the diagnostic build. Recording is bounded to2000 events. It records stage/time, counts, query action/status and booleans, never credentials, candle payloads, positions or account values. Fetch arguments/signals, response data, original error objects and engine return/throw behavior are preserved by tested wrappers. The wrapper adds promise/observer overhead, explicitly diagnostic-only.

**103 tooling tests pass, 0 fail/skip**, covering isolation, bounded records, exact transform seams, request/abort identity, JSON/engine failures, existing source/visibility witness and profiling acceptance rejection. Normal build asset inspection finds no timeline identifiers. A separate normal-runtime browser check confirms both diagnostic globals absent, exact canonical and displayed equality for all200 candles, and zero page exceptions. Source diff confirms no files under application `artifacts` or `lib` changed. Full frontend/backend/root/database suites were not rerun for fixture-only tooling. Review was self-review, not an independent agent.

Initial tooling invocation used the wrong relative output path and then could not locate the new test. The corrected-path invocation omitted this workspace's offline runtime wrapper and failed to locate the esbuild platform binary; the existing plain-JS checks still ran. The wrapper-corrected runs pass. Failed logs remain in the archive. Both builds succeeded with existing build warnings. Owned browser/server sessions were closed after verification.

## Continuation and boundaries

Replit's already-authorized accepted follow-up from `1fc600fe` was confirmed busy by a read-only query; it was not restarted, and the question was not queued. Retrieve its final exact combined source and receipts later. This diagnostic branch has not been imported into Replit. No main merge, publishing/deployment, existing-database change, worker/trading activation, funds movement or live/demo broker test.

Archive: `docs/validation/chart-candle-timeline-20261031/manifest.json` includes original and gzip SHA-256 hashes. Raw files: `/Users/areyouok/arx-tier1-release/chart-candle-timeline-20261031`. Browser payloads retain full fixture metadata, React profiles, timeline, canonical/displayed candles and blocked-network evidence. Competitive feature/performance gaps remain open; architecture and launch readiness are not established.
