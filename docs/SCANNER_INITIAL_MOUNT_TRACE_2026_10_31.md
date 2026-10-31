# Scanner initial-mount trace — 31 October 2026

Diagnostic evidence, not an accepted speed improvement. Application unchanged at `7fd1c3ac399e63b73c25040375dc49df575c9176`, fixture `64a08af4b1ceeaa6`. The preceding object-control source remains locally accepted; the held toolbar/containment experiments are excluded.

## Method and result

Captured Chrome devtools.timeline and blink.user_timing events during the unchanged strict first-navigation runner: five desktop and five mobile-width attempts, 4× CPU slowdown, fresh document per attempt, fixed offline 80-ms candle response. Tracing begins before the runner and adds overhead. All ten source/visibility witnesses remain valid; all ten exceed the ≤100-ms target. These diagnostic timings must not replace ordinary acceptance measurements.

| Diagnostic | Desktop, n=5 | Mobile width, n=5 |
|---|---:|---:|
| Synchronous trusted-click dispatch range | 120.97–136.28 ms | 118.35–124.87 ms |
| Source-correct visible completion range | 315.0–334.8 ms | 280.4–302.9 ms |
| Median inclusive style recalculation | 47.04 ms | 42.85 ms |
| Median inclusive layout | 17.29 ms | 16.95 ms |
| Median inclusive paint | 15.60 ms | 11.44 ms |
| Median inclusive timer events | 59.64 ms | 47.69 ms |

34,375 trace events retained. Event categories nest and overlap; their durations are not additive or exclusive JavaScript costs. Summarizer pairs the ten click-dispatch events with ten trusted attempts in order and rejects missing/null completion evidence. Windows begin at trace dispatch and use the sample completion duration, so they are approximate diagnostic windows, not exact input-time partitions.

The largest first desktop click event is 136.28 ms. Its nested React scheduler callback is 130.22 ms. The same window contains a 24.81-ms style recalculation touching 762 elements. The trace supports prioritizing synchronous page mounting, style/layout and follow-up update work. It does not identify all component costs or prove one optimization will recover those milliseconds.

The earlier React profiling build at `6345956d` provides supporting, separately sourced context: the first Scanner commit included 39.2-ms root rendering and 34.6-ms effects on desktop, and a later 19.5-ms render/17.4-ms effects commit where ChartWorkbenchTools remounted. These are different source/runtime observations with profiling overhead; no timing subtraction or cross-source speed claim is valid. The initial unresolved feed context becoming source-bound is a candidate for further investigation, not a proven removable reset. Source isolation must remain intact.

## Next action and boundaries

The next experiment should reduce redundant initial chart/page setup and source-bound update work while retaining all safety resets, canonical candle provenance, overlay ownership and full page readiness. Profile actual engine/context transitions before changing lifecycle behavior. Do not count skeletons, postponed analysis or offscreen canvases as completion, and do not relax the existing navigation gate. Ordinary matched baseline/candidate measurements must decide whether an implementation is accepted. Earlier rejected toolbar measurement and containment changes stay held.

Chrome's [performance reference](https://developer.chrome.com/docs/devtools/performance/reference) describes traces for diagnosing runtime activity and cautions that CPU slowdown is relative to the host rather than true mobile CPU simulation. This trace uses resized desktop Chromium, unavailable AI truth and intercepted fixture APIs. It does not establish physical-device, actual provider, production, TradingView or MT5 performance. All failed attempts and expected offline API errors remain in the compressed receipt.

Portable setup/trace/summarizer scripts, full compressed trace and SHA-256 manifest are in `docs/validation/scanner-mount-trace-20261031/`. Decompress `trace.json.gz` beside `summarize.py` to reproduce the summary; the script refuses a partial ten-attempt trace. Exact source is embedded in the runner and verified by the existing fixture witness. All owned browser/server processes closed. Replit's render-isolation import was confirmed busy and not restarted. No deployment, main merge, existing-database change or broker test occurred.
