# Scanner first view and aligned chart acceptance — 1 November 2026

Status: verified development progress, **not release-green or architecture complete**.
The final application is `43ff8bb685e07bec51b0b4f737ce33587dbe5f3b`, branch
`codex/scanner-first-navigation-20261101`, frozen actual-Scanner build
`6e228bd25378ed10`. This extends saved checkpoint `f419a37b`; no systems were rebuilt.

## What changed

The baseline had correct candles but stacked controls pushed the plot outside the
first screen: all ten source checks succeeded, while all ten visible-completion
checks timed out. Desktop plot y=1014/1100; phone y=767/844, above a fixed bottom
navigation. This was a visibility failure, not evidence of an eight-second feed.

The existing detailed tools and explicit assistant-selection controls now stay
mounted beneath the plot on every viewport. Symbol/feed identity, source-clock
qualification, integrity warnings and the single fullscreen control remain above.
No warning, source gate or assistant-selection authority was removed. The same
canvas and workbench survive breakpoint changes; controls are not deferred behind
a success flag. The existing four Truth verdicts use compact fully wrapping cells
on phones from 360px, two columns below 360px or when Details is expanded. Verdict
values, colors, shared sources and execution permissions are unchanged.

The mobile engine now initializes using its existing responsive-height policy,
rather than building a cached chart at 520px and immediately resizing to 360px.
Regression tests failed on the old implementation. No new rendering owner,
confidence threshold or trading path was introduced.

## Exact-source evidence

| Check | Source | Result |
|---|---|---|
| Full frontend | ae52dd3f | 3304 pass, 11 skip, 0 fail; 207 files pass, 1 skip |
| Dashboard typecheck and workspace declarations | ae52dd3f | pass |
| Final chart/Truth regression suites | 43ff8bb6 |144 pass, 0 fail/skip |
| Portable fixture tooling |43ff8bb6|30 pass |
| Safety guards / bridge bindings |43ff8bb6|87/87 and7/7 |
| Clean isolated production actual-page build |43ff8bb6|pass |
| Desktop actual Scanner profile/assistant journey |43ff8bb6|275 assertions pass |
| Phone actual Scanner profile/assistant journey |43ff8bb6|35 assertions pass |

The later production changes after ae52 were responsive CSS only. Full frontend
results above are not relabelled as a run on 43ff. Backend source was unchanged;
root CI/live-server/provider/broker acceptance was not rerun or inferred.
The first guard invocation was denied its local IPC pipe; the retained authorized
retry passed. All failed layout/height regressions and browser attempts remain.

## Navigation measurements and open limits

Final 43ff, strict trusted immediate first click after full-document home reload:

| CPU / viewport | Valid / planned | <=100ms | Median | Maximum |
|---|---:|---:|---:|---:|
| Normal desktop 1440x1100 |5/5|5/5|56.0ms|62.3ms|
| Normal phone 390x844 |5/5|5/5|51.8ms|53.5ms|
| 4x desktop |5/5|0/5|271.8ms|377.1ms|
| 4x phone |5/5|0/5|262.5ms|296.5ms|

The existing app warmup had already started the candle GET **108.6–128.6ms
before the click** in all ten normal attempts. Mock response preparation ended
before the click too; this is not browser receipt or parsed/cache-ready evidence.
Ready-to-click was101.1–118.9ms within the150ms gate. The table measures
post-click display completion with warmup underway, **not fetching and rendering
entirely after the click**.

All samples, outliers and invalid attempts are retained. The earlier 48a9 build
also passed 10/10 normal attempts (54.5–92.6ms), and failed all ten 4x targets.
The preceding ae52 layout passed desktop but failed all five phone visibility
checks; it was not accepted as a complete first-view fix.

Completion requires exact canonical and actually displayed200-bar OHLC, source,
context and engine identity over two frames, plus a 100x100 unobscured plot area.
The fixed 80ms offline response is synthetic historical data, with inactive AI
market analysis; APIs/writes/streams/external requests are intercepted. Prepared
browser resources precede each full-document reload. This is not cold-process,
hardware-paint, current published-app or provider timing. Agents and owned heavy
checks were idle during timing; an unrelated long-running host process was
observed using 129% CPU, so the whole machine was not isolated.

**The 100ms slowed-CPU goal remains unmet.** At 320px, readable two-column status
cells are retained, but the first plot still falls below the fixed navigation.
Later reconnect warnings can also reduce the 390px plot intersection below 100px.
The retained long-label/doubled-text diagnostic has no horizontal overflow and
Details stays usable, but word wrapping needs further polish; this is not physical
phone or browser-zoom certification. Do not claim the owner's remote five-second
delay is fixed, or TradingView/MT5 parity/speed superiority.

## Portable AI / Truth acceptance

The existing shared offline Scanner setup now accepts optional fixture hooks;
there is no copied second network harness. The original normalized synthetic
AAPL/M15 fixture is preserved byte-for-byte, including its seven session-gap
flags. SHA256: `47431eb58f1a539aa84a66461dccd8b95e05cb001186565bfa27c976cb0735df`.
See `scripts/scanner-qa/STOCK_PROFILE_ACCEPTANCE.md` for the executable procedure.

The journeys independently check original-bar allocation, POC/value area, actual
horizontal geometry, seven styles/four scales, frozen ranges, explicit recapture,
hide/edit/duplicates, source/quantity/clock/finality withdrawal, persistence,
selected-pane AI commands, research hold and real PNG export. Exact comparison
polls require limit=300, unique fulfilled response identity, advanced adapter
revision and installed expected state; the unrelated limit=200 reader cannot
satisfy that gate. Both journeys reject diagnostic builds, external/WebSocket
attempts and every unclassified write. Only the three exact already-blocked
background POSTs are permitted as recorded 503 attempts. Diagnostic failures cannot
throw away evidence already collected. Unknown GET failures remain in raw logs.

The actual exported PNG was visually inspected: readable profile/VWAP, exact UTC
anchor/range labels, method and provider trade-unit qualifications, and explicit
not-live-confirmed provenance. This remains an estimated OHLC allocation, not
measured volume-at-price, order flow or a live qualified stock feed. No remote
model/provider/order action ran. Phone chart and assistant screenshot was also
inspected; broader visual polish and device coverage remain open.

## Delivery and next work

Replit's existing f419 source-only update is still busy; repeated status requests
were not queued. It was not restarted or superseded, and these new changes are
not claimed installed there. A source/hash manifest is prepared for the next
incremental development sync after the pending result is recorded. No main merge,
deploy/publish, running API/frontend replacement, existing database change,
worker/email/settlement activation or live/demo broker test occurred.

Next: record Replit's exact completed source/checkpoint and actual results;
profile the final slowed-CPU critical path; correct very-narrow/reconnect first
views without concealing Truth; continue the original owner brief, requirements
census and all unfinished competitive/AI/drawing/research/self-trading gaps.

Raw evidence: `/Users/areyouok/arx-tier1-release/scanner-first-navigation-20261101`.
The checked-in JSON receipt ties every result to its actual source.
