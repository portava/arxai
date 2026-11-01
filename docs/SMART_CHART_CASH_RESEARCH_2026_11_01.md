# Smart Chart cash-funded historical scenarios — 1 November 2026

Application `76cd4bd634e6b5af5188c5bb0d823b95e7aeb44e` on `codex/chart-research-capital-20261101`, based on `474a341638bb87977cffffd852b3bf8c350fb2c4`. Development only. Release and architecture remain incomplete; this work does not establish TradingView/MT5 parity or actual returns.

## Existing system extended

The existing Scanner **Test an idea** workbench, causal EMA/ATR engine, background Worker, source binding, ledger and selected-pane assistant now support an optional, explicitly hypothetical cash-funded long-only scenario. No parallel simulator, account authority, model gateway or execution path was added.

Manual controls specify starting capital, fixed quantity, point value and an accounting-unit label. A supported natural request can end with “with starting capital 10000 scenario units, quantity 1000 and point value 1.” Both routes finalize the same configuration; preparing a draft does not calculate or trade. Unsupported financing or incomplete assumptions are refused. The default manual cash inputs are disclosed as hypothetical, not inferred from a symbol or account.

The next actual opening fill plus entry fee must fit settled cash. An unaffordable signal gets no fill, fee or delayed retry. Closing proceeds become available for subsequent signals. Tests cover a first loss preventing a second purchase and a first gain funding a larger debit than the initial budget. Spread and slippage already belong to fills; the cost decomposition is not charged again. Negative balances caused by exit fees are retained and disclosed. Unrepresentable floating-point movements or scaling are refused.

Each development/validation/holdout partition starts with separate capital. Cash equity includes hypothetical liquidation costs at observed closes; open positions remain unresolved. A same-quantity buy-and-hold benchmark attempts the first partition open with identical cost assumptions; if unaffordable it stays flat cash without resizing or a later substitute. Annualization requires positive final equity and at least 365.25 elapsed days. Drawdown uses the cash-equity peak, not zero-origin P&L.

The existing ledger still uses price units per unit. A separate cash panel displays the explicit scenario’s equity, completed costs/net, drawdown, returns and benchmark. The equity graphic preserves observed endpoints/extrema and maximum absolute/percentage drawdown turns when reducing long curves; other turns may be omitted, and connecting lines are not observed intrabar prices. Range labels remain readable outside the scaled graphic on narrow screens. Dates, units, unresolved outcomes and sample limits remain visible.

“Compare this with buy-and-hold” reads only the current frozen, source-bound result. It repeats its fingerprint and figures without another calculation, model call or order. Editing settings clears the old result. A source/ledger mismatch withholds cash figures and benchmark explanations.

## Independent checks and corrections

A separate verifier reconstructs funding, fills, costs, source-bar exit priority, refused entries, settled cash, marks, benchmark and aggregate figures. It rejects altered evidence. This is **not** a second independent strategy implementation: EMA/ATR signal selection still trusts engine output. Source binding does not authenticate a real provider. Coordinated omitted/fabricated signals are outside this accounting verifier’s coverage.

Independent review corrected misplaced V2 disclosure, swallowed small cash movements at huge balances, subnormal scaling loss, missing maximum-drawdown turns in reduced plots, and missing readable units/time endpoints. Review also corrected an overstatement about independent signal verification.

The first actual Scanner browser run on `45544e99` revealed a valid small-cost result being withheld. Redundant gross-minus-cost decomposition differed from direct fill arithmetic by `1.8897643866422342e-16`; its tolerance incorrectly used the much smaller P&L instead of the source/fill operands. `01777265` changes only that redundant comparison’s arithmetic tolerance; direct price, cost, net and cash checks remain strict. The exact 192-bar case fails before and passes after; altered fee/net values remain rejected. `76cd4bd6` fixes tiny graph range labels found during phone-width visual inspection.

A later browser assertion incorrectly assumed Scanner made no POST attempts at all. Existing `/api/me/chart/ai-alerts/scan`, `/api/me/scalp/focus` and `/api/me/activity-ping` attempts were all intercepted with 503; none reached a server. The corrected assertion permits only these named, blocked background attempts and rejects other submissions. Failed runs, original assertions, logs and before/after imagery are retained. No blocked request was allowed through to obtain a pass.

## Exact validation

| Evidence | Commit | Result |
| --- | --- | --- |
| Full dashboard suite | `76cd4bd6` | 3,510 pass; 11 skipped; 0 fail (214 files pass, 1 skipped) |
| Dashboard typecheck and ordinary build | `76cd4bd6` | Pass; existing large-chunk warning retained |
| Actual Scanner,1440px and390px | `76cd4bd6`, fixture `e7b2b265cb5d18bb` | 31/31 each; clean identical build source before/after; screenshots inspected |
| All guards | `76cd4bd6` |85/87; unchanged 38 wording matches and 3 JSON-display matches require contextual review, not 41 proven defects |
| Existing V1/V2 research Node suites | `01777265` |78/78; no skips |
| API typecheck | `01777265` |Pass |
| Complete no-cash result/hash comparison against `474a3416` | `01777265` |12/12 exact equality across BID/MID, three directions and zero/nonzero fees |
| Focused cash-verifier regression | Working source included in `01777265` |Before 1 fail / 42 pass; after 43 pass; dashboard typecheck pass |

The domain tree (`3aeea4ff88dbd8b2ba34502e18b980fd6ed7adca`) and API tree (`c9ac8ee00449ed10ee5c1ec0528dcece6b93efd5`) are identical at `01777265` and `76cd4bd6`; the latter changes only displayed graph labels. The full backend/server, root-CI, broker and real-provider lanes were not run for this change.

Browser checks exercise real Scanner components and the actual WebCrypto Worker with generated, intercepted history. They verify manual/natural-language equivalence, all partition outputs, frozen benchmark replies, invalidation, nonzero costs, unaffordable entries, unsupported directions, range readability and overflow. They do not prove physical-device touch, hardware paint, first-click latency, production feeds or broker execution. Repeated runs capture different observation times, so equivalence compares configuration and complete partitions, not the entire timestamped snapshot hash.

## Competitive and remaining scope

TradingView documents initial capital, order sizing, costs, margin and broker-emulator assumptions in [strategy properties](https://www.tradingview.com/support/solutions/43000628599-strategy-properties/) and [strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/). MT5 documents a historical strategy tester, optimization and multi-currency testing in [Strategy Testing](https://www.metatrader5.com/en/terminal/help/algotrading/testing). This change closes a bounded cash-scenario gap; it does not match those entire systems.

Remaining gaps include actual contract/currency metadata, FX/CFD/futures financing and margin, short financing, risk-percent sizing, dividends/interest/corporate adjustments, multi-currency portfolios, tick-level execution, parameter optimization and audited experiment history. Other chart/control/AI, real-provider, funds/execution and measured-performance requirements remain open. The separate prior chart-versus-Truth agent audit and sanitized ChatGPT cross-check are recorded in `SMART_CHART_SIMPLIFY_RESTORE_2026_11_01.md`; ChatGPT did not independently validate this new cash feature.

No main merge, deployment/publication, running-app restart or bundle replacement, existing-database mutation, worker/email/settlement enablement, broker test or order occurred. Replit was not updated. Its previous watched-source import did not establish frontend runtime preservation; future backups must use a separate unserved archive/worktree before any runtime-affecting step. Held performance branches remain excluded. AI-generated entries retain the existing approved-policy gate.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-research-capital-20261101/`. The repository validation folder includes a compressed raw archive, file hashes, browser checks, exact fixture metadata and summary. The legacy comparison script records the two worktrees used at the time; reproducing it after the integration branch advances requires restoring the baseline worktree to `474a3416`, not comparing two newer trees.
