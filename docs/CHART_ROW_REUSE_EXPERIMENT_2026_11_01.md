# Price-row reuse experiment — 1 November 2026

Verdict: **HELD, QA ONLY. Do not import into the application or Replit.** The 50,000-candle frame improvement repeated, but smaller-history setup and some worst-frame results regressed. No case met the strict 16.7 ms p95 frame-proxy target. This does not establish faster Scanner navigation, TradingView/MT5 parity, launch readiness or architecture completion.

Tested tooling commit: `6d5a3bc1a247545c115fb25f1c233adfb0334554`, based on `da62c7a5595f63be526362c3327a27366da6dc68`. Application source remains unchanged from the accepted ruler work. Both builds used this exact clean commit, production React and a minified Vite build, with no edits during build or timing:

- Baseline build `dabc1f46416b2a69`: unmodified dependency; experiment metadata is null.
- Candidate build `60c7a43ae6503141`: the explicit QA-only `--price-row-reuse-experiment` flag.
- Dependency: lightweight-charts 5.2.0 production module, input SHA-256 `8f941c04ad6eae2970b21a50be54c5f23778e18c1dfcddaf66574dd8ed2e0945`. Exact transformed hash, bundle hashes and build metadata are in `build-manifest.json`.

## Change and correctness

The vendor colour helper already accepts a known row to avoid searching the history again. The experiment passes the existing row through only for Bar and Candlestick pane builders, and only when the rendered row collection is the exact original collection. If zoom conflation creates a different collection, the original lookup remains: an aggregated candle may have a different direction or colour from the original candle at its index. Full history remains installed; there is no decimation, dropped update, altered study calculation or lowered threshold.

This is an in-memory Vite transform confined to the QA build, not a change to shared node_modules, the dashboard build, package lock or application imports. An unknown dependency hash, missing seam or duplicate/unmatched transform fails the build. Upstream banners/notices are retained. Source inspection included the installed development and production modules and [the versioned upstream colour helper](https://github.com/tradingview/lightweight-charts/blob/v5.2.0/src/model/series-bar-colorer.ts). Line/Area/Baseline/Histogram and custom-series paths are unchanged.

On the exact commit, 11/11 semantic/transform checks passed. These execute the actual vendor colour functions and pane-item builders with unrelated model/render bases stubbed. They cover up/down/flat candles, per-row body/wick/border overrides, 100 successive final-row revisions, deliberately conflicting conflated data, exact-dependency rejection and missing/duplicate transformation. They compare geometry and colours against the unmodified vendor functions. Two mutation checks were caught: restoring redundant lookups failed six row-reuse assertions, and removing the conflation fallback failed both Bar/Candlestick conflict assertions. Each mutation also fails the transformed-byte consistency assertion; the behavioural failures were checked separately. These are not native canvas pixel comparisons or a substitute for full app/style/replay checks.

## Matched measurements

The previously checked-in matrix ran against the same source/build settings in baseline → candidate → candidate → baseline order, using fresh documents and a fresh browser per matrix. Each case uses full canonical/display history, 12 studies, 40 drawings per view, 180 frames, ten final-candle revisions per frame per view and periodic pan/zoom. Four views also link their ranges and crosshairs. No concurrent owned build or tests ran during timings; whole-machine quietness was not proven.

All 16 cases in the matched comparison were valid. All 72,000 accepted updates, complete canonical/display OHLC, computed/rendered study values, visibility and range checks passed; all 2,880 frame samples and outliers are retained. No page exceptions. A prior complete baseline also passed all four cases (18,000 updates, 720 frames); it remains in the receipts, giving 20 valid cases and 90,000 accepted updates overall. None passed the frame-proxy target. The study oracle is a full recomputation with the same calculator, not independent validation of indicator formulas.

P95 frame intervals, milliseconds:

| Workload | Baseline 1 | Candidate 1 | Candidate 2 | Baseline 2 |
| --- | ---: | ---: | ---: | ---: |
| 10k candles, one view, normal CPU | 33.4 | 33.4 | 33.4 | 33.4 |
| 50k candles, one view, normal CPU | 66.7 | 33.4 | 33.4 | 66.7 |
| 5k candles, four views, normal CPU | 33.4 | 33.4 | 33.4 | 33.4 |
| 5k candles, four views, 4× CPU slowdown | 133.2 | 100.1 | 100.1 | 100.1 |

Important retained regressions and limits:

- 10k setup: baselines 165.7/163.4 ms; candidates 197.3/197.6 ms.
- Four-view normal setup: baselines 306.2/303.1 ms; candidates 303.6/336.7 ms.
- Four-view normal maximum frame: baselines 33.4/49.9 ms; both candidates 66.7 ms.
- Four-view slowed maximum frame: both baselines 133.4 ms; candidates 166.7/166.6 ms. The second baseline's p95 equalled the candidate, so there is no repeatable p95 win for that case.
- 50k setup was lower in both candidates (573.5/573.6 vs 629.6/601.5 ms), but this measures synthetic fixture setup through three frames, not a user's first Scanner click, network data arrival or physical paint.
- These baselines are slower than the preceding session. Do not compare sessions as an optimization claim or discard this session's slower results. A process-name/CPU inventory was denied by the local permissions boundary; no host process was changed for performance.

## Failed preparation retained

The initial semantic-test loader used CommonJS resolution for an import-only package entry and failed before tests ran. Resolving its exported package.json and explicit production module fixed the test harness; the original failure log is retained.

The first comparison launcher completed a valid baseline, then its candidate server refused to start because terminating the Python wrapper left the owned Node fixture listening. No candidate timing was collected for that attempt. The exact fixture PID 51495 was identified and stopped; the corrected launcher starts and terminates its own process group. The entire four-run comparison was then completed. Original launcher, error, baseline and corrected runs are all retained. All final owned servers and browsers were closed.

## Next work

Do not adopt this narrow optimization. Investigate the analogous repeated colour lookup in indicator/line row preparation with an independently guarded candidate, preserving conflation semantics and full history. The current evidence does not justify thinning history or replacing supported APIs with unguarded private-property changes. Any proposed application change still needs all seven styles, scales, per-bar colours, replay, inspection, drawings, actual Market Scanner browser acceptance, and matched startup/worst-frame measurements. A maintainable pinned dependency patch would also need both development and production paths reviewed; this QA transform is not that integration.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-row-reuse-20261101`. Portable compressed receipts and their original/compressed SHA-256 hashes: `docs/validation/chart-row-reuse-20261101/manifest.json`. No full application/backend suite was rerun because no application code changed. Earlier frontend/guard/Replit results remain tied to their own exact commits.

No Replit import, main merge, deployment/publication, existing database change, API/worker activation, email, funds movement or live/demo broker test occurred. Replit remains at the completed ruler source `4348fc6ae7cfbbdbdc527163ab18ee06416f47cd`, checkpoint `124f5ccc9ecca97a07f2b27a15f9a85a1df8d23e`; this turn did not change it. API activation and all broader competitive/launch gaps remain open.
