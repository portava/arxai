# Smart Chart double-reversal evidence — 1 November 2026

**Bounded offline correctness repair; ARX is not release-green. Replit is unchanged.**

Application commit: `7a52a180ba0498c052f755d5a9d2c0b3ede5fda9`. Base: `44643857b3e4f891a6529ee6ffd2883be86fd308`. During final validation the only uncommitted difference was a documentation correction to MT5's object count; its patch is retained. Application and test source matched the application commit.

## Problem and behavior

Double tops/bottoms previously used the latest ATR to qualify older pivot geometry. Later volatility could invent or erase the old formation. The latest close alone set its status, allowing an invalidated formation to become confirmed again. The chart also assigned confirmation to the newest candle and connected points in first-pivot → second-pivot → neckline order, doubling back through time.

The existing shared detector now freezes formation geometry, quality and ATR when its second strict 2/2 pivot is knowable and at least 24 closed observations exist. A later actual closed crossing of the frozen neckline supplies the first confirmation index. A close above the higher top/below the lower bottom invalidates that formation permanently within the inspected window, retaining its historical confirmation. A distinct newer eligible pair can replace it. A wick alone or an already-beyond close at first availability does not invent a subsequent crossing.

The explicit ARX preceding-trend convention uses five closes before the first pivot: at least three of four steps in the required direction and a net move at least half that window's average candle range. The search considers the latest 600 observed bars and up to 12 consecutive same-kind pairs per direction, selecting the newest eligible formation. Frozen ATR uses 14 true ranges ending at formation availability. All formation, preceding-context and ATR observations must remain in the search window. This is bounded discovery, not a permanent event ledger.

The chart validates versioned lifecycle evidence against actual source closes, the three expected roles/indexes, rounded catalogue prices and frozen levels. It then draws actual unrounded candle extremes in chronological order and displays the actual first confirmation time. Malformed or contradictory lifecycle evidence is withheld. The existing assistant explains the selected finding through the same reader. No parallel detector, probability calibration or entry authorization was introduced.

## Evidence

| Check | Result |
| --- | --- |
| Corrected domain regression against isolated base source | 24 failed / 4 passed; no shared engine swap |
| Final combined domain catalogue/breakout/double suites | 455 passed / 0 failed / 0 skipped, including 28 double-reversal cases |
| Frontend initial regressions | 4 failures for timestamp/invalidated revival; 2 additional source-price regressions failed before correction |
| Independent frontend review mutations | 8 new failures before repair; tests reject false in-range event times, mismatched identity/roles/anchors/prices/levels |
| Final focused frontend | 178 passed; included in full total |
| Full frontend on application commit | 3,614 passed / 0 failed / 11 skipped; 218 files passed / 1 skipped |
| Backend pattern-truth suite | 26 passed |
| Type checks and production build | Domain declarations built; final dashboard/API typechecks and dashboard production build passed. Build warnings retained. |
| Guards | 85/87, with exact previous failure blocks: 38 wording matches and 3 raw-JSON/internal-display matches |
| Independent review | Domain clear. Two frontend consistency gaps fixed and re-reviewed; final minor minimum-history wording clarified. Reviewers did not run benchmarks/browser acceptance. |
| Actual Scanner browser | 19/19, immutable fixture `dd91e3f0bfdc8025`; top and bottom developing/confirmed/invalidated states, exact first confirmation time, actual annotation anchor chronology, local assistant agreement |

The first browser run passed 17 checks and failed two assertions expecting the internal word `invalidated`. The existing visible label is **No longer valid**, confirmed in source and screenshots. The corrected harness passed all 19; both runs and screenshots remain archived. The first domain fixture's quiet candle had an invalid open outside its range; it was corrected and the baseline rerun against isolated base code. Neither failure was discarded.

Browser history, account responses and all APIs were generated/intercepted. External requests and WebSockets were blocked, and startup mutations received intercepted 503 responses. No real provider, model, broker or database was contacted. This is not reconstruction of the owner's screenshots or proof of market-pattern predictive accuracy. The fixture has an isolated production build configuration, not the deployable dashboard bundle.

Visual inspection confirms chronological three-point geometry and a separately drawn neckline. The short 35-bar fixture leaves substantial unused horizontal space; a sticky header can overlap a clipped chart screenshot. This round does not claim complete layout acceptance for sparse history.

## Processing measurements

Quiet comparison order: base-2 → candidate-1 → candidate-2 → base-3, with no task browser, tests or builds running. Each run retains 2,000 measured samples and 320 warmups across identical workloads. An earlier exploratory base-1 run is also retained. Unrelated host workloads were not controlled. Node `v24.16.0`, local Mac; pure synchronous processing only.

| Workload | Base p95, two runs | Candidate p95, two runs |
| --- | ---: | ---: |
| Shared detector, 600 bars | 0.038 / 0.037 ms | 0.048 / 0.050 ms |
| Full analysis of latest 600 from 5,000 bars | 1.149 / 1.135 ms | 1.407 / 1.394 ms |
| Source binding plus full analysis, 5,000 bars | 1.755 / 1.749 ms | 2.003 / 1.988 ms |
| Dense generated 600-bar analysis | 6.533 / 6.569 ms | 6.656 / 6.556 ms |

All full-analysis groups retain their existing p95 ≤10 ms and p99 ≤20 ms budgets. The repair adds processing cost in the ordinary workload; it is not a speed win. All maxima/outliers remain in the raw samples. These results do not measure click feedback, first navigation, physical paint, sustained 60 fps, provider/model/broker latency or competitor speed.

## Verified comparison and unfinished work

TradingView's [double-top](https://www.tradingview.com/support/solutions/43000653211-chart-pattern-double-top/) and [double-bottom](https://www.tradingview.com/support/solutions/43000690659-chart-pattern-double-bottom/) documentation describes 600-bar search, 5/5 pivots, a closed neckline crossing, outcome states, configurable inputs and pattern alerts. ARX uses 2/2 pivots, frozen ATR tolerance and a bounded pair selection instead. Its invalidation uses the higher/lower extreme, while the referenced TradingView description uses the second extreme. These are explicit differences, not algorithm parity. Equivalent alerts, configurable detection inputs and matched-platform accuracy/performance remain open.

MT5's [analytical-object help](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects) currently lists 46 tools and describes manually placed objects. The comparison document's older 44-object count is corrected. Manual objects do not establish an equivalent built-in automatic double-pattern detector.

Remaining issues include other pattern families' lifecycle/causality, flag confirmation logic, broader catalogue accuracy, real-source freshness, actual Replit cold navigation and broader performance/layout gaps. Backend learning still uses its existing geometry-only identity; the new lifecycle metadata does not prove event-complete learning deduplication. Guard review separately identified mostly contextual wording matches plus a real raw-JSON presentation issue; those sources/guards were not changed in this repair.

A next performance opportunity is avoiding full catalogue evaluation at every H&S discovery prefix while preserving identical findings; equivalence and latency need measurement before retention. All broader owner requirements remain active.

No main merge, Replit running-source edit/restart, deployment, existing database migration, worker/trading enablement, email, funds movement or live/demo broker test occurred.

## Receipts and reproduction

`docs/validation/chart-causal-double-reversal-20261101/` contains the summary, verified raw archive, per-member hashes and archive checksum. The archive preserves all failures, scripts, reviewer reports, samples/warmups, browser metadata and screenshots. Raw local source: `/Users/areyouok/arx-tier1-release/chart-causal-double-reversal-20261101/`.

The new domain suite is wired into existing `test:candlestick-catalogue`; the frontend evidence suite is wired into `test:smart-chart-analysis`. Build/serve the existing actual-Scanner fixture on the application commit, run the archived browser script in a fresh session with all routes intercepted, and use `causal-benchmark.mts <worktree>` for the identical pure-compute workloads. Preserve comparison order and source metadata. Task browsers and fixture server were stopped; port 4199 had no listener.
