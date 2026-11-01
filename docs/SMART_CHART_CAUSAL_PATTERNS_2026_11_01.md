# Smart Chart causal pattern evidence — 1 November 2026

**Development validation passed for this bounded repair. ARX remains not release-green; Replit is unchanged.**

Application commit: `97e545a4cc9d302479dc959dc9d4017c6ff12a34`. Base: `032a76f51b4f6a14af8637be6cb05f02a6886694`.

## Corrected behavior

Breakout/retest detection previously formed a level and ATR from the whole window, then searched backward for a break. Later pivots or volatility could invent, erase or rewrite a historical event. It could also treat an already-beyond close as a fresh crossing. The detector now uses pivots fully observable before the crossing and the preceding 14 true ranges. Level, formation, ATR, crossing buffer and retest tolerance freeze at that crossing. Retest, first confirmation and failure retain their actual closed-candle indexes. Failure takes precedence over confirmation on the same OHLC bar and remains sticky; a later fresh crossing receives a distinct identity.

The chart reader consumes that lifecycle rather than substituting the latest candle as confirmation. An exhausted or failed event can retain its historical confirmation without presenting it as a new entry. Retest anchors remain on observed price ranges and do not invent a price path between events.

A separate H&S fixture showed a shape first qualifying at candle 33 after ATR expanded, while the old reader claimed confirmation at candle 31. Normal and inverse H&S now cannot confirm before the complete shape qualifies in an inspected prefix. Later prefixes cannot replace the first observed confirmation of that same shape.

These are explicit geometry conventions, not calibrated probabilities, predictions or entry permission. AI confidence policy and trading gates are unchanged.

## Evidence

| Check | Result |
| --- | --- |
| Before-fix breakout regressions | 16 failed / 4 passed; retained |
| Before-fix H&S regressions | Both orientations failed; retained |
| Before-fix frontend confirmation mapping | 1 failed; retained |
| Final application commit, domain catalogue | 427 passed / 0 failed, including 27 breakout cases |
| Final application commit, focused frontend | 260 passed / 0 failed, four files |
| Full frontend before final type-only annotation | 3,582 passed / 0 failed / 11 skipped; 217 files passed / 1 skipped |
| Backend pattern-truth lane | 26 passed / 0 failed |
| Domain type build, dashboard/API typechecks | Passed after fixing one numeric inference annotation and rebuilding stale domain declarations; initial failures retained |
| Production dashboard build | Passed; bundle and sourcemap warnings retained |
| Guards | 85/87; exact failure blocks match the base receipt: 38 wording matches and 3 internal-name/display matches |
| Independent review | No additional causal blocker; separate normal/inverse H&S reproduction retained |
| Actual Scanner browser | 6/6 checks on immutable fixture `bdef3658b1fe4d71`, clean source at application commit |

The browser uses generated M15 candles, intercepted APIs and blocked external requests. H&S is absent before its qualifying close. Its selected explanation reports the correct close afterward. A forming breakout has no confirmation; its later explanation retains the earlier retest confirmation rather than the newest candle. This is actual rendered Scanner/assistant evidence, not validation of the owner's market screenshots.

The first browser attempt exposed another usability gap: clicking **Explain this finding** before the lazy assistant mounts can report unavailable. That failure is retained. The second run waits for the visible assistant trigger to isolate causal correctness. The early-click gap is **not fixed** here.

## Processing cost

Four sequential runs were ordered base, candidate, candidate, base. Each retained 500 measured samples and 80 warmups for each of four workloads: 8,000 measured samples and 1,280 warmups overall. No samples were removed. Both working trees were clean and unchanged during measurement. No other task build/test/browser ran during the measurements; unrelated machine workloads were not controlled.

| Workload | Base p95, two runs | Candidate p95, two runs |
| --- | ---: | ---: |
| Raw catalogue, 600 candles | 0.022 / 0.023 ms | 0.036 / 0.038 ms |
| Complete analysis, 5,000 loaded / 600 analyzed | 0.807 / 0.849 ms | 1.132 / 1.141 ms |
| Source binding plus analysis, 5,000 candles | 1.316 / 1.310 ms | 1.789 / 1.781 ms |
| Dense generated analysis, 600 candles | 6.057 / 6.211 ms | 6.650 / 6.591 ms |

All analysis workloads meet the existing pure-compute p95 ≤10 ms / p99 ≤20 ms budgets. The candidate dense-workload maximum was 10.326 ms and is retained. Correct causal checks add CPU cost; this is **not a speed improvement**, browser interaction timing, 60 fps proof or competitor benchmark. Full percentiles and outliers are in `performance-summary.json` and the raw samples.

## Competitive scope and remaining work

TradingView documents [repainting and the difference between pivot time and when the pivot becomes knowable](https://www.tradingview.com/pine-script-docs/concepts/repainting/). MT5's [Fractals documentation](https://www.metatrader5.com/en/terminal/help/indicators/bw_indicators/fractals) requires observations on both sides of the central extremum. These support the requirement to separate a drawn historical anchor from the time evidence became available. They do not establish equivalent detector definitions, accuracy or performance.

Breakout discovery remains bounded to the latest 12 closed candles with at least 24 observations at the crossing. H&S discovery examines the latest 24 prefixes. Events can leave those windows; permanent historical event tracking and global first-ever discovery are not implemented. Other catalogue detectors have not all received this causal audit. Broader TradingView/MT5 tools, alerts, long-history workflows, real provider freshness, accessibility and performance comparison remain open.

Next: fix the demonstrated early assistant readiness gap without a new assistant or remote fallback; retain exact pane/source ownership. Continue causal audits and competitive validation. No main merge, Replit edit/restart, publish/deploy, existing database change, worker enablement or live/demo broker test occurred.

## Receipts

`docs/validation/chart-causal-breakout-20261101/` contains the validation and performance summaries plus a hashed raw archive. It preserves failing attempts, generated browser screenshots, the independent reproduction, benchmark script, all samples and warmups. Tests use the repository's existing tools; the local dependency wrapper is `/tmp/arx-offline-run.py`. No dependencies were installed or source dependencies edited.
