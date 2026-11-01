# Smart Chart reader feed evidence — 1 November 2026

Development-only application `b11a66326dffc9a62ab33bbb6f97d2cf3029df1d`, based on `78f7721f`. Architecture, deployment qualification and competitor parity remain incomplete.

## Corrected behavior

The embedded Scanner reader previously mapped any unconfirmed live feed or failed candle refresh to stale. A missing live confirmation or a failed request does not prove elapsed staleness. The reader now reuses the existing chart display-status authority to distinguish proven stale, delayed, unavailable and unconfirmed feeds. Latest-request failure is separate evidence and can coexist with an already-proven stale feed.

Valid, source-bound closed candles retain their chart patterns and descriptive statistics; feed labels do not fabricate prices or discard valid history. Recovery clears the failed-read caveat. The reader cache includes this independent failure evidence, preventing an old caveat from surviving an otherwise identical window. Frozen replay ignores unrelated live-request failures and retains its immutable observation cutoff. Order gates, source capture rules, candle calculations and broker paths are unchanged.

## Evidence

- Before implementation: six new component/cache assertions fail, 35 pass.
- Focused reader/cache/analysis:182 pass, 2 optional performance cases skipped.
- Full frontend:3,409 pass, 11 skip,zero failures;211 files pass/one skipped.
- Dashboard typecheck and ordinary immutable build pass; build `17dc68841d83ada5` records clean source before/after.
- Actual Scanner browser: 17/17 assertions. Stale, unconfirmed, delayed and unavailable fixtures have distinct visible labels, historical analysis remains ready, and complete canonical candle data stays identical across refresh/reload. No page errors or model/broker requests. The 390px reader screenshot was inspected; its added feed explanation remains readable with no page overflow.
- Read failure/recovery, unchanged annotation geometry and frozen replay isolation are component/cache proofs; they were not repeated through the browser network-error path.
- Two initial post-change failures retained in `after-initial-old-expectations.log`: old expectations treated read failure as stale and forced frozen replay recomputation for unrelated live-read failure. Both now assert the intended evidence distinction and replay isolation.

Independent source review found no actionable blocker. Root also reviewed the separate guard repair and caught an attribute-expression omission; it was fixed and tested before integration. Development integration `ed5ec5f4f6dc5aa3a3113dde0797492663539d66` combines this application with guard repair `9b9091e4ce7a6306aeec42b29b0ef134b5f22555`. Its application/library trees are byte-identical to b11a6632; only guard tooling differs. Root validation passes 28 guard assertions,14 calendar-negative mutations and 7 bindings. Full guards are 85/87, not green. Missing tools/paths/product files and parse errors now fail visibly; root/package scans agree. Tests and comments no longer count as product copy. Existing exact audience exceptions remain.

Remaining guard findings require review: 38 wording matches (20 admin capital labels,9 withdrawn chart-evidence messages,4 educational examples,3 disclosures/brand copy,2 analytics labels) and 3 raw JSON displays. They are not 41 confirmed product defects. No broad exceptions or product edits were made to erase these results. The existing assistant-name test suite is 33/34 because its final repo-clean assertion reports those three JSON displays. Static checks cannot fully resolve runtime audience or dynamically composed copy. Application tests do not make the overall release green. No navigation latency, physical-device, provider, live API, broker or matched competitive performance acceptance is claimed. All browser data is a generated historical fixture, with external APIs intercepted.

## Verified comparison

TradingView documents a distinct delayed-data indication in the chart status line. It also explains that chart data and broker order-panel quotes can have different subscription sources. ARX must likewise preserve source-specific evidence; a chart read cannot authorize execution. This change improves that distinction, without claiming equivalent provider coverage or latency. [TradingView delayed-data guidance](https://www.tradingview.com/support/solutions/43000471705-how-to-purchase-additional-market-data/) · [TradingView chart versus broker quote sources](https://www.tradingview.com/support/solutions/43000739323-how-does-the-source-of-real-time-data-affect-the-trading-experience/)

MT5 documents broker quote/tick-history downloads separately from current quote display. ARX's retained historical calculations are not proof of a current broker connection. Native-terminal comparison and real-feed qualification remain open. [MetaTrader5 Market Watch and history](https://www.metatrader5.com/en/terminal/help/trading/market_watch)

The broader owner requirements remain: automatic drawing families with editable methods, natural controls across all tools, simplify/restore, historical capital/sizing/equity/benchmark and comparable speed under constrained hardware. No main merge, running-app restart/activation, deployment, existing database changes, workers/emails or trading.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-reader-feed-evidence-20261101/`.
