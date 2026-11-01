# Indicator-row reuse and native-canvas evidence — 1 November 2026

Verdict: **HELD, QA ONLY; no application or Replit import.** This narrowly scoped optimization preserved the tested data, geometry and pixels, but produced no repeatable frame-speed improvement. Initial setup differences also varied with the run: the last baseline matched the candidates. Do not adopt the change or claim a general regression, improvement, launch readiness, TradingView/MT5 parity or completion percentage from these results.

## Exact source and implementation

Tested commit `7ced13b752c5d17d77353124e35c3f966a6f43a4`, on `codex/chart-study-row-reuse-20261101`, based on accepted QA source `da62c7a5595f63be526362c3327a27366da6dc68`. No held OHLC experiment was included. No application code, package lock, shared installed package, API or database was changed.

- Unmodified production dependency build: `39e3992f4d733ac8`.
- Candidate build: `5e97b6595fe63b1d`, using only `--study-row-reuse-experiment`.
- Both use the same clean commit, production React, minified Vite and the installed lightweight-charts 5.2.0 production module. Input module SHA-256: `8f941c04ad6eae2970b21a50be54c5f23778e18c1dfcddaf66574dd8ed2e0945`. Full transformed/bundle hashes are retained.

The QA transform passes already-known plot rows into the existing colour helper for Line, Area, Baseline and Histogram builders. It skips the redundant history search only when the displayed collection is the exact original collection. A separate/conflated collection keeps the original lookup, including its original-row colour semantics. Bar, Candlestick and Custom builders remain byte-identical. Unknown package bytes, missing/repeated seams and missing/duplicate transforms fail closed. Upstream notices remain intact.

The QA fixture now explicitly resolves this dependency from the dashboard installation: production file in the production fixture, development file in the development fixture. This lets the native-canvas probe and actual ARX adapter share the same module. No application alias or runtime imports changed.

## Correctness evidence

On the exact tested commit:

- 32 semantic/transform tests pass; QA TypeScript check passes.
- Tests execute the actual vendor colour map, helper, line base and all four pane-item classes. Unrelated constructors, rendering and hit-testing are not executed in that unit layer. Ordinary rows, per-row overrides, 100 final-row revisions, conflated high/low extremes, distinct row collections and empty data are covered.
- Two mutations were caught: restoring redundant lookup failed 12 behaviour assertions; removing the conflation fallback failed 12 behaviour assertions. Both also fail the output-byte consistency assertion. Behaviour failures were inspected separately.
- Four full renderer matrices, in baseline → candidate → candidate → baseline order, each passed all four declared cases. All 72,000 accepted final-candle revisions, canonical/display OHLC, computed/rendered study values, visibility, range and drawing checks passed. All 2,880 raw frame samples and outliers remain. No page exceptions.
- Four native-canvas probes each passed 96 cases, for 384 stable nonblank canvas captures with exact source values retained. The cases are six underlying built-in series × default/custom colours × grouping off/on × four price-scale modes. Each uses 2,048 original rows and a final-row update. Each canvas hash remains stable across an additional animation frame. Compared by case key, every candidate and repeated-baseline pixel hash equals the first baseline: **zero mismatches across 288 comparisons**.
- In every probe, enabling grouping changed pixels in all 48 paired cases, showing the grouping toggle had a rendering effect while original data remained intact.

Native pixels are canvas readbacks, not physical paint. The probe checks visible hosts, stable pixels, more than 100 pixels differing from the background and all source values; it does not separately count candle/indicator ink. It is not full ARX seven-style, drawing, replay, option-change or Market Scanner acceptance. The stress study oracle uses a complete recomputation with the same calculator, not independent validation of financial formulas.

## Performance, including outliers

The matrix retains full history, 12 studies and 40 drawings per view, with 180 frames, ten final-candle revisions per frame per view and periodic pan/zoom. Linked four-view cases verify matching ranges. It does not append bars or measure a real user's first Scanner click. Each matrix uses fresh documents and a fresh browser; cache/JIT/host effects can still vary. No owned build or tests ran concurrently with the timed work. Whole-machine quietness was not proven. Native probes ran after the timing matrix in each browser.

P95 frame intervals in milliseconds, with the strict target unchanged at 16.7 ms:

| Case | Baseline 1 | Candidate 1 | Candidate 2 | Baseline 2 |
| --- | ---: | ---: | ---: | ---: |
| 10k, one view, normal CPU | 33.4 | 33.4 | 33.4 | 33.4 |
| 50k, one view, normal CPU | 66.7 | 66.6 | 66.7 | 66.7 |
| 5k, four views, normal CPU | 33.4 | 33.4 | 33.4 | 33.4 |
| 5k, four views, 4× CPU slowdown | 100.1 | 100.1 | 100.1 | 100.1 |

Zero of 16 cases meets the target. The 0.1 ms difference is not treated as an improvement.

Setup through three frames, same order:

| Case | Baseline 1 | Candidate 1 | Candidate 2 | Baseline 2 |
| --- | ---: | ---: | ---: | ---: |
| 10k, one view | 163.4 | 197.5 | 197.4 | 198.0 |
| 50k, one view | 630.2 | 598.1 | 596.8 | 597.0 |
| 5k, four views, normal | 336.7 | 305.4 | 309.3 | 304.0 |
| 5k, four views, slowed | 1152.5 | 1116.9 | 1114.5 | 1118.1 |

The final baseline is close to the candidates, so these setup differences are not a reliable benefit or regression. Early commentary said smaller-history setup was consistently slower; the final baseline disproved that interpretation and the commentary was corrected.

Worst frames remain visible: normal four-view maxima 33.4/33.4/66.6/66.7 ms; slowed four-view maxima 200.0/116.6/116.7/133.4 ms. The slowed maximum improved in these two candidate runs but p95 did not, and four trials are not a tail guarantee. No cross-session or competitor-speed claim is made.

## Retained preparation failures

The first QA typecheck could not resolve the direct library import and found two untyped formatter arguments. A fixture/type alias resolved the package; the second check still failed on those formatter arguments. Commit `6d8c59216ff91edf963eeb9ae98a99a10a8eaffe` built but was not type-green, and no browser timings on it are claimed. The explicit `Time` types in `7ced13b7` fixed that. Both earlier failures/build identities and the exact-commit passing check remain in the receipts. Final source was clean during both measured builds and all browser comparisons. The temporary typecheck configuration was recorded and removed.

## Evidence-driven next action

Installed source inspection at `SeriesPaneViewBase._internal__makeValid` shows that when both data and options are invalid, `_internal__fillRawPoints()` prepares coloured items and `_internal__updateOptions()` immediately maps them all again for colours. The latter has no subclass override in the installed module. This is a candidate for a separately guarded experiment, not yet a proved optimization. Test initialization, data-only, options-only, combined data/options changes, clear/repopulate, zoom grouping and all relevant series before removing any pass. Leave Custom semantics untouched unless independently proved.

Steady-state full-history OHLC reconstruction also remains open. A later cache/incremental preparation candidate must handle historical corrections, appended/deleted/cleared rows, index shifts, scale and option changes, grouping and replay without stale geometry or colours. Do not silently discard history or relax timing/data witnesses. Reuse only the QA tooling from this branch; do not enable its held transform in development.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-study-row-reuse-20261101`. Portable compressed receipts and original/compressed SHA-256 hashes: `docs/validation/chart-study-row-reuse-20261101/manifest.json`. No full application/backend suite was rerun because application source is unchanged. Earlier broad checks retain their own source identities.

All owned browser and fixture sessions were closed. No Replit import, main merge, deployment/publication, existing database change, API/worker activation, email, funds movement or live/demo broker test occurred. Last verified Replit ruler source remains the earlier recorded `4348fc6ae7cfbbdbdc527163ab18ee06416f47cd` / checkpoint `124f5ccc9ecca97a07f2b27a15f9a85a1df8d23e`; it was not re-inspected or changed this turn. API activation, owner/provider/device acceptance, Scanner startup and the broader competitive capability gaps remain open.
