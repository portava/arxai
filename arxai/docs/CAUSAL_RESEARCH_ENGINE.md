# Causal research engine v1

Status: standalone offline domain engine. Diagnostic, unverified, no promotion authority. No route, UI, database migration or live execution integration is introduced. The existing saved backtests and their float4 outcomes are untouched.

## Baseline and primary-source comparison

The existing `simulateBacktest` accepts a signal callback, fills at its proposed current-bar entry price, stops at the requested stop even across a gap, omits transaction costs and closes any final position synthetically. Its output does not preserve a chronological experiment or immutable input snapshot. These are documented gaps, not evidence of strategy profitability.

[TradingView's strategy documentation](https://www.tradingview.com/pine-script-docs/concepts/strategies/) describes next-tick fill timing, historical OHLC path assumptions and explicit execution costs. [MT5's tester documentation](https://www.metatrader5.com/en/terminal/help/algotrading/testing) separates a later forward period and models execution delays. [QuantConnect's reality-model guidance](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/key-concepts) distinguishes fills, fees, slippage and capacity assumptions; [its walk-forward guidance](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization) uses time-aware training windows. These official sources establish functional comparison criteria. No competitor throughput, return or execution-parity measurement was performed.

This slice adds a bounded fixed-strategy engine rather than claiming the much broader capabilities of those systems. Train, validation and holdout are chronological research partitions, not fitted models or proof that a human has never examined the holdout.

## Acceptance

- Only declared **MID** closed OHLC is accepted. BID, ASK, LAST, SYNTHETIC or missing price-basis labels are not reinterpreted. Generated midpoint observations must be explicitly labelled as generated source data. This declaration is not authenticated producer evidence.
- Every input has explicit source reference, interval and historical as-of cutoff. Duplicates, overlap, malformed/sparse arrays, contradictory OHLC, non-finite arithmetic, incomplete observations and oversized histories fail without fallback or guessed values.
- The only strategy is versioned `close-momentum-v1`, using current close minus close N observations earlier and an explicit strict threshold. There is no arbitrary callback, network, clock, optimizer or hidden feature fit.
- Signal at close i can execute only at open i+1. Mutating later observations cannot change earlier decisions, completed trades or marked outcomes. A missing next observation is not a fill. An entry across a gap greater than the explicit tolerance expires.
- The three nonempty chronological partitions start flat. Signals/positions do not cross partition boundaries. Previously observed bars may warm the fixed momentum feature; later partitions never warm earlier ones. Open terminal outcomes are retained separately and cannot become completed zero-P&L trades.
- Spread, adverse slippage and fee equivalents are required nonnegative price-unit inputs. Explicit zero is allowed; omitted values are not free-trading defaults. Long/short prices and gross-to-net decomposition must agree without charging spread twice.
- Ambiguous intrabar stop/target touches choose the stop, adverse opening gaps execute at the worse opening quote, and favorable target gaps receive no improvement beyond the target trigger. Intrabar execution time is an interval, not a fabricated precise timestamp.
- A new invocation returns independent recursively frozen input/config/result snapshots and reproducible SHA-256 fingerprints. Caller mutation and key order cannot silently change the recorded result. This is **in-memory** immutability; durable experiment storage, signatures and a repeat-trial audit remain absent.
- Initial full-processing budget: 5,000 bars p95 at most 100 ms, including validation/copies, simulation, hashing and recursive freezing. Report 50,000-bar heavy workload separately. Retain every median/p95/p99/max sample and failure. There is no early acknowledgement; completed function return is the timing boundary.

## Exact execution and accounting convention

One synthetic unit and one position at a time are modelled. Prices stay in the instrument's price units. There is no lot multiplier, contract size, account currency, financing, buying power or money accounting.

For midpoint P, full spread S and adverse slippage L, the model's bid is P−S/2 and ask is P+S/2. BUY entry fills ask+L; SELL entry fills bid−L. The stop and target trigger distances are anchored to that filled entry price. Long protection observes bid OHLC, short protection observes ask OHLC. Targets are **market-on-touch exits**, not limit orders; adverse slippage applies to their fills too. The constant bid/ask series is a scenario derived from explicitly declared midpoint data, not historical quotes.

At each later open the model checks an already-triggered stop, then an already-triggered target (with favorable gap improvement capped), then any scheduled holding-period market exit. A scheduled exit that remains applicable fills at that open without reading its later high or low. Only afterward are that bar's intrabar touches examined, choosing the stop if both occur. This opening priority is an explicit conservative modelling convention, not a claim about a broker's order queue. Protection may trigger on the entry bar after its opening fill.

Long net P&L is exit fill minus entry fill minus two per-fill fees; short is the reverse difference minus those fees. Spread and slippage are already in the fill prices. Their separately reported costs are a decomposition of midpoint gross P&L, never another deduction. Fees are supplied price-unit equivalents per unit per side, not inferred broker-currency amounts. Binary floating-point arithmetic remains; overflow is refused rather than converted to zero, a sentinel or an unsupported result.

At a partition end an open position remains `outcome: unresolved`. Its mark reports a hypothetical liquidation at the final observed close with the model's exit spread, slippage and estimated exit fee. It is not appended to completed trades. Metrics distinguish no signals, no completed trades, open outcomes and completed outcomes. Win rate is unavailable without completed trades; profit factor is unavailable without completed trades or losses, without a 999 sentinel or fabricated infinity. Completed P&L and hypothetical marked P&L are separate.

Drawdown is from zero-origin marked net P&L **at observed bar closes and completed outcomes**, including costs of a hypothetical open-position exit. It is not worst intrabar drawdown and can miss an entry-price trough or an adverse excursion that recovers before close. Different partitions have separate curves and metrics; no pooled figure implies out-of-sample edge.

## Reproducibility and bounds

The dedicated `@workspace/domain/backtest/research` export is server/offline-only because it uses Node SHA-256. Existing browser backtest imports do not load it. Inputs are copied into schema-defined key order; those exact values, every explicit configuration parameter and the engine/strategy version participate in fingerprints. The result fingerprint binds input/config/strategy hashes and all result observations/limitations. A hash detects changed content, not authenticated source or authorship.

Bounds are 100,000 bars, 10,000 momentum observations and 10,000 holding observations. The engine is synchronous and CPU-bound; it is not appropriate to expose this unbounded-by-tenant calculation directly on a request handler. A later route needs authorization, tenant resource limits, cancellation/worker scheduling and persisted experiment records. No such route is enabled here.

Run focused tests with `pnpm --filter @workspace/api-server test:causal-research`. The script is registered in the existing local `ci` sequence; no remote CI execution is claimed. From `artifacts/api-server`, run `node --import tsx src/lib/backtest/__qa__/causalResearch.benchmark.ts /absolute/path/receipt.json` for the paired processing reference. The benchmark retains samples and source hashes, alternating legacy/current order after warmup. Both use the same input prices and momentum formula, but their fill/exit/cost/partition semantics differ, so the old simulator is only a processing-cost reference, never a return-equivalence or speedup claim.

## Local processing evidence

On Apple M4 Pro (14 cores, 24 GiB), Node 24.16, macOS 26.6.2, the actual functions ran in alternating order after ten paired warmups. The 5,000-bar workload used 100 paired samples; 50,000 bars used 40. Inputs are deterministic generated midpoint fixtures, not observed returns. Agent-heavy work was paused for timing; unrelated operating-system activity was not isolated. All samples/outliers and file hashes are retained in `arx-tier1-release/causal-research-engine-20261026/paired-processing.json`.

| Completed workload | Legacy median / p95 / p99 | New median / p95 / p99 | New max |
| --- | ---: | ---: | ---: |
| 5,000 bars | 0.241 / 0.542 / 0.786 ms | 7.534 / 10.469 / 10.655 ms | 11.132 ms |
| 50,000 bars | 72.726 / 77.821 / 79.432 ms | 76.328 / 80.442 / 95.269 ms | 95.269 ms |

The new 5,000-bar engine passes the predeclared 100 ms processing budget. Added validation, changed simulation semantics, full trace/snapshot hashing and freezing cost more than the legacy function. The heavy workload has no retrospectively invented pass threshold. These measurements exclude persistence, network, browser feedback, data acquisition and broker execution. They demonstrate local bounded processing, not competitor timing parity or profitability.

## Remaining gaps

No tick/broker fill verification, historical bid/ask spread, latency distribution, partial fills, liquidity/capacity, portfolio sizing, currency conversion, money ledger, margin, short availability, financing, taxes, data adjustments or authenticated account-era history is modelled. There is no strategy optimizer, parameter-trial registry, cross-validation selection process, statistical significance or guaranteed untouched holdout. Result snapshots are not persisted in an immutable experiment store. No producer becomes broker-verified; no profitable sample promotes a strategy or changes Profit Mission authority. UI/API integration and broader competitor capability coverage require separate review.
