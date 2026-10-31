# Wilder DMI / ADX — 31 October 2026

Status: locally accepted chart capability; not imported into Replit yet. Architecture completion, first-navigation performance and competitor parity remain unproven.

## Exact source

Application **d83a02d773743990704465548af7cea556851d0c**, branch `codex/chart-dmi-study-20261031`, base **c475c736ef743741c5d86a28fd429227b51d1853** (accepted drawing shortcuts plus earlier startup improvements). Clean immutable ordinary-runtime fixture **955d4045acc6a7da**. Receipt commits change documentation only. No dependencies added and the five-study starter collection is unchanged.

The study library now has 19 OHLC-based types. DMI adds green +DI, rose −DI and configurable-color ADX in one separate pane with a 0–100 scale. DI period and ADX smoothing are independent, default 14/14, bounded to integer 1–1000. Search, duplication, local settings persistence, data-window labels and generic replay calculation use the existing study system. ADX is explicitly strength, not direction or calibrated confidence. No entry threshold, trade signal or execution permission is introduced.

## Research and conventions

TradingView documents DMI as three lines, with independently configurable DI and ADX lengths. Its DMI page describes exponential smoothing, while its ADX page gives a Wilder-style recurrence. ARX explicitly chooses Wilder smoothing, arithmetic seeds, blank warmup, strictly dominant positive movements (ties zero), and zero DI/DX for zero denominators. These choices are specified in [study conventions](SMART_CHART_STUDY_CONVENTIONS.md). [TradingView DMI](https://www.tradingview.com/support/solutions/43000502250-directional-movement-dmi/), [TradingView ADX](https://www.tradingview.com/support/solutions/43000589099-average-directional-index-adx/).

MetaTrader exposes ADX Wilder separately from its other ADX indicator. Its published description is not a numeric fixture establishing identical seeds or all edge cases; its written true-range expression also differs from the conventional high-minus-low expression used here. No claim of exact MT5 output equivalence is made. [MetaTrader ADX Wilder](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/admiw).

Missing compared with broader platform controls: individual per-channel color/line-style/visibility settings, alternate indicator timeframe, additional ADX variants, and attested matching-provider/platform outputs. The current color input changes ADX only and explains that in the UI. No threshold-based trading guidance is inferred from these descriptive plots.

## Validation on d83a02d7

- Full frontend **2,660 pass / 0 fail / 11 skip**, 180 passing files and one skipped file.
- Dashboard typecheck and production build pass; existing large-chunk warning retained.
- **87/87 guards**, **7/7 binding assertions** pass.
- Focused first corrected run: 295/295; final DMI/renderer run after adding explicit pane/color assertions: 212/212. These overlap and are not added to the full count.
- New DMI unit tests: hand-derived mixed-direction vector, flat/tied movements, rising/falling extremes, independent batch recurrence for lengths 1/1, 2/4, 14/14, 40/7 and 1000/1000, price-scale invariance at 1e−6 and 1e6, revised high/low/close, truncation/reappend and malformed stored parameters. Separate existing generic catalog tests include new DMI streaming/revision/no-future cases.
- The pre-existing bit-identical historical reference remains scoped to its original 18 study kinds; it has no DMI implementation. No previous kind or assertion was removed. DMI uses its own independent batch oracle and hand-derived vectors instead of copying production into that historical oracle.
- Actual Scanner browser **30/30 assertions**: all three plotted series values compared with independent calculations over the 200 source candles, including exact canonical and displayed OHLC, default 14/14, edited 7/21, independent duplicate 7/3, removal, reload and 390px layout. No page exceptions or horizontal overflow.
- Additional mobile visibility receipt proves the centered 360px chart fits above fixed navigation and the study bottom is unobscured. Initial screenshot partially clipped the study due to scroll position; retained alongside the centered screenshot. Both desktop and centered mobile screenshots inspected.
- Self-review only; no independent agent review. Full backend/root/database suites, physical keyboard/mobile devices, replay browser acceptance with DMI, and owner-authenticated/real-provider acceptance not performed.

## Calculator cost, not end-to-end speed

Node v24.16.0 on this development Mac, all owned builds/tests stopped; 28 raw runs retained (two warmups and five measured runs for each size/period). No browser or competitor measurement is implied. Each incremental sample contains 100 revisions to the last bar and reuses its previous checkpoint. Full calculation does not collect an extra changed-point list, matching renderer usage.

| Bars / DI and ADX length | Full median / max ms | 100 tip revisions median / max ms |
|---|---:|---:|
| 5,000 / 14 | 3.238 / 3.650 | 0.126 / 0.165 |
| 5,000 / 1,000 | 1.221 / 2.301 | 0.112 / 0.776 |
| 50,000 / 14 | 18.138 / 35.063 | 0.112 / 0.168 |
| 50,000 / 1,000 | 19.050 / 20.541 | 0.068 / 0.100 |

All outliers retained; these small groups are not population estimates. JIT/GC and warmup differences prohibit inferring that longer periods are faster. Calculation is linear in loaded bars with constant recurrence work per appended/revised bar; checkpoint memory grows with history. Rendering 50,000 bars, 12-study workspaces, first-page load, crosshair/pan/zoom, and real provider/network timing remain separate unproven targets. Earlier slowed first-navigation failures stay open.

## Retained failed attempts

The first test-file write and one focused command used the wrong working directory and did not run the intended tests. The first DMI test file also had an ambiguous TypeScript non-null/operator token; the baseline and first candidate transform failed with zero DMI tests executed. After correcting the syntax, the same 10 tests run against the unchanged baseline calculator/workspace all failed; the implementation passes. The initial benchmark CLI was denied an IPC socket by the environment; rerunning with the existing Node import loader avoided that unnecessary socket and succeeded. All available logs are retained, with no assertion relaxed to secure a pass.

## Continuation

Replit's pending-engine startup import remains busy according to read-only connector checks; questions were not queued. Preserve that active work. Neither these changes nor the previous drawing shortcuts have been imported yet. Obtain the exact combined Replit result, then import accepted changes selectively and validate that new combined source. Keep API activation deferred and preserve concurrent auth, safety, Truth, funds and recorder changes.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-dmi-study-20261031`. Portable archive: `docs/validation/chart-dmi-study-20261031/manifest.json` with original and archive SHA-256 checksums. Local test browser/server closed. No main merge, deploy/publish, existing-database migration, worker/trading activation, funds movement or live/demo broker testing.
