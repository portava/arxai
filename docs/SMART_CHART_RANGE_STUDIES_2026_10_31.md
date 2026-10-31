# Donchian Channels and range-study calculation — 31 October 2026

Tested application `f1a47fcc791742a2c7e6ed20451a65f60bcce479`, branch `codex/chart-range-studies-20261031`, baseline `8c40032a` (volume-evidence branch). No main merge, Replit import, deployment, database migration or broker testing. The existing Replit update from 8072ad76 is separate and remains pending.

## Capability and implementation

Donchian Channels add the highest high, lowest low and midpoint over N observed bars; default 20, configurable 1–1000. The selected window includes the current forming bar, so values can change; a complete window is required and warm-up stays blank. The three lines share the configured study colour. Search, repeated study instances, saved settings and the existing data-window renderer use the same catalog integration. The original five starter studies are explicitly preserved in their original order.

Formula reference: [TradingView Donchian Channels](https://www.tradingview.com/support/solutions/43000502253-donchian-channels-dc/), accessed 31 October 2026. ARX does not yet provide the documented offset, independent per-line styling/background fill or independent study-timeframe controls. This is a partial capability match, not verified pixel/seed/timeframe parity. Contact with the current channel is not labeled a confirmed breakout or an order signal.

Stochastic, Williams %R and Donchian share bounded monotone queues on bulk history. Each bar enters/leaves once; a corrected suffix reconstructs only the preceding lookback. No future bars enter a replay prefix. Incomplete warm-up skips range work. One/two-bar revisions use an isolated direct scan to avoid queue allocation and a measured slowdown in the combined state machine. Queue memory is bounded by the selected period. Signed-zero, NaN and infinity behavior matches the simple extrema oracle; final non-finite study values remain blank.

## Validation on the exact application commit

- Full frontend: **2,611 pass  / 11 skip  / 0 fail**,179 passed files / 1 skipped.
- Dashboard typecheck and production build pass; **87/87 guards**,7 bridge binding assertions pass.
- Existing independent frozen-loop vectors now include a simple Donchian oracle. New tests cover hand-computed bands, flat/period-one values, linear bulk input reads, missing warm-up work, corrections, replay truncation/appends, extrema ties/non-finite values and starter collection stability.
- Actual Scanner production fixture `7b91fefefadc931a`: **28/28 browser checks**, 1440×1100 and 390×844. UI adds the study, edits 20→5, verifies all three actual library series against 200 intercepted canonical bars, reloads a new document, and checks mobile bounds. Exact clean source/build metadata required. Desktop/mobile PNGs inspected; plot and safe-mode notices visible. Mobile tools extend below the viewport, so this is not a full-screen controls certification.
- Synthetic unavailable-AI fixture only: API mutations blocked; expected 503/unknown-read logs retained. No page exceptions. No real provider, physical-touch, hardware-paint, browser-latency or competitor benchmark claim.
- Self-review only, not an independent agent review. Root/backend/database suites were not rerun for these frontend changes.

## Retained performance evidence

Node v24.16.0, deterministic synthetic OHLC, baseline 8c40032a versus the tested application above. Two warm-ups, five retained measurements per variant per case, alternating order, GC before each. Construction is excluded; calculation includes complete study points/state. Final arrays must exactly match baseline. All owned builds/tests/browsers were stopped during timing; unrelated host activity was not controlled. With five samples p95 is the maximum. These are calculator timings, not chart/page or competitor timings.

Bulk milliseconds, median / maximum:

| Study | Period | Bars | Baseline | Candidate |
|---|---:|---:|---:|---:|
| stochastic | 14 | 200 | 0.278 / 0.353 | 0.269 / 0.283 |
| stochastic | 14 | 50000 | 15.527 / 15.663 | 14.169 / 14.463 |
| stochastic | 1000 | 200 | 0.135 / 0.157 | 0.136 / 0.150 |
| stochastic | 1000 | 50000 | 85.687 / 86.242 | 16.565 / 16.933 |
| williams | 14 | 200 | 0.191 / 0.203 | 0.174 / 0.190 |
| williams | 14 | 50000 | 10.366 / 12.123 | 10.138 / 10.179 |
| williams | 1000 | 200 | 0.070 / 0.072 | 0.075 / 0.077 |
| williams | 1000 | 50000 | 83.993 / 88.566 | 12.980 / 15.008 |

100-revision batch milliseconds (setup excluded), five retained batches:

| Study | Period | Bars | Baseline median | Candidate median / maximum |
|---|---:|---:|---:|---:|
| stochastic | 14 | 200 | 0.180 | 0.163 / 0.194 |
| stochastic | 14 | 50000 | 0.203 | 0.164 / 0.181 |
| stochastic | 1000 | 200 | 0.117 | 0.103 / 0.114 |
| stochastic | 1000 | 50000 | 0.232 | 0.344 / 0.387 |
| williams | 14 | 200 | 0.144 | 0.094 / 0.106 |
| williams | 14 | 50000 | 0.154 | 0.121 / 0.137 |
| williams | 1000 | 200 | 0.083 | 0.077 / 0.086 |
| williams | 1000 | 50000 | 0.194 | 0.311 / 0.335 |

Long-history calculations improve substantially; small cases are mixed. Period1000 revision batches remain slower than baseline by roughly 0.1 ms per 100 updates, despite removing the earlier roughly 3 ms regression. No all-workload speedup is claimed. The whole-chart 50k rendering and Scanner first-navigation failures remain open; this does not supersede their receipts.

## Failures preserved

Baseline plus initial four tests:3 fail / 1 pass. First implementation f9e8fd3c accidentally shifted positional starter defaults: fullfrontend2599pass/10fail / 11skip, corrected by cc542762 and an explicit starter regression. The initial queue-only benchmark exposed unnecessary warm-up work; 30676b9b removed it and bounded tiny revisions. That version still produced roughly 3 ms100-update batches for period 1000; the isolated scan fixed most of that overhead. Every earlier benchmark, sample/outlier and patch remains archived.

An initial benchmark failed before execution because root cwd could not resolve tsx; rerun from scripts. One final-source browser attempt stopped at the clean-source gate because earlier owned Playwright logs were untracked. Logs were moved into this receipt, the identical application rebuilt clean, and acceptance rerun. That failed attempt is not relabelled as passing. Intermediate browser acceptance belongs to its own exact commits, not the final source.

All logs, runners, raw samples, browser JSON, PNGs and original-file hashes are in `docs/validation/chart-range-studies-20261031`. Non-images are gzip-compressed; manifest hashes refer to the uncompressed originals. Original directory: `/Users/areyouok/arx-tier1-release/chart-range-studies-20261031/`. Benchmarks require updating their checkout paths when replayed elsewhere; source snapshots and settings must match. All owned servers/browser sessions are closed.

## Remaining objective

Obtain final combined Replit evidence without interrupting its job, then investigate first-click latency on exact source. Keep broader study/drawing coverage, real/tick-volume provenance, calendar boundaries, cloud workspace recovery, physical-device coverage and matched TradingView/MT5 measurements open. Do not install held resize/toolbar/containment branches or call the architecture complete.
