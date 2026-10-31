# Scanner earlier candle readiness — 31 October 2026

Status: **locally accepted incremental improvement; startup target still unmet, not release-green.** Tested source `61f2577bfc333be3ebd420562576c44c3537880e`; application change `00acbda74f05e191c79bada1afe6110759272653`. Base `b90d5b3fa957fe493d3b4c5af8eeea56c0f757e9` includes accepted individual study-line controls; it excludes all held performance experiments.

## Change and tradeoff

For an allowed, visible, non-data-saver navigation context, start the existing selected-symbol/timeframe 200-candle read after access is known instead of waiting for browser idle time. Route code still warms at idle or explicit navigation intent. The same query key, transport, five-second freshness budget and original source evidence are preserved. Desktop/mobile navigation and the mounted Scanner share the request. No refresh loop, chart engine, chart tick stream, analysis, position read or order starts on the dashboard from this hook.

This can spend one small read on a short visit that previously ended before idle. Each selected context has its own cache; a late old response cannot overwrite another timeframe. Hidden documents, data-saver users, investors and pending traders do not automatically warm. Explicit allowed navigation intent retains its existing behavior. Losing access cancels queued route warming; this does not invent a new shared-query cancellation policy. A late idle callback does not issue another candle read or renew old evidence. Error responses do not fabricate data or retry in the background.

The initial investigation found the profiled duplicate candle installation consumed only about0.5–1.4ms. That lifecycle was not changed. Starting network work earlier was the more promising critical-path change.

## Exact-source validation

On `61f2577b`: frontend **2,712 pass /0 fail /11 skip**, 180 files pass /1 skip; domain build, dashboard typecheck/production build, **87/87 guards**, **7/7 bindings** pass. Focused warmup suite13/13 overlaps the full total. The initial full run on `00acbda7` had5 failures in navigation tests whose query-client mocks lacked the prefetch method. Test doubles were corrected and role-specific no-warm checks added; application gates were not weakened. Initial failed logs are retained.

Actual Scanner browser: **8/8 warmup assertions** prove a single bounded GET on the dashboard, no hidden native chart or chart tick stream, reuse by navigation, exact canonical/displayed OHLC and unavailable feed remaining non-live. **18/18 functional assertions** cover delayed data, retained and visible focused controls, provider-source reset, engine continuity, full exact-field OHLC, desktop/phone layout and no page exceptions. Expected blocked/unavailable offline endpoint503s remain in receipts. No full backend/root/database, broker or real-provider acceptance is claimed. Self-review only; independent review remains a limitation.

## Matched first-navigation measurements

Candidate fixture `8bf945f0036fbb49`, clean unchanged `61f2577b`; baseline fixture `caa203fa46f4cb69`, clean unchanged QA observer `5ac145e02db4d7579db062f1c458b9f48c8f7f96` (application `5f9a1c82`). Both ordinary minified production-runtime fixtures using actual dashboard routes/providers/styles and synthetic 200-bar history. Fixed80ms mock candle response; all APIs intercepted, no active AI analysis. All owned builds/tests stopped before timing. Host-wide contention is not proven absent.

Strict immediate first actionable click, no deliberate idle dwell. Browser resources prepared by fixture setup; every attempt reloads the full document and query cache. These are not cold browser-process or owner-published-app timings. Completion requires exact canonical/displayed OHLC, actual series/source/timeframe, visible unobscured plot and two rendering opportunities. This is not a hardware paint timestamp. Original150ms readiness-to-click and100ms completion gates unchanged. All60 planned attempts retained, source/visibility valid; all40 slowed attempts still fail100ms, all20 normal attempts pass. No dropped outliers or retry-until-pass.

Each cell: median / maximum milliseconds, five attempts per viewport per batch. Order: candidate4×, candidate normal, fresh baseline4×, baseline normal, fresh baseline4× repeat, fresh candidate4× repeat.

| Batch | Desktop | Phone width | ≤100ms |
|---|---:|---:|---:|
| Candidate4× |251.4 /308.9|246.2 /323.4|0/10|
| Baseline4× |365.7 /383.6|330.3 /377.7|0/10|
| Baseline4× repeat |361.2 /386.8|344.8 /399.8|0/10|
| Candidate4× repeat |251.2 /265.9|239.0 /294.7|0/10|
| Candidate normal |54.8 /56.3|50.1 /51.3|10/10|
| Baseline normal |52.7 /54.1|50.9 /51.8|10/10|

The slowed gain repeats in reversed order: about84–115ms lower medians in these groups. Normal desktop median rises2.1ms, phone falls0.8ms; neither establishes a population-level difference. Initial candidate candle requests start90–109ms before click; baseline ranges from63ms before to16ms after. This supports the earlier-read mechanism without proving every stage's causal contribution.

Dashboard navigation-link readiness was also retained: first candidate/baseline medians desktop291.0/285.0ms, phone285.2/291.5ms; reversed baseline/candidate desktop284.1/283.2ms, phone280.6/284.5ms. These small groups do not establish a material dashboard-readiness regression or guarantee its absence on other hardware/network conditions.

This is a verified local incremental speed gain, not instant loading, full analysis readiness, real-device speed, TradingView/MT5 superiority or architecture completion. Chart controls, capabilities and competitive comparison gaps remain open.

## Replit completion and next import

Read-only connector reports previous DMI/drawing-shortcut import complete: application `831ec35ca63b0dc3f027da478fddcd3480e4cc41`, workspace checkpoint `e134a2203fffebcaa4dd6322532016a4922395f5`, recovery `6243c71939ad9801e9de044e75a33c208ad18595`, clean branch `codex/pr103-smart-chart-development-20261031`. Frontend2658 pass0 fail11 skip; pure API76, scheduling13, recorder22, guards87, bindings7, DMI browser30 and drawing browser28 pass; typechecks/both builds pass. One supplemental harness failure corrected and retained. Raw remote files have not been independently inspected locally; connector response archived.

No new remote navigation measurement: previous0valid/1invalid/9unstarted, readiness1393ms, visible completion239.3ms; valid median/max null. Earlier invalid runs and zoom timeouts persist. Comparison shortcut isolation, unfinished drags, text-note shortcuts, DMI replay, physical device/owner/provider acceptance remain unverified remotely. API activation remains deferred, including refreshed-process volume verification.

Next: selectively import accepted individual study-line controls and this earlier-read change into that completed development checkpoint, preserving concurrent auth/signout/startup/dependency/Truth/safety/funds/recorder work. Validate the exact new combined source, retain all failures/skips/outliers, and keep every earlier performance gap explicit. No held experiment may enter that import. Then profile remaining actual route mount/style/layout work on the improved source, where candle readiness is earlier.

Raw evidence `/Users/areyouok/arx-tier1-release/scanner-early-candles-20261031`; portable receipts and SHA-256 hashes under `docs/validation/scanner-early-candles-20261031/manifest.json`. Owned local test browsers/servers closed. No main merge, deployment, existing-database changes, API/worker activation, funds movement, emails or live/demo broker tests.
