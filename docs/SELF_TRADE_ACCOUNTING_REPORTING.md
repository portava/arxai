# Self-trade accounting coverage and reporting

This read-only correction separates the recorded agent book from unknown outcomes. It does not post money, change capital, resolve an accounting hold, change admission gates, or authorize execution. “RECORDED” is a coverage label for the app's recorded book, not broker verification or a claim that capital can be withdrawn or traded.

## Reproducible baseline and acceptance

The previous supervisor could report `HEALTHY` and zero daily loss for a closed execution with unknown P/L. It also used all-time ledger P/L as today's loss. AACI read the entire fleet and assigned `ledgerHealthy: true`, allowing another owner's funded agents to influence the current user's advisory context. The overview and agent detail showed money without explaining these gaps.

Acceptance was written before implementation in the release receipt: no complete/healthy accounting claim for unknown outcomes, unresolved markers, missing ledgers or missing postings; genuine recorded zero remains readable; current UTC day is explicit; owner isolation; no writes; constant batch query count; actual PostgreSQL and UI regression tests. Local completed overview reads target p95 below 50 ms at 100 agents and 1,000 executions, with less than 10 ms added p95 overhead. Invocation and completion are measured separately. No competitor speed claim follows from a local fixture.

## Accounting contract

- The grouped read observes recorded ledger values, executions and posting coverage in one SQL statement. Posting rows aggregate before joining, so duplicate receipts cannot multiply executions. Existing agent indexes support the batch; there is no query per agent.
- `recordedTrades` counts finite closed outcomes without an unresolved `closeAccounting` property. Any existing property, including null or malformed contents, remains unresolved. Mode changes and ownership transfers do not discard the whole-agent history.
- `unknownTrades` counts other closed outcomes. A known outcome also needs exactly one matching USD `REALIZED_PNL` / `EXECUTION` posting; absent, duplicate or mismatched receipts contribute to `unpostedTrades`. The comparison follows the existing producer's cent rounding. The ledger realized subtotal must reconcile to recorded realized postings; failures contribute to `unreconciledLedgers`. Independent `unmatchedPostings` catches orphan, other-reference, other-agent and non-closed realized postings even when the ledger numerically equals their sum.
- `RECORDED` requires usable ledger values, complete close outcomes, matching postings, reconciled subtotal, no hold, and usable close times. `INCOMPLETE` retains known recorded subtotals with explicit gaps. `UNAVAILABLE` covers missing/invalid ledgers or unusable aggregate amounts. Neither incomplete status substitutes zero for unknown complete P/L.
- `dailyRecordedPnl` is the finite observed execution subtotal from inclusive UTC midnight through the observation time. `dailyLossUsed` is the nonnegative net loss of this period only when accounting is complete; otherwise it is null. Missing, infinite or future close times withhold daily loss. A historical gap also conservatively withholds it until reconciled.
- Fleet totals combine per-agent coverage. `asOf` and `dayStart` state the observation and reporting period. A failed fetch withdraws the current accounting presentation, even if the query cache contains older data. Older server responses without the additive coverage object show an explicit unavailable state.
- The old numeric overview fields remain for compatibility and are labeled as recorded book values in the UI. The additive accounting object carries completeness. Its known subtotal is not a substitute for an unknown total.

## Ownership and authority

AACI reads only the request user's `USER` agents. An explicitly requested operator context additionally includes only operator agents created by that caller with no user owner. An admin role alone does not borrow the entire fleet. Empty fleets and failed reads do not assert healthy accounting. Owner predicates are rechecked in the aggregate query. This remains owner-fleet advisory context, not an assertion about one selected agent or execution authority.

The supervisor's health band describes the recorded book's existing thresholds. Unknown accounting forces `UNKNOWN`. This is advisory reporting; it is not execution permission. Existing entry, funding, withdrawal and posting holds remain unchanged.

## Primary-source comparison

Research checked 26 October 2026. Authoritative contracts are used where equivalent direct product measurements are unavailable.

| Capability | Primary approach | ARX correction and remaining gap |
| --- | --- | --- |
| Account values | [MT5 account properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation) define account balance/equity/profit in the account's deposit currency. | Recorded agent USD book values are labeled separately. This does not provide current broker balance or multi-currency reconciliation. |
| Realized accounting | [MT5 deal properties](https://www.mql5.com/en/docs/constants/tradingconstants/dealproperties) distinguish profit, fees, commission, swap and position identity, including corrections. | Missing outcomes and unmatched postings remain incomplete. Broker deal completeness, corrections and all costs remain unverified; a matching app posting does not supply them. |
| Reporting period | [MT5 HistorySelect](https://www.mql5.com/en/docs/trading/historyselect) selects history over an explicit server-time interval. | ARX reports an explicit UTC interval and rejects unusable dates. It does not equate UTC with a broker's trading-day timezone. |
| Performance evidence | [TradingView strategy concepts](https://www.tradingview.com/pine-script-docs/concepts/strategies/) describe simulated trades and cost assumptions. | Recorded execution/ledger coverage is separate from simulation and broker verification. No strategy-profit, product-parity or broker-latency conclusion is asserted. |

## Validation and limits

The disposable PostgreSQL lane runs the actual service, supervisor, AACI and grouped query against local temporary tables with external requests rejected. Fixtures cover real zero, null/nonfinite P/L, all unresolved marker forms, period boundaries, wrong/missing postings, ownership, failed queries, ledger immutability and constant query count. UI tests render the actual overview and agent detail, including old responses and failed refreshes.

Final counts and measured median/p95/p99 are recorded in the accompanying release receipt. At 100 owned agents and 1,000 closes, 500 alternating samples after 50 warmups measured completed-read median/p95/p99 of 1.251/1.491/2.296 ms before and 6.580/6.996/7.594 ms after. The added p95 cost was 5.505 ms, within the predeclared 10 ms overhead and 50 ms total limits. This is a correctness cost, not a speedup. Invocation-only p95 was 0.036/0.034 ms before/after. Current pure coverage projection p95 was 0.175 ms; the previous four scalar sums took 0.004 ms. The two projections produce different information. The optional benchmark preserves the previous service and supervisor as release artifacts and alternates before/after reads against the same database. Its invocation metric only measures Promise creation; completed-read timing includes the database and projection. Pure projection timing compares the previous scalar rollup with the extra coverage work.

Remaining work includes genuine broker history/cost reconciliation, account-currency evidence, historical corrections, scalable validation beyond the documented local fixture, and freshness evidence for open P/L. This change does not silently resolve these gaps or modify existing balances. It does not certify the application as deployed or competitively complete.
