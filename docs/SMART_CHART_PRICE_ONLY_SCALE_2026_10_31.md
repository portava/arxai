# Smart Chart: fit prices independently of overlay indicators

Checked application **6f170f8499a842ab65a44a67fa8f4be6e883b13b**, branch `codex/chart-price-only-scale-20261031`, based on the tested Scanner idle-loading backup2c36bf00. Final immutable actual-Scanner fixture **b444ef2a0effe7c9**. Not installed in Replit. No main merge, deployment, database changes, worker/trading activation or broker tests. Architecture and competitive comparison remain incomplete.

## Competitive requirement

TradingView documents that distant indicator levels can compress candles and offers [Scale price chart only](https://www.tradingview.com/support/solutions/43000762934-my-chart-looks-compressed/) to address it; its [Supercharts controls](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/) distinguish automatic fitting and price-only fitting. MT5 documents manual/fixed/one-to-one scale controls in [Chart Settings](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_settings). Official pages inspected31October2026. The MT5 documented controls are not evidence that MT5 has this exact indicator-exclusion option, and those broader fixed-scale features remain open in ARX. No matched competitor benchmark was performed.

ARX's prior implementation fit the main pane to prices and overlay indicators with no user choice. The new **Scale price only** control excludes overlay studies from automatic price fitting while keeping their data, visibility and coordinates in the same price scale. Values outside the resulting viewport may be clipped, as the control's help explains. Oscillator panes keep their own ranges. Turning the control off restores standard indicator-inclusive fitting. Changing either policy returns to automatic scaling; reapplying an unchanged preference does not undo a subsequent manual scale adjustment.

Default behavior is unchanged. Only an explicit true preference enables the option. It survives local persistence and existing validated preferences/templates, applies to native chart and private replay, and persists across study append/edit/rebuild and price-series style replacement. The selected control has a visible active state and aria-pressed state. It does not hide a study, change OHLC or indicator calculations, resample history, rebuild the price series, change horizontal range, or alter execution safety. The implementation uses the renderer's documented [series autoscale provider](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/SeriesOptionsCommon#autoscaleinfoprovider).

## Tests and actual rendering

Four new regression assertions failed on the original source (4fail/214pass), then passed. Focused renderer/workspace/tools/adapter/replay run:269pass. A later replay regression also confirms preference restoration and a toggle without moving the replay cursor, making market requests or creating a stream (16replay tests pass).

Exact final6f170f84: **2,550 frontend tests pass,11skip,0fail**;174filespass/one opt-in benchmark file skipped. Dashboard typecheck/build,87guards and7bindings pass. Earlier71038152 typecheck failed because a callback lacked an explicit type; corrected atf31fac8c, failure retained. Both subsequent full checks pass. No backend/root/database integration lane ran because this is a chart-only change.

The offline browser uses the actual Scanner with200historical synthetic candles, a deliberately wide100-deviation Bollinger study and an independent RSI pane. It verifies exact source/display OHLC initially, then unchanged full data and study configuration/lines, series/chart identity, feed and horizontal range throughout each toggle. Completion requires correct geometry on two consecutive frames with at least100x100visible plot and five unobscured hit-test points. Clicks are trusted browser input. The setting and expanded price range survive full reload. Final before/after screenshots were visually inspected; they show unchanged RSI and a clearly active button. Synthetic source is intentionally not eligible for live analysis, and the screenshot's safe-mode warnings remain.

The same visible price interval0.996700029380348–1.0032987926843786 occupies **10.3369pixels** with the wide bands included and **308.12pixels** with price-only fitting, in a368pixel price pane. This demonstrates the readability improvement without changing values. Off toggles restore the original geometry within1pixel.

| Final source, desktop1440x1100 | Recorded toggles | Completion median | p95 | p99 / maximum |
| --- | --- | --- | --- | --- |
| Normal CPU | 20 | 48.7ms | 49.0ms | 49.1ms |
| 4x CPU throttle | 20 | 46.2ms | 48.1ms | 50.7ms |

Four additional warmups per CPU condition are retained, as are every sample, earlier candidate runs and screenshots. Timing starts at the trusted click and ends at the second frame with correct state/geometry; it includes full-array witness checks. Small-sample nearest-rank p99 equals the maximum. The slightly lower4x median is scheduling variation, not a speedup claim. Builds/tests finished before final timing. These results do not prove physical paint, sustained60fps, mobile interaction, every price mode, active reader performance or equivalence with competitors. Browser-version metadata was not captured by this harness, limiting reproduction of the exact environment; later comparative measurement must capture it.

Final diagnostics:119requests,74unknown reads,7blocked requests,81HTTP-denial console errors,0page exceptions. All external traffic/mutations were denied; this is not an error-free production console. Raw diagnostics retained. Owned fixture/browser closed.

## Evidence and next work

Receipts/SHA-256 inventory: `docs/validation/chart-price-only-scale-20261031/manifest.json`. Application unchanged by this report commit. No independent-agent review was requested for this batch; local review covered preserved series/calculations, oscillator exclusion, edit/rebuild behavior, manual-scale retention and separate replay wiring.

Replit remains occupied with the earlier Scanner idle-loading update (turnending01a19355-78fb-76d0-bbd8-e2707ec802f0); this follow-up has not been submitted over it. Next: retrieve that final combined result, preserve its local changes, then selectively import this validated scale control and repeat source-matched checks. Keep real-provider reader acceptance, actual first-navigation timing, physical touch, heavy-history/replay performance, MT5 fixed-scale modes and all broader catalog/cloud/alert/scripting gaps explicit. No parity or completion percentage assigned.
