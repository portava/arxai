# Smart Chart historical research integration — 1 November 2026

Status: bounded implementation validated locally; no release-green or competitor-parity claim.
Base: `46f209f59064d1310174f544434540c657879729`. Tested application: `4ad8a5aceb82483fdb35cf9fd747768e55aabf2e`; actual Scanner production fixture: `a16bdd711903286e`.

## Existing authorities extended

The Scanner's existing ARXNativeChart owns the chart. The existing causal research engine owns simulation, cost arithmetic, chronological partitions and immutable fingerprints. The existing assistant opens an inspectable configuration; the manual editor uses the identical configuration constructor. The Truth adapter checks original source identity, closed-bar coverage and unchanged OHLC before accepting result markers. No second chart, chatbot, simulator, order pipeline or account-balance model is introduced.

The research panel loads on demand. A disposable Worker runs the shared engine; replacement, cancellation, failure, timeout and unmount terminate that worker. A request ID rejects late replies. The selected historical trade uses the existing overlay renderer with exact bar anchors, separate from current positions. OHLC interval exits never receive invented intrabar timestamps. Stops and targets are bounded historical segments; a same-bar round trip cannot create a fabricated holding-duration segment.

Version 1 replay and hashes must remain unchanged. Version 2 explicitly models original BID or MID prices and a closed-bar EMA crossover with signal-time Wilder ATR. Entry is the next observed open. Spread, slippage and per-fill fee equivalents are editable scenarios, not measured broker costs. One synthetic unit produces price-unit results, not account-currency returns. Unresolved positions remain unresolved. Repeated edits do not create a claim of untouched holdout validation.

## Competitor comparison, official documentation checked 1 November 2026

- [TradingView strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/) document executable strategy rules, simulated order reporting and limits of historical fills. [Strategy properties](https://www.tradingview.com/support/solutions/43000628599-strategy-properties/) include capital, sizing and cost settings. [Intrabar backtesting](https://www.tradingview.com/support/solutions/43000669285-what-is-bar-magnifier-backtesting-mode/) uses lower-timeframe observations within documented coverage limits.
- [MetaTrader 5 Strategy Tester](https://www.metatrader5.com/en/terminal/help/algotrading/testing) documents visual trade inspection, forward testing and configurable testing modes. [Optimization](https://www.metatrader5.com/en/terminal/help/algotrading/strategy_optimization) searches parameter sets. These documented capabilities are not runtime benchmarks against this ARX build.

ARX acceptance in this increment: a real Scanner chart request becomes editable rules; manual and text paths share configuration and engine results; exact source coverage is checked; worker results bind to the frozen inputs; ledger entries/exits and stop/target references are inspectable; costs and partition metrics use the engine's ledger; unsupported requests are refused rather than guessed. Browser feedback and calculation duration must be measured separately, preserving every failed run and outlier.

## Explicit remaining gaps from the owner's full document

This increment does not complete capital, sizing, contract multipliers, account currency, benchmark returns, lower-timeframe/tick fill simulation, general executable strategy language, multi-symbol strategy testing, optimization or parameter-search correction. It does not fetch an arbitrary two-year history: unsupported or insufficient original source history holds the requested test rather than substituting the latest 200 bars. Adapted deep-history pages and replay snapshots without original price-basis/finality cannot be relabelled as qualified input. Synthetic index prices are not guessed to be BID or MID.

VWAP, volume profile, full requested tool coverage, broader AI interpretations, saved durable experiment integration, real browser first-navigation speed and all prior TradingView/MT5 performance gaps remain open. A bounded local parser is not a general-purpose AI capability claim. No live/demo broker validation, deployment, existing database migration, worker activation or trading occurs in this work.

## Final combined validation

All checks below ran against application `4ad8a5aceb82483fdb35cf9fd747768e55aabf2e`. Documentation/manifest commits after it do not change the application.

- Frontend: **2,952 pass, 11 skipped**, 187 files pass / 1 skipped.
- Targeted backend: **150** backtest/Profit Mission checks, **47** Truth checks, **100** source-volume/forming checks; no failures or skips in these lanes.
- All four typecheck units, API and dashboard production builds, **87/87 guards**, **7/7 binding assertions** pass.
- Actual Scanner browser fixture: desktop **20/20**, 4× CPU **20/20**, phone viewport **22/22**. These repeat the same capability checks; they are not 62 distinct features. No page exceptions. Exact native marker plugin times, finite bracket segments, actual result explanations, two-year-history refusal and close cleanup verified. No research Worker loads on initial Scanner navigation.
- Phone screenshots exposed cramped columns in the first candidate. The final version separates cells and scrolls tables locally; the page itself remains within the phone viewport. Both desktop and phone chart/panel screenshots were visually reviewed.
- The browser intentionally blocks external requests, WebSockets and all API mutations. 35–36 unavailable API requests, four blocked mutation requests and associated console errors per final session are retained. Existing chart-alert scan, scalp-focus, activity-ping and assistant-session attempts were intercepted. No order request or broker activity occurred. Local assistant actions work even while remote session creation is unavailable.
- Shared engine checks preserve v1 golden fingerprints and Node/WebCrypto result equivalence. V2 arithmetic matches the chart's existing EMA/Wilder implementation. Independent agent review plus **7/7 caught mutations** support causality, quote basis, bracket and gap behavior. Original exact engine source was `f3ff08d3`; it is integrated unchanged here.

## Responsiveness evidence, with limits

Each browser case retains one cold Worker run and 12 repeated runs. Values below are milliseconds. Feedback frame means the first animation-frame callback after the calculating status changed; it is not pixel-paint proof. Completion includes the Worker result and source binding on the real Scanner route. No samples were discarded.

| Case | Cold feedback frame | Cold completion | Repeated feedback frame p95 | Repeated completion p95 |
|---|---:|---:|---:|---:|
| normal2 | 11.1 | 23.6 | 14.6 | 21.9 |
| slowed | 12.8 | 67.0 | 10.7 | 45.6 |
| mobile | 12.3 | 22.7 | 14.5 | 22.2 |

The preceding application `54b9c50e` also retains all four browser runs, including the initial desktop run without a cold-start timestamp; none are substituted for the final source. These fixtures use a bounded 175-bar source window. The engine-only 5,000-bar benchmark on `f3ff08d3` retained 200 paired samples plus 20 paired warmups: Node p95 6.83–7.58 ms and WebCrypto under Node p95 8.22–8.42 ms, worst measured 11.78 ms. That does not measure a browser Worker, paint, production navigation or a competitor.

The owner's five-second first Scanner visit and prior 10k/50k/multiview frame-budget failures remain open. Nothing here establishes overall instant loading, TradingView/MT5 parity or superior speed.

## Preserved failures and review corrections

Initial marker typing failed because a flatMap widened literal marker properties; its explicit native marker type fixed the error. A full frontend pass had one wording-sensitive assertion fail after an honesty disclosure was expanded; the same warning was preserved and the final full pass is green. Review also found and fixed retention of old runnable settings after an unsupported language request, adapter-identity mismatch risk, same-price metadata withdrawal, and immutable-result flags lost during Worker serialization. The mobile table issue and its before/after screenshots are retained. Initial Replit read failed with an incomplete MCP response; a subsequent read succeeded.

## Development source synchronization

Prepared inventory: `docs/development-sync/CHART_RESEARCH_2026_11_01.json`. It identifies all 167 changed paths from accepted reference `4357a358` to tested application `4ad8a5ac`, with original and target SHA-256 values. The exact binary patch was rehearsed in a disposable Git index and reproduced the target tree. It contains accepted additions only; held performance experiments remain excluded.

Replit read-only inspection reported branch `codex/pr103-smart-chart-development-20261031`, application `4348fc6a`, checkpoint `124f5ccc`, clean paths and no visible concurrent edit. Its API is plain Node on an already-built bundle, without source watching; editing source does not activate the new API. Frontend Vite may update imported domain source. API activation remains deferred; optional source evidence absent from the running API must remain unavailable. No runtime parity claim is made. Recheck concurrent work before import and preserve Replit setup and prior fixes. The import outcome is recorded in the durable checkpoint, not inferred from this local validation.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-research-workbench-20261101/`; agent receipts in adjacent `research-portable-v2-20261101`, `chart-research-evidence-20261101`, and `chart-research-language-20261101` folders. The requirements census and original owner brief remain authoritative; this is a partial addition to the existing systems.
