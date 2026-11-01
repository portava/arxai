# Smart Chart historical research integration — 1 November 2026

Status: implementation in progress; no release-green or competitor-parity claim.
Base: `46f209f59064d1310174f544434540c657879729`. Final source and receipts will be recorded after combined validation.

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
