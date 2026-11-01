# Portable historical research v2

This extends the existing causal research engine. It is diagnostic, does not place orders and supplies no account-currency return, capital, position-sizing or promotion claim. The old v1 server function, MID-only input policy and exact JSON fingerprints are preserved; three pre-extraction golden fixtures and full Node/WebCrypto output comparisons protect that contract. The existing durable experiment store stays v1-only. No migration or service is enabled.

## Integration contract

- `@workspace/domain/backtest/research-core`: browser-safe types `ResearchV2Input`, `ResearchV2Strategy`, `ResearchV2Config`, `ResearchV2Result`; normalized `validateResearchV2Strategy` and `validateResearchV2Config(raw, barCount)`; pure preparation/finalization used by both runtime wrappers.
- `@workspace/domain/backtest/research-browser`: async `runCausalResearchWeb` for v1 and `runCausalResearchV2Web` for v2, using WebCrypto SHA-256. Both refuse a browser document context **before** reading inputs. The UI must call them only inside a dedicated Worker; async syntax alone does not move computation off the main thread. Worker orchestration, cancellation, chart capture and result binding belong to the chart controller.
- `@workspace/domain/backtest/research`: original synchronous Node `runCausalResearch`, plus `runCausalResearchV2`, using Node SHA-256 and the same pure preparation and execution loop.
- `@workspace/domain/chart-indicator-math`: the exact seeded-average checkpoint and true-range arithmetic extracted from Smart Chart. Both the actual `StudyCalculator` and research use this module; no dashboard import enters the domain or Worker core.

V2 engine version is `arx-quote-ohlc-research-v2`; strategy version is `ema-cross-atr-v1`. Input remains `{symbol, priceBasis, intervalMs, asOfMs, source:{kind,reference}, bars:[{openTimeMs,open,high,low,close}]}`, with price basis restricted to **BID or MID**. LAST, ASK, SYNTHETIC and omitted bases are refused. The caller must preserve authentic source declarations; accepted metadata is still not proof of market provenance.

Configuration is explicit and default-free:

```ts
{
  strategy: {
    version: "ema-cross-atr-v1",
    fastPeriod, slowPeriod, atrPeriod,
    stopAtrMultiple, targetR, maxHoldingBars,
    direction: "both" | "long_only" | "short_only"
  },
  costs: { fullSpreadPriceUnits, adverseSlippagePerFillPriceUnits, feePerFillPriceUnits },
  maxEntryGapMs,
  splits: { trainEndExclusive, validationEndExclusive }
}
```

Periods are integers 1–1000, with slow at least 2 and fast less than slow. Stop multiple and target R are positive and at most 100. Holding period is 1–10,000 observations. Three chronological partitions are nonempty. The existing 100,000-bar core bound is retained; UI capture should use its smaller declared bound. Missing costs are never silently changed to zero. A UI may offer an explicitly labelled zero-cost scenario, which is not a claim about broker fees.

## Signals and execution

EMA uses closes, a full SMA seed and weight `2/(period+1)`. ATR's first bar contributes high-low; later true range includes the previous close. It uses a full SMA seed followed by Wilder weight `1/period`, matching the visible chart's ATR. Every signal requires a preceding warmed-up EMA pair. Equality on the previous pair may cross to strictly above/below on the current closed bar. Warmup uses observed bars, not invented bars across gaps.

A long crossover is previous fast ≤ previous slow and current fast > current slow; short is the mirror. Direction filtering only suppresses entries. Existing positions are never reversed, and an opposite crossover is **not** an exit rule. There is one position per partition. A supported crossover's ATR stop distance and target-R distance are frozen at that signal's close. They are anchored to the later modeled entry fill, never recalculated from the entry bar's future high/low.

Entries occur at the next observed open, subject to explicit gap expiry. Partitions start flat, cannot carry pending signals or positions, and may warm indicators from already observed prior bars. This is fixed-parameter chronological partitioning, not fitted training or proof that holdout was never examined.

For **BID**, a BUY enters at bid + supplied spread + adverse slippage and liquidates at bid − slippage. A SELL enters at bid − slippage and liquidates at bid + spread + slippage. The observed BID series is never relabelled as an observed midpoint. For **MID**, the existing modeled bid/ask offsets remain midpoint ± half supplied spread, with adverse slippage on each fill.

Stops and targets are liquidation-side trigger prices at the frozen distances from modeled entry. The existing conservative OHLC rules remain: opening protective triggers precede scheduled holding-period exits, later intrabar dual touches choose the stop, adverse gaps fill at the opening liquidation quote and favorable target gaps are capped at target. Targets are market-on-touch exits, not limit orders. Very small brackets relative to modeled costs can stop immediately; broker minimum-distance/rejection rules are not modeled.

V2 ledger fields are `entryReferencePrice`, `exitReferencePrice` and `markReferencePrice`, tied to the retained input basis. Final modeled fills remain `entryPrice`/`exitPrice`. Each decision stores prior/current fast/slow EMA values, ATR and frozen distances. Indices address the captured original bars; entry time is the later open. Exit time is either exact open or the complete OHLC bar interval—never an invented intrabar instant. Open partition-end observations remain unresolved rather than being fabricated as completed trades.

Gross-to-net decomposition is unchanged: reference-price movement minus one full spread, two adverse slippages and two supplied per-fill fee equivalents. Results are price units per one synthetic unit, with no financing, liquidity, partial fills, margin, currency conversion or volume-capacity model.

## Reproducibility and checks

Before the first async hash await, each wrapper has copied, validated, simulated and recursively frozen the exact input/config/result body. Caller mutation cannot mix versions while WebCrypto runs. Schema key order is reconstructed; extra input keys are ignored, not hashed into false semantics. Engine version, strategy, input, configuration and complete result body participate in fingerprints. A hash proves matching supplied content, not authenticated provenance.

The registered causal-research lane runs v1 and v2 tests together. Independent hand-calculated fixtures cover SMA seeds, Wilder ATR, next-open execution, frozen signal brackets, BID/MID long/short sides, costs, gap expiry, conservative dual touches, direction filtering and chronological isolation. Tests also cover Node/WebCrypto byte parity, caller mutation during await, browser-main-thread refusal, unsupported bases and shared manual/parser validation. Actual Smart Chart study values are compared with the research decisions at their signal indices; existing study revision/append tests protect checkpoint behavior.

Seven mutation checks deliberately broke future-bar selection, signal-time ATR freezing, BID long entry spread, BID short exit spread, dual-touch priority, the SMA seed and main-thread refusal. Every mutation caused assertion failures. Raw logs are retained under `/Users/areyouok/arx-tier1-release/research-portable-v2-20261101/`. Source review by the separate Truth agent found no blocking quote/timing issue. Performance measurements and integrated Worker/browser acceptance are separate receipts, not implied by unit tests.

## Comparison boundaries

[TradingView's strategy documentation](https://www.tradingview.com/pine-script-docs/concepts/strategies/) and [MT5's tester documentation](https://www.metatrader5.com/en/terminal/help/algotrading/testing) describe broader strategy-testing and optimization capabilities. This bounded fixed-rule OHLC extension does not match their full tester, scripting, tick modeling, multi-asset or optimization capabilities. No competitor speed, return or execution-parity claim is made.
