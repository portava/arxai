# Smart Chart reader follows streamed candle revisions

Checked application/tooling **be4b22d1a4ae608f96d1ee4c5506ec5d602a9c26**, branch `codex/chart-stream-reader-20261031`, based on cockpit backup6db9fa1f. No main merge, deployment, broker tests or orders.

The Scanner chart applied same-time streamed OHLC revisions without notifying its embedded reader. A revision can contradict the closed-source candle behind a displayed explanation even though the visible range does not move. The old reader could remain ready until another viewport/data event. The adapter now queues its existing viewport notification after an accepted stream update; tick bursts collapse into one notification per animation frame. The reader revalidates the applied candles, withdraws explanations/annotations on disagreement, and recovers when the display matches the confirmed source. Streamed bars do not acquire closed/final evidence.

## Comparison target

TradingView documents separate realtime updates and confirmed bars, with confirmed state on the closing update: [bar states](https://www.tradingview.com/pine-script-docs/concepts/bar-states/). MT5's [OnCalculate](https://www.mql5.com/en/docs/event_handlers/oncalculate) processes price changes and supports skipping unchanged bars via its previous-calculation count; history changes invalidate that calculation count. Official documentation inspected31October2026.

ARX inference/target: keep explanations synchronized with displayed inputs while preserving the distinction between a changing bar and confirmed history, and avoid doing expensive analysis for every tick. This fix advances that behavior. It does not prove matching indicator sets, equivalent proprietary logic or superior performance.

## Evidence

- Final regression tests against the pre-fix adapter: **2 fail /50 pass**. They expose missing notifications and the real React reader retaining ready status after a contradictory revision. Candidate focused adapter/reader/cache tests: **86/86 pass**.
- A100-revision burst produces one reader callback with final OHLC. Rejected/out-of-order bars do not notify; removal/destruction cancels notifications. Actual adapter + reader integration withdraws/recoveries correctly, keeps one forming tip outside the confirmed endpoint, and refuses to treat two streamed tips as source-confirmed history.
- Exactbe4b22d1 full frontend: **2,541 pass /11 skip /0 fail**,174 passing files /1 skipped opt-in benchmark file. Dashboard build,87 guards,7 binding assertions pass. First typecheck failed because the new isolated worktree lacked generated domain declarations; building those declarations and rerunning typecheck passed without changing source. Raw failure retained. No full root CI/database integration.
- Actual production Scanner fixture baseline **388989412301b36e**, source256aff05: the new browser check failed waiting for the reader to withdraw after the candle revision. Candidate **ee95c9a140803886** matches cleanbe4b22d1: all six withdrawal/recovery checks PASS. Exact full canonical/display data, confirmation endpoint and renderer identity match before/after recovery. No page exceptions. Recovered explanation screenshot inspected.
- Synthetic stream-to-reader DOM times: **8.5,18.0,17.2,16.7,17.7,17.8ms**. Two-frame opportunities:39.7,48.5,49.8,47.1,49.7,48.6ms. All samples retained. Builds had finished before candidate measurement. These are six small offline observations, not physical paint, broker latency, a percentile benchmark or the still-failed100ms initial-navigation target.

The browser harness uses the actual Scanner/component/adapter/reader with deliberately constructed source-shaped response flags and stream frames. The generic fixture normally keeps the reader unavailable; this scenario overrides candles only to test positive and conflicting evidence paths. It is not captured provider data or acceptance of real-source correctness. API mutations and external traffic remain denied. All unknown reads, HTTP-denial console output, and runtime errors are saved in final-fixture-network.json; zero page exceptions does not mean an error-free console. Owned browsers/servers closed.

Intermediate evidence retained: initial incomplete renderer mock; nondeterministic timer-driven integration attempts corrected to explicit frame scheduling; final regression before/after; baseline browser failure; missing generated-type failure. No test assertions or safety gates were relaxed.

Receipts: docs/validation/chart-stream-reader-20261031/manifest.json. Open: real-provider active-reader acceptance, first-click sub100ms, heavy-history60fps, physical touch, full competitive capability/performance comparison. Architecture not complete; release not green.

## Separate development preview receipt

The prior cockpit update completed independently at Replit application83ebc69e38c1b53ddd7336f99663c79e9a743212, checkpoint08eace9a35b37ac98b7580b2bb30a6a991ee7d9f, importing upstream256aff05. Its own tests2533pass/11skip,87guards,7bindings,13server scheduling/listener tests,15tooling and both builds/types passed. Authenticated acceptance and new timing were not attempted. The stream-reader change in this report is not installed there yet. Preserve the Replit-local changes when integrating it; these different-source results are not interchangeable.
