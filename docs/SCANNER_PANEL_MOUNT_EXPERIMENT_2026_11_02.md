# Scanner panel mounting experiment — 2 November 2026

Verdict: **withheld and reverted**. Mixed chart timing and substantially later secondary panels do not meet the owner's seamless whole-page requirement. No product performance gain is accepted.

Baseline fixture `bc1e6e61f3ae61b9`: source `df0adbcb44392ab72a5d71bd4bb4994b210fd96c` (same application as pre-experiment `72956a30`). Candidate fixture `46f8bc7e61f6af61`: `efa84f83c18db8d886154eda5c9815fe55dc182b`, following initial candidate `007e2cd8`. Reverts `58569209` and `f45bb9d8` restore the exact pre-experiment tree. Held branch `codex/hold-scanner-panel-mount-20261102` preserves the candidate; do not install it as accepted work.

## Hypothesis and review

One diagnostic Chrome trace on the earlier profiling fixture observed a ChartWorkbenchTools mount measurement triggering 46.7 ms of style update and 9.4 ms of layout under 4x CPU throttling. Trace/profiler overhead makes this diagnostic, not acceptance. Previously held toolbar-observer and CSS containment candidates were not reinstalled.

The new candidate mounted only secondary PageTabs after two rendering opportunities, with a 250 ms fallback and immediate user-reveal control. Chart, account refresh, errors, trade health and trade tickets remained outside that boundary. Normal child subscriptions/state resumed once mounted. This was not a data-ready or trading gate.

Independent review found three focus/priority issues: selecting the first rather than saved tab, ignoring urgent reveal after an automatic transition was queued, and stealing focus after the user moved. New tests reproduced all three (6 pass/3 fail), then passed 9/9 after correction. Static review cleared the corrections; mocked transition scheduling is not browser timing evidence. The entire candidate is nevertheless withheld based on the comparison below.

## Ordinary A/B/B/A comparison

All 80 attempts retained. Forty normal CPU attempts met the existing 100 ms chart target; all forty 4x attempts missed it. All 80 retained exact canonical/displayed OHLC, source identity and completed native rendering proof, with visible completion across two frames. Selected tab controls mounted within the additional 500 ms check in every attempt. This is control mounting, not market-data readiness.

Numbers below are medians of five chart-completion samples per viewport, with maximum tab-control mount delay in parentheses:

| Run | Normal desktop | Normal mobile | 4x desktop | 4x mobile |
| --- | ---: | ---: | ---: | ---: |
| A1 baseline | 66.2 (59.7) ms | 66.3 (47.2) ms | 402.3 (319.1) ms | 283.7 (224.0) ms |
| B1 candidate | 59.2 (77.8) ms | 54.4 (55.4) ms | 244.1 (448.5) ms | 302.0 (435.9) ms |
| B2 candidate | 58.7 (64.8) ms | 52.3 (55.9) ms | 288.2 (446.4) ms | 208.7 (427.0) ms |
| A2 baseline | 66.6 (60.4) ms | 65.9 (47.3) ms | 317.8 (303.1) ms | 269.2 (216.1) ms |

Some chart results improved, but throttled mobile was inconsistent, baseline variation was material, and secondary panels arrived substantially later. The new loading phase therefore stays excluded. No sample or slower result was discarded.

The saved outer driver extends the unchanged first-navigation harness with one identical RAF tab-control query in both A and B. It retains the original source-correct visible-completion timestamp, then waits for mounted tab controls before ending the attempt. Exact transformations and runner source are archived. The 500 ms secondary check is additional; it does not relax the chart's 100 ms criterion.

## Scope and retained evidence

Offline synthetic historical EURUSD M15/200 bars, fixed 80 ms response, actual application route/providers, fresh isolated browser per rate/run, resources primed by setup, desktop/mobile viewport emulation. No physical-paint, cold-process, provider, deployed-app, broker or competitor measurement. Unknown APIs/writes were blocked by the fixture. No builds/tests overlapped timed attempts. The review was static during those windows.

Initial candidate fixture `9ce5c399bace4336` predates review corrections and was not measured. Full application CI/typechecks/guards were not rerun for the withdrawn candidate. The revert is checked by exact Git tree equality with `72956a30`, not by attributing old test counts to new application changes.

Raw trace, all samples, fixtures, CLI logs, reviewed tests and runner are under `/Users/areyouok/arx-tier1-release/scanner-mount-trace-20261102`. Original independent review is under `/Users/areyouok/arx-tier1-release/scanner-panel-mount-20261102`; a copy is retained with the experiment. Owned browser sessions were closed; profiling, candidate and baseline servers were stopped and their known handles exited.

Next: preserve the failed experiment; investigate a more fundamental reduction in mount/update work without delaying the rest of the page. New owner screenshots also require exact preview/source comparison and stale-assessment identity audit. No claims of full engine accuracy, competitive parity or launch readiness.

No main merge, deployment/Replit sync, existing database changes, worker/trading enablement or broker tests.
