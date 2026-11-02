# Scanner offscreen rendering experiment — 2 November 2026

**Verdict: no repeatable improvement; candidate held and reverted. Release readiness and competitor parity remain unproven.**

Baseline: `f8a6e6c02b52b14c9667ebde9a7fc8d32b65cebd`, immutable fixture `4626820b617938e5`.
Candidate: `0788dc1d3d656569f8b48e4193283b5b056d95c5`, fixture `c66a1661b56bb7d5`.
Revert: `5f526edd` on `codex/scanner-offscreen-render-20261102`.
Held branch: `codex/hold-scanner-offscreen-20261102`. Do not install this candidate as an improvement.

The reverted candidate applied browser-managed offscreen rendering only to the below-chart Scanner tabs, with measured desktop/mobile intrinsic heights. It did not defer the chart or Trade Health. The active panel retained its React hooks; inactive Radix panels already unmount. Browser skipping behavior and remembered intrinsic size are documented by [MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility) and [MDN intrinsic block size](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain-intrinsic-block-size).

Independent source review found no concrete source blocker, but did not establish browser accessibility, popup placement, keyboard reveal, scrolling or stale-state withdrawal. Those acceptance checks were not completed because timing did not justify retaining the change. Both immutable fixture builds succeeded with clean, unchanged source. No full CI or fresh full test suite is attributed to the candidate.

## Counterbalanced measurements

Quiet order: baseline A1, candidate B1, candidate B2, baseline A2. Each row contains five attempts. All attempts and outliers retained.

| Run | CPU | Desktop median / max ms | Mobile median / max ms | Within 100 ms |
|---|---|---|---|---|
| A1 baseline | 1x | 98.0 / 99.3 | 98.3 / 98.8 | 10/10 |
| A1 baseline | 4x | 205.5 / 222.0 | 197.0 / 198.5 | 0/10 |
| B1 candidate | 1x | 98.1 / 99.6 | 98.8 / 99.5 | 10/10 |
| B1 candidate | 4x | 221.0 / 257.1 | 188.0 / 194.9 | 0/10 |
| B2 candidate | 1x | 98.2 / 99.3 | 98.3 / 99.7 | 10/10 |
| B2 candidate | 4x | 209.5 / 229.0 | 187.7 / 193.5 | 0/10 |
| A2 baseline | 1x | 49.3 / 99.6 | 98.7 / 99.2 | 10/10 |
| A2 baseline | 4x | 205.7 / 207.4 | 188.5 / 195.4 | 0/10 |

All 80 attempts completed with exact source-correct, visible native rendering. All 40 normal-CPU attempts met 100 ms; none of the 40 throttled attempts did. Candidate desktop timings did not improve. Its apparent mobile gain over A1 was matched by the unchanged A2 baseline. The unchanged baseline also produced a large normal-desktop median shift. This evidence does not support a speedup claim.

The harness uses historical synthetic bars, a fixed 80 ms candle response, primed browser resources and a trusted first actionable navigation click without intentional dwell. Completion requires exact canonical and displayed OHLC, source, symbol, interval and actual series identity on two consecutive frames, plus an unobscured plot intersection. These are rendering opportunities, not hardware-paint evidence. No cold browser, actual deployed app, provider, broker, physical mobile device or TradingView/MT5 comparison was measured. Five attempts per cell do not establish tail reliability.

An initial layout inspection waited on a label the fixture does not render and timed out. The corrected inspection waited for the actual intercepted selected-market response. Both records are retained; inspection was outside timing runs.

## Preservation and remaining work

Before documentation, `git diff f8a6e6c0 HEAD` was empty after the revert. Prior application fixes and their original validation scope are unchanged; they are not newly validated by this experiment. The owned fixture server and browser runners have exited. No deployment, main merge, existing database change, trading enablement or broker test occurred.

Raw evidence: `/Users/areyouok/arx-tier1-release/scanner-offscreen-render-20261102` (93 files plus manifest; includes raw attempts, runner logs, initial inspection failure, source review and navigation journals).
Archive: `/Users/areyouok/arx-tier1-release/scanner-offscreen-render-20261102.tar.gz`.
SHA-256: `079a02a8401a69beea8b55bdc8a510d1f90e2574532b8f97299d0e39b2ff8034`.

Next: profile the remaining route-mount work before another latency candidate. Calendar intervals, richer comparison/study/drawing features, accessibility, replay workload limits and independent competitor measurements remain open. All-engine accuracy remains separately scoped in `ENGINE_ACCURACY_RISK_SIZING_2026_11_02.md`; agreeing labels alone do not establish truth.
