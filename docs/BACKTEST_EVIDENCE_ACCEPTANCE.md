# Backtest evidence and source isolation

Status: local correctness, processing targets and scoped desktop/mobile browser checks pass. No competitor parity or readiness certification.

## Baseline and competitive requirement

The legacy Testing Lab could mark a generated-price run VERIFIED from only 30 trades and a profit factor above 1. Its historical loader selected candles across all owners and bridges, deduplicating by timestamp. Read endpoints republished stored verification prose. The comparison screen averaged unrelated runs and could declare an out-of-sample edge by comparing them with unfiltered shadow results. Backtest P&L is an unscaled price difference, yet charts described it as account currency and placed it on the same scale as R.

[TradingView's strategy documentation](https://www.tradingview.com/pine-script-docs/concepts/strategies/) describes explicit broker-emulator fill assumptions and commission/slippage modelling. [MT5's tester](https://www.metatrader5.com/en/terminal/help/algotrading/testing) supports later chronological forward periods and execution-delay assumptions. [QuantConnect's walk-forward approach](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization) retrains on trailing windows and discusses the overfitting tradeoff of optimization frequency. These establish functional criteria; no competitor runtime measurement has been collected.

## Acceptance criteria for this correction

- Generated, unattested broker and unknown-source runs remain distinguishable diagnostics. No trade count, profit factor, stored VERIFIED flag or injected evidence object grants verification, promotion or comparison authority.
- List, detail, AI review, chart, history, CSV and strategy lookup cannot restore unsupported claims. Read projection preserves stored history.
- New broker history reads require both candle owner and current bridge owner to match the actor. Only one observed bridge/native-symbol/account tuple is accepted in one database snapshot. Multiple tuples, malformed candles or duplicates are unavailable; ambiguous history never falls back to generated prices.
- The observed account field is not immutable account-era proof. Diagnostic broker history remains unattested. Existing saved runs without immutable candle snapshots cannot obtain depth by recounting today's cache.
- P&L and drawdown use price units. Different units use separate chart scales. Cross-run sample counts do not become weighted performance or evidence of an out-of-sample edge. The shadow summary is visibly unfiltered.
- Small FX losses, drawdown and markers retain their finite precision. Zero-origin gross curves accumulate independently of an arbitrary initial-balance offset. Missing/non-finite metrics are unavailable, and the ambiguous legacy profit-factor sentinel 999 cannot become infinity. Optional new gross fields preserve transport compatibility; an old response without them cannot be presented as a precise curve.
- Loading, unavailable and confirmed empty history are distinct. A failed/refused read cannot become zero trades or an empty forward history. Strategy changes clear selected curves before paint; returning to the old strategy cannot silently restore a previous selection. CSV quoting preserves fields containing commas.
- Actual disposable PostgreSQL tests cover ownership, ambiguity, malformed input, old stored flags and route behaviour. Frontend tests cover legacy/forged metadata, source absence, strategy switching and unit separation.
- Record median/p95/p99. Initial processing budget: projection of 200 records p95 under 2 ms; local 5,000-bar history read p95 under 50 ms on documented hardware. Added provenance checks may cost time; report the cost without calling them a speed improvement. UI visible-feedback target remains p95 at most 100 ms and must be measured separately.

## Remaining work

This correction does not repair the legacy simulator's same-bar fills, gap-stop model, absent costs/liquidity/currency conversion, absent chronological holdout, float4 stored outcomes, or missing immutable experiment history. No current producer qualifies as verified. Recorded broker account numbers can be payload-supplied and old bars can span account changes; a new authenticated account-era store remains necessary. User-selected source controls and real source-bound experiments remain open. Existing promoted/live settings are not changed by this read correction. No orders, publication or production database mutation are part of validation.

Next: add a versioned causal research engine, explicit fill/cost assumptions, immutable input/parameter/strategy identities and time-aware holdout experiments. Measure correctness and runtime against the existing simulator; do not relax diagnostic classification until the new evidence contract is actually satisfied.

## Precision evidence

[TradingView's official price-format interface](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/PriceFormatBuiltIn) exposes precision and minimum-move controls. Fixed two-decimal rounding is not a suitable assumption for unscaled FX price differences. This correction preserves finite raw values and uses ten significant display digits, with scientific notation for very small/large values. It does not infer an instrument's tick size or account currency.

The frozen previous series builder turns a -0.001 FX loss into zero P&L/drawdown/marker; the new builder retains -0.001 and 0.001 drawdown. A separate extreme-offset probe retains a -0.000001 gross loss that vanished when added to a large plotting balance. Raw arithmetic remains binary floating point and the database's existing float4 outcomes remain a limitation.

On the documented local reference machine, 1,000 alternating completed processing samples after 100 warmup pairs measured 5,000-trade curve median/p95/p99 of 0.185/0.284/0.592 ms before and 0.244/0.425/0.694 ms after. The added p95 cost is 0.141 ms. Adaptive formatting of 100 values has p95 0.051 ms versus 0.011 ms before. These are pure processing measurements, excluding browser/network/database/broker time. They pass the predeclared processing budgets, not competitor parity. Full samples, source hashes and the retained initial negative-zero assertion issue are in the local `backtest-precision-review-20261026/receipt.json`.

## Local validation and performance

The corrected slice passes 31 domain/series/format checks, 14 actual disposable PostgreSQL correctness checks and 46 frontend checks. The PostgreSQL handlers execute with controlled request/auth contexts and the real local database; these are not full HTTP middleware or broker tests. All four workspace type-check units, 87 guards plus seven bridge syntax assertions and both production builds pass. Generated OpenAPI clients are regenerated. Failed fixture-only assertions, the initial single-owner facade guard failure, and sandbox IPC failures remain in the local logs alongside the successful corrected runs.

| Completed workload | Previous median / p95 / p99 | Current median / p95 / p99 | Target |
| --- | ---: | ---: | ---: |
| Read and map 5,000 bars from local PostgreSQL | 11.348 / 11.710 / 12.810 ms | 13.823 / 15.544 / 16.147 ms | p95 < 50 ms |
| Project 200 saved records | 0.341 / 0.375 / 0.417 ms | 0.575 / 0.651 / 0.900 ms | p95 < 2 ms |

The history comparison uses 100 alternating paired trials after ten warmups, actual existing indexes and a single observed source where old/new outputs are comparable. Ownership/ambiguity failures are tested separately. The projection comparison uses 500 paired trials after 50 warmups. All samples and outliers are retained. Added history p95 cost is 3.834 ms; added projection p95 cost is 0.276 ms. This is correctness work within the processing budget, not a speed-up. The history benchmark does not establish multi-million-row capacity or provider latency.

Controlled production-browser checks pass the diagnostic labels, small-loss precision, unit-separated charts, A→B→A selection reset, CSV parsing and denied-read unavailable states. Eighteen trusted pointer-down tab changes per condition measured local second-animation-frame feedback median/p95/p99 of 31.05/33/33 ms on desktop and 35.35/67.3/67.3 ms at 4× CPU slowdown. DOM commits are measured separately. Those small samples exclude provider completion, physical painted pixels, heavy charts, 60 fps and competitor timing. The initial incorrect click-phase timing was retained and excluded. A mobile tab overflow discovered visually is corrected to a two-row layout: the final production-build recheck keeps all four tabs, title and unavailable-history message inside the 390-pixel viewport through repeated tab switches. That CSS correction was checked separately without claiming a new timing run.

Reference hardware: Apple M4 Pro, 14 cores, 24 GiB, macOS 26.6.2; controlled browser Chrome 155, 1440×1100 desktop and 390×844 mobile. Agents coordinated quiet performance windows; unrelated operating-system work was neither isolated nor terminated. Reproducible logs/samples/build hashes are in `arx-tier1-release/backtest-evidence-authority-20261026`, `backtest-precision-review-20261026` and `testing-lab-browser-20261026`. These local results do not imply deployment, remote CI or live/demo validation.

## Review branch scope

This review is stacked on Profit Mission PR #92 at `323754efa17b3bc4b031cf1fe0a266995e74a198`. Its new domain, server and browser implementation files are byte-identical to development checkpoint `81c5781ca4be7a6c2e457fb70f9b96fde53cc8ff`. Package/CI registrations are additive to this smaller base; OpenAPI and generated aggregate files retain that base's unrelated schema content. Canonical regeneration leaves the review tree unchanged.

Fresh checks on this review branch pass 31 domain/series/format, 14 required PostgreSQL and 46 browser-component cases, all four type-check units, 87 guards and both production builds. The optional history benchmark is not repeated here; its completed measurements above, the precision benchmark and the controlled production-browser run were collected on the original development checkpoint. Seven additional bridge syntax assertions mentioned in that checkpoint are not present in the PR #92 base and are not claimed as fresh review checks. Source identity supports reuse of the scoped measurements; it does not establish the performance of unrelated code in this smaller stack. No remote CI result, merge or deployment is implied.
