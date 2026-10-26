# Profit Mission evidence boundary — 2026-10-26

Status: this bounded correction passed local validation and independent review. No competitor parity, profitability, live readiness, or overall completion claim.

## Baseline defects

At `cc8f67271b2d97e4d4e7cab8928f9980ca27942b`, the mission backtest runner generates prices from a seed and fixed January 2024 timestamp. A minimum sample plus positive gross expectancy/profit factor can mark this record verified and promotion-eligible. Reads trust stored labels and booleans. No observed-market provenance, costs or chronological holdout supports that claim. Forward aggregation accepts arbitrary display labels while aggregating all mission outcomes, does not prove execution mode/net costs, and can average R from only the subset with R. The current mission execution mode cannot prove historical execution mode.

End-of-run simulated exits are also converted to planned target R or a full stop even when the actual exit moved only partway. Drawdown uses the wrong denominator: starting capital for simulations and the final global peak for forward results.

## Competitive criteria and sources

- [MetaTrader 5 Strategy Testing](https://www.metatrader5.com/en/terminal/help/algotrading/testing) documents chronological forward periods and execution-delay emulation. Its modes and account settings distinguish modelling assumptions. ARX must record source, actual test interval, costs and time-separated validation; generated prices cannot establish market performance.
- [TradingView strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/) documents broker-emulator assumptions and cost modelling, including commissions and slippage. ARX must disclose simulation assumptions and use realised outcomes rather than planned targets.
- [QuantConnect walk-forward optimization](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization) provides a relevant chronological research workflow. ARX still needs training/evaluation separation and experiment history before making robustness claims.

These are documented capability references, not measurements of competing products. No competitor latency or return comparison has been performed.

## Acceptance for this bounded correction

1. No current generated-price, unknown legacy, or unreconciled-draft record can be marked verified, count toward promotion, or enter a strategy-drift baseline. Supported data producers are explicitly diagnostic; a future verified producer requires its own validated evidence contract. Existing mission levels are not silently changed by a read. Already-promoted missions and their stored live-auto opt-ins are not retroactively demoted by this patch; historical promotion-state remediation remains unresolved.
2. Preserve append-only stored history. Rebuild labels, sample counts and eligibility on read; ignore historical verified/eligible booleans. Invalid metrics remain unavailable as evidence.
3. Save deterministic run inputs, source classification, cost/holdout limitations and R coverage with new records. Incomplete R is labelled as an observed subset, with its numerator/denominator; no observations means unavailable, never an inferred zero. Do not infer live/demo history from the mission's present mode.
4. Exact forward selectors filter actual strategy, symbol and timeframe. Unfiltered mixed contexts are labelled Mixed. Preserve per-user/mission isolation.
5. Realised R uses actual exit P/L divided by initial stop risk. Maximum realised drawdown uses each contemporaneous peak. Generated P/L remains gross price units, not account money.
6. UI shows diagnostic records and reasons but withholds unverified comparison deltas, currency comparisons and baseline/trend claims. No empty-state instruction suggests generated prices will unlock verified evidence.
7. Real disposable PostgreSQL covers producer, persistence and consumer reads. Pure regressions cover malformed/legacy data and partial exits. Component tests cover visible disclosures. Types, guards and relevant builds pass.
8. Same-host baseline/current processing checks report median/p95/p99 with local processing p95 below100ms. These are CPU/service checks, not UI acknowledgement, hardware paint, broker execution latency or competitive speed proof. Keep failed runs.

## Unfinished capability work

Observed-history ingestion with immutable source/context identity; historical symbol/account specifications; explicit fees, spreads, slippage, liquidity, lot sizing, margin and fill constraints; chronological holdouts/walk-forward windows; leakage and experiment-selection controls; verified forward transaction and net-cost reconciliation; matched strategy/symbol/timeframe/mode comparisons; uncertainty and risk-adjusted statistics; scalable large-history runs; real local-interaction and end-to-end completion benchmarks. None is excluded from the owner's scope.

The correction deliberately prevents current diagnostics from supporting higher-automation promotion. It does not establish a validated replacement research engine and must not be described as finishing Profit Mission.

## Local validation

The final correction passed 44 domain/evidence checks, six real disposable-PostgreSQL service checks, 48 mission interface checks, four workspace type-check units and both production builds. The offline guard suite passed 87 guards. The combined development checkout also passed seven additional bridge-syntax assertions from a separate pending change; those assertions are not present in this standalone main-based branch. Independent review caught and resolved incomplete-R coverage labelling; the remaining already-promoted mission-state limitation is recorded above.

On an Apple M4 Pro (14 cores, 24 GiB), Node 24.16.0, macOS 26.6.2, 250 alternating trials of 200 summaries measured baseline median/p95/p99 0.085/0.092/0.233ms and current 0.091/0.107/0.232ms. Current 200-record projections measured 0.520/0.631/0.710ms for generated diagnostics and 0.635/0.748/0.838ms for mixed complete/partial/unknown R coverage. This is a small processing cost for stricter evidence handling, not a speed improvement claim. Background application/OS activity was present. These measurements exclude database, network, browser display and broker latency; they are not competitor comparisons.
