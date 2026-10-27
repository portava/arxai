# Self-trading competitive scorecard — 27 October 2026

Research slice on branch `claude/self-trading-research`, cut from `5767ec5`. Documentation only: no code, schema, environment or broker changes.

This scorecard compares ARX self-trading (automated agent trading) against MetaTrader 5 Expert Advisors and Strategy Tester, TradingView strategies and alerts, QuantConnect LEAN, NinjaTrader, cTrader Automate, the Interactive Brokers TWS API and Freqtrade. It covers the owner brief's self-trading dimensions (execution quality, position sizing, risk controls, duplicate prevention, reconciliation, recovery, emergency stops), plus paper/simulation, audit trail and operator controls. Each row is also tagged with one of the brief's scorecard dimensions (features, speed, accuracy, usability, reliability, scalability, integration, operating efficiency).

**There is no aggregate or percentage score.** Matching or beating competitors means meeting every row's acceptance criterion, not a good average. The machine-readable sibling is [`SELF_TRADING_COMPETITIVE_SCORECARD_2026_10_27.json`](SELF_TRADING_COMPETITIVE_SCORECARD_2026_10_27.json); both files are generated from the same row list.

## Evidence rules

- **Competitor facts** come only from the cited official documentation. Where a page could not be retrieved, or only partly, the fact is marked unverified or left out. No competitor performance figure was measured.
- **ARX facts** cite repository files at the base commit. *Offline-tested* means repository tests with fixtures, disposable PostgreSQL or the extracted-MQL C++ harness. *Broker-verified* means observed on a real MT5 demo or live account. **No self-trading row is broker-verified.** The repository records one controlled manual LIVE micro-test on a non-agent path (`artifacts/api-server/src/scripts/liveMicroTestFinalize.ts`); it was not re-verified here and does not cover agents.
- The 2026-06-19 safety audit is historical. Where this scorecard cites its gaps (G1, G2, G3, G5), current source was checked and the gap is still open.
- Status values:
  - **ahead**: ARX's documented and offline-tested behaviour exceeds what the cited competitor documentation describes; not broker-verified.
  - **parity-claimed-unverified**: ARX implements a comparable control, but evidence is offline only or the comparison is not measured.
  - **behind**: Competitors document a capability that ARX lacks or implements only partially.
  - **not measured**: No measurement exists on ARX and/or no comparable competitor figure was found.

## Summary

42 rows: 2 ahead, 15 parity-claimed-unverified, 19 behind, 6 not measured.

| ID | Dimension | Scorecard dimension | Capability | Status |
|---|---|---|---|---|
| EXQ-1 | execution quality | accuracy | Pre-submission broker check of margin and request validity | **behind** |
| EXQ-2 | execution quality | accuracy | Maximum slippage (price deviation) cap on market orders | **parity-claimed-unverified** |
| EXQ-3 | execution quality | accuracy | Spread re-check between decision and dispatch | **behind** |
| EXQ-4 | execution quality | accuracy | Truthful fill result: executed volume, price, deal ID and partial fills | **behind** |
| EXQ-5 | execution quality | accuracy | Execution-quality measurement (slippage, latency, live vs simulation) | **not measured** |
| EXQ-6 | execution quality | reliability | Asynchronous broker events processed without ordering assumptions | **parity-claimed-unverified** |
| SIZE-1 | position sizing | accuracy | Risk-based lot sizing from stop distance, contract size and account-currency conversion | **parity-claimed-unverified** |
| SIZE-2 | position sizing | accuracy | Margin- and notional-aware capacity | **behind** |
| SIZE-3 | position sizing | accuracy | Volume normalisation to broker min/max/step | **parity-claimed-unverified** |
| RISK-1 | risk controls | reliability | Daily loss limit with automatic flatten | **behind** |
| RISK-2 | risk controls | reliability | Agent weekly / rolling drawdown cap | **behind** |
| RISK-3 | risk controls | reliability | Loss-streak, cooldown and per-instrument locks | **behind** |
| RISK-4 | risk controls | reliability | Mandatory protective stop held at the broker | **parity-claimed-unverified** |
| RISK-5 | risk controls | reliability | Order size and value limits (fat-finger protection) | **parity-claimed-unverified** |
| RISK-6 | risk controls | reliability | Event/news risk re-check at dispatch | **not measured** |
| RISK-7 | risk controls | scalability | Concurrent-position and in-flight capacity limits | **parity-claimed-unverified** |
| DUP-1 | duplicate prevention | reliability | Server-side idempotent order intent and management claims | **ahead** |
| DUP-2 | duplicate prevention | reliability | Terminal-side deduplication across EA restart | **behind** |
| DUP-3 | duplicate prevention | integration | Ownership tagging of automated orders | **parity-claimed-unverified** |
| REC-1 | reconciliation | reliability | Strategy/account position synchronisation at start-up | **behind** |
| REC-2 | reconciliation | reliability | Broker-vs-app mismatch handling | **parity-claimed-unverified** |
| REC-3 | reconciliation | accuracy | Realised P/L reconciled to broker deals and costs | **behind** |
| REC-4 | reconciliation | accuracy | Live-vs-simulation reconciliation | **behind** |
| RCV-1 | recovery | reliability | Crash recovery of in-flight work | **parity-claimed-unverified** |
| RCV-2 | recovery | reliability | Durable terminal result delivery | **behind** |
| RCV-3 | recovery | reliability | Connection-loss behaviour | **parity-claimed-unverified** |
| RCV-4 | recovery | reliability | Account / server switch protection | **behind** |
| STOP-1 | emergency stops | reliability | Global automated-trading kill switch | **parity-claimed-unverified** |
| STOP-2 | emergency stops | usability | Pause new entries while still managing exits | **ahead** |
| STOP-3 | emergency stops | speed | Flatten all / liquidate | **not measured** |
| STOP-4 | emergency stops | features | Scoped stops (agent, strategy, symbol, news) | **parity-claimed-unverified** |
| SIM-1 | paper/simulation | features | Paper / dry-run forward test of automated agents | **behind** |
| SIM-2 | paper/simulation | accuracy | Historical replay with realistic ticks, spread and delay | **behind** |
| AUD-1 | audit trail | reliability | Decision and execution audit trail | **parity-claimed-unverified** |
| OPS-1 | operator controls | usability | Mode control and LIVE escalation consent | **parity-claimed-unverified** |
| OPS-2 | operator controls | operating efficiency | Risk-event alerting and operational SLOs | **behind** |
| OPS-3 | operator controls | scalability | Unattended 24/7 operation | **behind** |
| SPEED-1 | execution quality | speed | Decision-to-broker latency | **not measured** |
| SCALE-1 | risk controls | scalability | Agents and commands per account/install | **not measured** |
| INTEG-1 | execution quality | integration | Venue / broker coverage | **behind** |
| USAB-1 | operator controls | usability | Strategy authoring and transparency for users | **behind** |
| EFF-1 | reconciliation | operating efficiency | Reconciliation cost per cycle | **not measured** |

## Rows

### Execution quality

#### EXQ-1 — Pre-submission broker check of margin and request validity

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: OrderCheck() validates a request and returns projected balance, equity, margin, free margin and margin level plus a return code before OrderSend(); a true result is not a promise of execution. [M1](https://www.mql5.com/en/docs/trading/ordersend) [M2](https://www.mql5.com/en/docs/trading/ordercheck)
- *Interactive Brokers*: TWS order precautions warn/confirm before transmission; API users can bypass them individually (bypassOrderPrecautions etc.). [I1](https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/order-precautions) [I2](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-precautions-config.md)

**ARX today** (offline-tested (server guard); EA preflight compiled only in C++ harness; broker-unverified): Server-side broker symbol guard (min/max volume, volume step, freeze distance, SL/TP proximity) runs in the live pipeline preflight; the EA runs its own RunPreflight before CTrade. No OrderCheck() call exists in any EA, so projected margin/free margin is never checked at the terminal.

Evidence: `lib/domain/src/safety-contracts/preTradeBrokerGuard.ts`; `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md (Layer 3)`; `mt5-bridge/ARX_AI_Universal_Agent_v154.mq5 (RunPreflight, line ~680)`; grep: no OrderCheck( in mt5-bridge/

**Acceptance criterion to match or beat:** Every automated entry runs OrderCheck() (or equivalent margin projection) immediately before submission; a failing check refuses with the broker retcode recorded; extracted-handler tests cover insufficient margin, invalid volume, invalid stops and auto-trading disabled (10027).

#### EXQ-2 — Maximum slippage (price deviation) cap on market orders

*Scorecard dimension:* accuracy · *Status:* **parity-claimed-unverified**

**Competitors**

- *MetaTrader 5*: MqlTradeRequest.deviation sets the maximum deviation in points; it is a required field only for Request and Instant execution modes, not Market/Exchange execution. [M3](https://www.mql5.com/en/docs/constants/structures/mqltraderequest)
- *cTrader*: Market orders are sent with optional parameters via ExecuteMarketOrder; the trading-operations page does not name a slippage parameter (market-range semantics unverified). [C3](https://help.ctrader.com/ctrader-algo/how-tos/cbots/cbot-trading-operations/)

**ARX today** (source review only; broker-unverified): v131 live poll applies SetDeviationInPoints with a compile-time ceiling of 20 points that the server can only tighten; v154 uses an input MaxSlippagePoints (default 30). Because deviation is ignored on market-execution symbols, ARX has no post-fill slippage check.

Evidence: `mt5-bridge/ReplitMT5BridgeEA_v131.mq5 (ARX_MAX_DEVIATION_POINTS 20, lines 138-150, 1560)`; `mt5-bridge/ARX_AI_Universal_Agent_v154.mq5 (MaxSlippagePoints line 83)`

**Acceptance criterion to match or beat:** (a) Deviation cap applied on every automated entry; (b) for market-execution symbols, measured |fill price - requested price| is recorded per fill and fills beyond the cap raise an execution-quality event; (c) demo-broker test shows both behaviours.

*Note:* Parity only for request/instant execution symbols; market-execution coverage is missing.

#### EXQ-3 — Spread re-check between decision and dispatch

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *Interactive Brokers*: Precautions flag limit orders too far from the market by percentage or number of ticks. [I5](https://interactivebrokers.co.uk/en/software/tws.bak/usersguidebook/configuretws/define_precautionary_settings.htm)
- *cTrader*: Backtests can use fixed, live-symbol or random spread, so spread sensitivity can be evaluated before deployment. [C6](https://help.ctrader.com/ctrader-algo/how-tos/cbots/backtest-a-cbot/)

**ARX today** (source review): Decision engine still passes maxSpreadPoints: null; the agent executor has no spread check (audit gap G1 remains open). The EA deviation cap is the only backstop.

Evidence: `artifacts/api-server/src/lib/selfTrade/decisionEngine.ts:258`; `artifacts/api-server/src/lib/selfTrade/agentExecutor.ts (no spread reference)`; `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §10 G1`

**Acceptance criterion to match or beat:** Executor refuses with SPREAD_TOO_WIDE when observed live spread (with source and timestamp) exceeds the agent limit, and refuses when spread is unobservable; tests cover wide, stale and missing quotes.

#### EXQ-4 — Truthful fill result: executed volume, price, deal ID and partial fills

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: MqlTradeResult carries retcode, deal, order, broker-confirmed volume and price, request_id and retcode_external; retcode 10009 is DONE and 10010 DONE_PARTIAL. [M4](https://www.mql5.com/en/docs/constants/structures/mqltraderesult) [M5](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes)
- *QuantConnect LEAN*: Order tickets update automatically; PARTIALLY_FILLED is a distinct status and an order is closed only when filled, canceled or invalid. [Q3](https://quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/order-management/order-tickets)
- *cTrader*: TradeResult exposes IsSuccessful, Error, Position and PendingOrder. [C1](https://help.ctrader.com/ctrader-algo/references/Trading/TradeResult/)

**ARX today** (server rules offline-tested; terminal behaviour source-reviewed; broker-unverified): Server lifecycle refuses to treat partial or unknown outcomes as full fills. Terminal side is weaker: v131 reports LIVE_FILLED from the CTrade boolean and sends the requested lot as executedVolume for entries; v154 maps every non-10009 retcode, including 10010 DONE_PARTIAL, to REJECTED and its result payload omits ResultVolume/ResultPrice (deal ID only inside a text comment).

Evidence: `mt5-bridge/ReplitMT5BridgeEA_v131.mq5:759-773,825`; `mt5-bridge/ARX_AI_Universal_Agent_v154.mq5:825-838,1393-1425`; `docs/SELF_TRADING_RELIABILITY_2026_10_26.md (evidence model)`; `docs/SELF_TRADE_TERMINAL_TARGET_PREFLIGHT.md (remaining gaps)`

**In progress elsewhere (not on this branch):** branch `codex/terminal-result-evidence` adds versioned result evidence to v154 and v131 (10010 → LIVE_PARTIALLY_FILLED, 10008 → ACK, executed volume/price from the CTrade result, boolean success without deal/volume/price → LIVE_UNKNOWN). It is not yet integrated into PR 99 and has no ACK/PARTIAL aging path, so this row stays **behind** until it lands and is validated.

**Acceptance criterion to match or beat:** EA maps 10009/10010/10008/other retcodes to FILLED/PARTIAL/PLACED/REJECTED-or-UNKNOWN; results carry ResultVolume, ResultPrice, ResultDeal, position identifier and request time; server never records executed volume it did not receive; extracted-handler test matrix covers every retcode in the MQL5 table; demo test reproduces a partial or rejected fill.

*Note:* Highest-risk finding: a partial fill reported as REJECTED can leave real exposure that ARX believes does not exist.

#### EXQ-5 — Execution-quality measurement (slippage, latency, live vs simulation)

*Scorecard dimension:* accuracy · *Status:* **not measured**

**Competitors**

- *QuantConnect LEAN*: Runs an out-of-sample backtest in parallel with each live deployment and overlays live and backtest equity and fills. [Q4](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation)
- *MetaTrader 5*: Tester can model zero, fixed or random execution delay (0-8 s 90% of the time, 9-18 s otherwise). [M8](https://metatrader5.com/en/terminal/help/algotrading/testing)

**ARX today** (source review): No per-fill slippage or latency record exists for self-trade executions. missionExecutionQuality is a block/downgrade pre-check for Profit Mission and is not imported by the self-trade executor.

Evidence: `artifacts/api-server/src/lib/missionExecutionQuality.ts (header)`; grep: imported only by missionAgents.ts; `artifacts/api-server/src/lib/selfTrade/agentReconciliation.ts (fill prices only)`

**Acceptance criterion to match or beat:** Per automated fill: requested price, fill price, signed slippage in points and account currency, decision→claim→pickup→broker-result timestamps; median/p95/p99 reported per symbol and broker; dashboard and weekly report; live-vs-simulation divergence computed for each agent.

#### EXQ-6 — Asynchronous broker events processed without ordering assumptions

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *MetaTrader 5*: OnTradeTransaction arrival order is not guaranteed and the queue holds 1024 elements; one request can produce several transactions. [M6](https://www.mql5.com/en/docs/event_handlers/ontradetransaction)
- *cTrader*: ExecuteMarketOrderAsync returns a TradeOperation with IsExecuting and an optional completion callback. [C4](https://help.ctrader.com/ctrader-algo/how-tos/cbots/parallel-order-execution/)

**ARX today** (offline-tested (PostgreSQL fixtures); broker-unverified): Settlement treats receipt sequence as server observation order, not broker order; identical retries are idempotent and contradictions are retained as evidence. The EA does not use OnTradeTransaction for automated results.

Evidence: `docs/RESULT_SETTLEMENT_OUTBOX.md`; `docs/SELF_TRADE_TERMINAL_TARGET_PREFLIGHT.md`

**Acceptance criterion to match or beat:** Fault tests deliver duplicated, reordered and dropped result events and show no double application, no lost exposure and HELD state for contradictions; demo test confirms with real terminal events.

### Position sizing

#### SIZE-1 — Risk-based lot sizing from stop distance, contract size and account-currency conversion

*Scorecard dimension:* accuracy · *Status:* **parity-claimed-unverified**

**Competitors**

- *Freqtrade*: stake_amount per trade (fixed or 'unlimited') and tradable_balance_ratio (default 0.99) cap the capital used. [F3](https://www.freqtrade.io/en/stable/configuration/)
- *NinjaTrader*: ATM strategies size stop and target orders to the position and resize them when the position is added to. [N1](https://static.ninjatrader.com/support/helpGuides/nt8/atm_strategy.htm)
- *QuantConnect LEAN*: Risk models receive and adjust PortfolioTarget objects from portfolio construction, chained in order. [Q2](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/risk-management/key-concepts)

**ARX today** (offline-tested; broker-unverified): computeRiskAwareLot divides an account-currency risk budget by stop distance × contract size × quote→account FX, rounds down to lot step, and refuses with NO_CONTRACT_SPEC or NO_QUOTE_FX rather than guessing. AACI may reduce size; quota regimes apply multipliers.

Evidence: `artifacts/api-server/src/lib/selfTrade/agentExecutor.ts:100-140,311-320`; `lib/domain/src/self-trade/riskAwareLotSizer.ts:99`; `artifacts/api-server/src/lib/selfTrade/__qa__/entrySizerQuoteFx.test.ts`

**Acceptance criterion to match or beat:** For each supported symbol class, sized lot × stop distance × value-per-lot equals the risk budget within one lot step (never above); verified against broker contract specs on a demo account for at least FX majors, JPY crosses, metals and indices.

*Note:* Design refuses unknown contract specs, which the cited competitor docs do not describe; superiority is not claimed without broker verification.

#### SIZE-2 — Margin- and notional-aware capacity

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: OrderCheck returns projected margin, free margin and margin level. [M2](https://www.mql5.com/en/docs/trading/ordercheck)
- *Interactive Brokers*: Total Value Limit and Algorithm Total Value Limit (default 10× the manual limit, per archived guide) gate order notional. [I5](https://interactivebrokers.co.uk/en/software/tws.bak/usersguidebook/configuretws/define_precautionary_settings.htm) [I6](https://ibkrcampus.com/campus/trading-lessons/configuring-tws-presets/)

**ARX today** (offline-tested (governor); agent-level margin absent): Agent admission reserves position count and daily attempt headroom, not cash margin or portfolio VaR. The shared Risk Governor applies leverage ceilings (gross notional/equity 30, single symbol 15).

Evidence: `docs/SELF_TRADING_ENTRY_CAPACITY_2026_10_26.md (still unresolved)`; `artifacts/api-server/src/lib/riskGovernor/preTrade.ts:82-83`

**Acceptance criterion to match or beat:** Agent admission includes pending + open margin from broker-reported margin requirements; refusals when projected free margin < configured floor; test with concurrent agents sharing one account.

#### SIZE-3 — Volume normalisation to broker min/max/step

*Scorecard dimension:* accuracy · *Status:* **parity-claimed-unverified**

**Competitors**

- *MetaTrader 5*: TRADE_RETCODE_LIMIT_VOLUME (10034) and invalid-volume refusals come from the trade server. [M5](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes)

**ARX today** (offline-tested; broker-unverified): Sizer rounds down to lot step; pre-trade broker guard refuses VOLUME_OFF_STEP and out-of-range volumes; EA preflight rechecks.

Evidence: `lib/domain/src/self-trade/riskAwareLotSizer.ts:99`; `lib/domain/src/safety-contracts/preTradeBrokerGuard.ts:30`

**Acceptance criterion to match or beat:** Zero broker volume rejections across a demo run covering every enabled symbol; any 10014/10034 rejection is recorded with symbol specs.

### Risk controls

#### RISK-1 — Daily loss limit with automatic flatten

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *NinjaTrader*: Account Daily Loss Limit (NinjaTrader Brokerage accounts): on breach working orders are cancelled, positions liquidated and later orders rejected for the session; staff state no mobile/email notification is sent. [N5](https://forum.ninjatrader.com/forum/ninjatrader-8/platform-technical-support-aa/1238947-question-about-the-daily-loss-limit-in-account-risk-settings?p=1239084)
- *NinjaTrader partner (prop-firm)*: dailyLossAutoLiq / dailyLossPercentageAutoLiq trigger liquidation, unlock at next open; alert and liquidate-only thresholds below. [N6](https://partner.ninjatrader.com/overview/prop-firm-management/post-trade-risk)
- *Freqtrade*: MaxDrawdown protection locks trading for a duration after drawdown over a lookback exceeds max_allowed_drawdown; equity mode recommended. [F1](https://www.freqtrade.io/en/stable/plugins/)
- *QuantConnect LEAN*: A Maximum Portfolio Drawdown risk model exists (parameters not retrievable in this research). [Q1](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/risk-management/supported-models)

**ARX today** (offline-tested; broker-unverified): Phase B gate DAILY_LOSS_LIMIT_REACHED blocks new dispatch at the user-level realised daily cap; the agent gate tracks agent daily P/L; accounting withholds daily loss when outcomes are unknown. A breach blocks entries but does not liquidate open positions.

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §5 Layer 4 gate 15`; `docs/SELF_TRADE_ACCOUNTING_REPORTING.md`; `artifacts/api-server/src/lib/live/emergencyClose.ts (manual only)`

**Acceptance criterion to match or beat:** (a) Breach detected from realised + floating P/L including costs within one evaluation cycle; (b) owner-configurable action: block entries, or block and flatten via the gated emergency-close path; (c) measured time from breach to all positions confirmed closed on demo, p95 reported; (d) operator notification on breach.

*Note:* Entry blocking reaches parity in design; auto-flatten and floating-P/L inclusion are absent.

#### RISK-2 — Agent weekly / rolling drawdown cap

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *NinjaTrader partner (prop-firm)*: Weekly loss auto-liquidation locks the account until the Sunday open; trailing max drawdown in EOD or real-time mode. [N6](https://partner.ninjatrader.com/overview/prop-firm-management/post-trade-risk)
- *Freqtrade*: MaxDrawdown evaluates any lookback window (lookback_period or candles). [F1](https://www.freqtrade.io/en/stable/plugins/)

**ARX today** (source review): maxWeeklyLossUsd is stored in agent settings and profiles but is not evaluated by the execution gate or permission evaluator (audit gap G5 still open).

Evidence: `artifacts/api-server/src/lib/selfTrade/profiles.ts:22,50-138`; `artifacts/api-server/src/lib/selfTrade/service.ts:94,131`; grep: no weekly reference in executionGate.ts / executionPermission.ts

**Acceptance criterion to match or beat:** WEEKLY_LOSS_CAP_REACHED refuses entries when the rolling 7-day realised (and optionally floating) agent loss reaches the cap; unknown accounting refuses; PostgreSQL tests at UTC boundaries.

#### RISK-3 — Loss-streak, cooldown and per-instrument locks

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *Freqtrade*: StoplossGuard (N stoplosses in lookback → lock, global or per pair), CooldownPeriod (per-pair re-entry lock), LowProfitPairs; supported in backtesting with --enable-protections; /locks and /unlock. [F1](https://www.freqtrade.io/en/stable/plugins/) [F4](https://www.freqtrade.io/en/stable/telegram-usage/)

**ARX today** (offline-tested (regimes)): Quota engine moves agents into RECOVERY/PROTECT regimes that reduce size near loss caps; SYMBOL- and STRATEGY-scoped kill switches exist. No automatic time-boxed per-symbol cooldown lock after a stop-out was found in the reviewed files.

Evidence: `artifacts/api-server/src/lib/selfTrade/agentQuotaEngine.ts`; `artifacts/api-server/src/lib/selfTrade/killSwitchGate.ts:34`

**Acceptance criterion to match or beat:** Configurable automatic lock after N losing exits per agent/symbol within a lookback, with audited expiry; included in the agent replay harness so its effect is measured out of sample.

#### RISK-4 — Mandatory protective stop held at the broker

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *Freqtrade*: stoploss_on_exchange places the stop on the exchange after entry fills; on placement failure emergency_exit (default market) exits; re-creates a manually cancelled stop every stoploss_on_exchange_interval (default 60 s). [F2](https://www.freqtrade.io/en/stable/stoploss/)
- *NinjaTrader*: ATM strategies submit stop and target automatically; server-side ATMs attach them on partial or full fill and cancel the sibling when one fills. [N1](https://static.ninjatrader.com/support/helpGuides/nt8/atm_strategy.htm) [N2](https://static.ninjatrader.com/support/helpGuides/nt8/server-side-vs-local-atms.htm) [N3](https://static.ninjatrader.com/support/helpGuides/nt8/server-side-atm-strategy.htm)
- *cTrader*: ProtectionType Relative/Absolute SL/TP on orders and positions. [C2](https://help.ctrader.com/ctrader-algo/references/Trading/ProtectionType)

**ARX today** (offline-tested; broker-unverified): No thesis or no stop → refusal (NO_THESIS, NO_PROTECTIVE_STOP); Phase B MISSING_STOP_LOSS (admin override exists); SL/TP are sent on the entry request itself; stop changes are recorded only after a settled MODIFY and a matching or stronger observed broker stop.

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §5`; `docs/SELF_TRADING_RELIABILITY_2026_10_26.md (defect 3)`; `mt5-bridge/ARX_AI_Universal_Agent_v154.mq5:820-822`

**Acceptance criterion to match or beat:** On demo: 100% of automated entries show a broker-side SL in the position snapshot within one poll; a missing or removed SL is detected and either restored or the position closed within a configured time; admin override use is audited and counted.

*Note:* No detection/restoration loop for an SL removed after entry was found.

#### RISK-5 — Order size and value limits (fat-finger protection)

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *Interactive Brokers*: Size Limit, Total Value Limit, Percentage / Number of Ticks away from market, separate algorithm size/value limits; error 383 for size-constraint violations. [I4](https://www.interactivebrokers.com/docs/tws-api/doc/error-handling/error-codes) [I5](https://interactivebrokers.co.uk/en/software/tws.bak/usersguidebook/configuretws/define_precautionary_settings.htm) [I6](https://ibkrcampus.com/campus/trading-lessons/configuring-tws-presets/)

**ARX today** (offline-tested; broker-unverified): Per-symbol max live lot (Phase B), platform lot ceiling, arming confirmed max lot ≤ 1.0, governor leverage caps, and an anomaly screen that blocks lots far above baseline with fail-safe BLOCK.

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §5 (gate 14, Layer 0 anomaly)`; `docs/TIER1_RISK_GOVERNOR_SOURCE.md`; `artifacts/api-server/src/lib/riskGovernor/preTrade.ts:82-83`

**Acceptance criterion to match or beat:** Table-driven tests show refusal at limit+1 step for lot, notional and leverage on every automated path (entry, modify, close-by-reverse); audit row names the limit in force.

#### RISK-6 — Event/news risk re-check at dispatch

*Scorecard dimension:* reliability · *Status:* **not measured**

**Competitors**

- *(none found)*: None of the researched official docs describe a built-in economic-calendar gate for automated orders.

**ARX today** (source review): News risk is captured at decision time from a hard-coded schedule; it is not re-evaluated before dispatch and there is no live calendar provider (audit gaps G2, G3 still open).

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §10 G2/G3`; `artifacts/api-server/src/lib/selfTrade/agentExecutor.ts (no news reference)`

**Acceptance criterion to match or beat:** Executor re-reads news risk immediately before draft and refuses on escalation; provider-unavailable state is surfaced; tests for event starting between decision and dispatch.

*Note:* No competitor baseline; kept because the audit rates it a promotion blocker.

#### RISK-7 — Concurrent-position and in-flight capacity limits

*Scorecard dimension:* scalability · *Status:* **parity-claimed-unverified**

**Competitors**

- *Freqtrade*: max_open_trades; only one open trade per pair. [F3](https://www.freqtrade.io/en/stable/configuration/)

**ARX today** (offline-tested (24-way PostgreSQL contention); broker-unverified): Checking and reserving capacity happen in one PostgreSQL transaction under the agent lock; pending, dispatched and filled-unclosed entries count; elapsed time never releases capacity.

Evidence: `docs/SELF_TRADING_ENTRY_CAPACITY_2026_10_26.md`; `artifacts/api-server/src/lib/selfTrade/entryReservation.ts`; `artifacts/api-server/src/lib/selfTrade/__qa__/entryReservation.postgres.test.ts`

**Acceptance criterion to match or beat:** Under N concurrent cycles (N ≥ 24) no agent exceeds its concurrent or daily cap, including after process restart and UTC rollover; repeated in a deployed staging environment.

*Note:* Competitor concurrency semantics are not documented, so no 'ahead' claim.

### Duplicate prevention

#### DUP-1 — Server-side idempotent order intent and management claims

*Scorecard dimension:* reliability · *Status:* **ahead**

**Competitors**

- *Interactive Brokers*: Order IDs must increase per client; a reused or lower ID is rejected with error 103 'Duplicate order ID'. [I4](https://www.interactivebrokers.com/docs/tws-api/doc/error-handling/error-codes)
- *MetaTrader 5*: request_id assigned by the terminal links a call to its result, mainly for OrderSendAsync. [M4](https://www.mql5.com/en/docs/constants/structures/mqltraderesult)

**ARX today** (offline-tested (8-way and 24-way PostgreSQL contention); broker-unverified): Partial-unique idempotency key per agent; a decision ID is consumed once an execution row commits; draft creation and reservation link are atomic; durable compare-and-set management claims survive restart and are never released by age or timeout.

Evidence: `docs/SELF_TRADING_ENTRY_CAPACITY_2026_10_26.md`; `docs/SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md`; `docs/SELF_TRADE_MANAGEMENT_TARGET.md`; `docs/SELF_TRADING_RELIABILITY_2026_10_26.md (defect 4)`

**Acceptance criterion to match or beat:** Zero duplicate broker orders in fault-injection runs (crash after claim, lost response, retry storm) at the server boundary; replicated against a demo broker.

*Note:* 'Ahead' is limited to documented server-side semantics: IBKR's documented check rejects reused IDs, not logically duplicate intents. Not established end to end (see DUP-2).

#### DUP-2 — Terminal-side deduplication across EA restart

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: Magic number in each request lets an EA identify and filter its own orders/positions (e.g. after restart). [M1](https://www.mql5.com/en/docs/trading/ordersend) [M3](https://www.mql5.com/en/docs/constants/structures/mqltraderequest)
- *Interactive Brokers*: maintainAndResubmitOrdersOnReconnect resubmits orders attempted while disconnected. [I3](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config.md)

**ARX today** (source review): v131 live deduplication is a RAM ring buffer (lost on restart); v154 duplicate handling does not replay durable original outcomes.

Evidence: `mt5-bridge/ReplitMT5BridgeEA_v131.mq5:587-595`; `docs/SELF_TRADE_TERMINAL_TARGET_PREFLIGHT.md (remaining gaps)`

**Acceptance criterion to match or beat:** EA persists commandId → outcome durably (file or terminal global variables) before acknowledging; after a forced EA restart mid-command, a redelivered command returns the original outcome and never re-submits; extracted-handler and demo tests.

#### DUP-3 — Ownership tagging of automated orders

*Scorecard dimension:* integration · *Status:* **parity-claimed-unverified**

**Competitors**

- *MetaTrader 5*: MqlTradeRequest.magic is the Expert Advisor ID for grouping its orders. [M3](https://www.mql5.com/en/docs/constants/structures/mqltraderequest)
- *cTrader*: Trading events fire for both cBot-initiated and manual activity; label semantics not verified in this research. [C3](https://help.ctrader.com/ctrader-algo/how-tos/cbots/cbot-trading-operations/)

**ARX today** (offline-tested (integrity); broker-unverified): v150+ EAs set MagicNumber (v154 default 73154777) and an ARX comment; server attribution (agent, decision, owner) is covered by the command integrity hash/signature.

Evidence: `mt5-bridge/ARX_AI_Universal_Agent_v154.mq5:82,187`; `artifacts/api-server/src/lib/security/commandIntegrity.ts`

**Acceptance criterion to match or beat:** Every broker deal produced by ARX automation can be attributed to one command and agent from broker history alone (magic + comment/position identifier) in a demo reconciliation report.

### Reconciliation

#### REC-1 — Strategy/account position synchronisation at start-up

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *NinjaTrader*: StartBehavior: WaitUntilFlat (default), WaitUntilFlatSynchronizeAccount, ImmediatelySubmit, ImmediatelySubmitSynchronizeAccount, AdoptAccountPosition. [N4](https://static.ninjatrader.com/support/helpGuides/nt8/startbehavior.htm)
- *QuantConnect LEAN*: Deployments can be seeded with existing cash and holdings; restarts carry cash, holdings and some open orders. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)
- *Freqtrade*: Open orders are updated on start-up unless exchange.skip_open_order_update is set. [F3](https://www.freqtrade.io/en/stable/configuration/)

**ARX today** (offline-tested; broker-unverified): Agent reconciliation advances executions only from owned command evidence; snapshot ingestion and ghost reconciliation exist. Position uniqueness, ingestion and backfill still key on (user, ticket), and the MT5 position identifier is discarded from the newer EA snapshot.

Evidence: `artifacts/api-server/src/lib/selfTrade/agentReconciliation.ts`; `docs/SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md (slice C)`; `docs/SELF_TRADE_TARGET_CONSUMERS.md`

**Acceptance criterion to match or beat:** Account-scoped identity (connection, login, actual server, position identifier); a restart with two accounts holding equal ticket numbers produces zero cross-account matches; documented start-up policy equivalent to wait-until-flat / adopt.

#### REC-2 — Broker-vs-app mismatch handling

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *QuantConnect LEAN*: Restart reloads holdings from the brokerage; algorithm state itself is not saved. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)

**ARX today** (offline-tested; broker-unverified): Lost-command or position mismatch pauses management (no auto-close); unknown evidence and exhausted retries stay HELD; accounting holds block new entries for the affected agent ledger.

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §8`; `docs/RESULT_SETTLEMENT_OUTBOX.md`; `docs/SELF_TRADE_TARGET_CONSUMERS.md`

**Acceptance criterion to match or beat:** Injected mismatches (external close, manual partial close, missing position, extra position) are each detected within one reconciliation cycle and surfaced with an operator action; measured detection lag p95.

#### REC-3 — Realised P/L reconciled to broker deals and costs

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: Deal properties separate profit, commission, swap and fee with position identity (per ARX's prior research). [M10](https://www.mql5.com/en/docs/constants/tradingconstants/dealproperties)

**ARX today** (offline-tested (PostgreSQL)): Accounting labels RECORDED / INCOMPLETE / UNAVAILABLE and never substitutes zero; broker deal completeness, corrections and costs remain unverified; bound automatic closes record null profit plus a ledger hold.

Evidence: `docs/SELF_TRADE_ACCOUNTING_REPORTING.md`; `docs/SELF_TRADE_TARGET_CONSUMERS.md`

**Acceptance criterion to match or beat:** For a demo period, every closed automated position matches broker deal history on volume, price, commission, swap and fee to the cent; mismatches remain INCOMPLETE with reason.

#### REC-4 — Live-vs-simulation reconciliation

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *QuantConnect LEAN*: Parallel out-of-sample backtest overlaid on each live deployment's equity and fills. [Q4](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation)

**ARX today** (source review): No equivalent for self-trade agents.

Evidence: `artifacts/api-server/src/lib/selfTrade/ (no simulation counterpart)`

**Acceptance criterion to match or beat:** Each agent's live or demo fills are replayed through the same decision logic on the same data, and divergence (entries, exits, P/L) is reported per agent per week.

### Recovery

#### RCV-1 — Crash recovery of in-flight work

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *QuantConnect LEAN*: Optional automatic restarts are best effort and stop after five failed attempts; state is not saved. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)
- *Freqtrade*: Trade history in an SQL database (separate dry-run database by default). [F3](https://www.freqtrade.io/en/stable/configuration/)

**ARX today** (offline-tested (fresh-process PostgreSQL recovery); not deployed): Reservations, claims and receipts are durable; a server settlement outbox recovers accepted receipts, but its worker defaults OFF and the migration has not been applied anywhere. A crash between the dispatch claim and mailbox delivery remains an uncertain handoff with no outbox and no audited repair workflow.

Evidence: `docs/RESULT_SETTLEMENT_OUTBOX.md`; `docs/SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md (compatibility and recovery)`; `docs/SELF_TRADING_RELIABILITY_2026_10_26.md (remaining work)`

**Acceptance criterion to match or beat:** Kill -9 at each boundary (after reservation, after claim, after pickup, after broker result, after receipt) recovers to a correct state without duplicate orders; uncertain handoffs are resolved through an audited evidence-based repair action; recovery time measured.

#### RCV-2 — Durable terminal result delivery

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: Terminal transaction queue is bounded (1024) and unordered, so an EA must persist what it needs. [M6](https://www.mql5.com/en/docs/event_handlers/ontradetransaction)

**ARX today** (source review): The settlement outbox is server-side only; results the terminal never delivered are outside its protection.

Evidence: `docs/RESULT_SETTLEMENT_OUTBOX.md (remaining limits)`; `docs/ARX_CHECKPOINT_2026_10_27.md (uncommitted successor work)`

**Acceptance criterion to match or beat:** EA writes each broker result to a durable local outbox before posting and retries until acknowledged; test: network cut after broker fill, EA restart, result still arrives exactly once.

#### RCV-3 — Connection-loss behaviour

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *Interactive Brokers*: maintainAndResubmitOrdersOnReconnect; rejectMessagesAboveMaxRate. [I3](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config.md)
- *MetaTrader 5*: TRADE_RETCODE_CONNECTION (10031) when there is no connection to the trade server. [M5](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes)

**ARX today** (offline-tested; broker-unverified): Phase B blocks dispatch when the EA heartbeat is older than 15 s; heartbeat connection identity is still mutable.

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §5 gate 7`; `docs/SELF_TRADE_MANAGEMENT_TARGET.md (remaining work)`

**Acceptance criterion to match or beat:** Demo drill: drop EA network for 30 s and 5 min during open positions; no new dispatch while stale, no lost commands, protective commands delivered after reconnect, operator alerted.

#### RCV-4 — Account / server switch protection

*Scorecard dimension:* reliability · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: Terminal option disables EA trading when the account is changed (also on profile and symbol/period change). [M7](https://www.metatrader5.com/en/terminal/help/algotrading/trade_robots_indicators)

**ARX today** (C++ harness of extracted MQL; native MetaEditor and broker unverified): Automatic CLOSE/MODIFY re-read login, actual server, mode, ticket, symbol, side and volume immediately before CTrade. Entry routing is not yet pinned to an account/session; a switch between the final check and the broker call is still possible.

Evidence: `docs/SELF_TRADE_TERMINAL_TARGET_PREFLIGHT.md`; `docs/SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md (slice B)`

**Acceptance criterion to match or beat:** Entry and management commands carry a signed target (login, actual server, connection, symbol); terminal refuses on any mismatch; demo drill switches accounts between claim and pickup with zero mis-routed orders.

*Note:* Management path is closer to parity than entries.

### Emergency stops

#### STOP-1 — Global automated-trading kill switch

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *MetaTrader 5*: Algo Trading button disables automated trading for all EAs. [M7](https://www.metatrader5.com/en/terminal/help/algotrading/trade_robots_indicators)
- *QuantConnect LEAN*: Stop button immediately stops the algorithm; holdings are kept. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)
- *Freqtrade*: /stop stops the trader. [F4](https://www.freqtrade.io/en/stable/telegram-usage/)

**ARX today** (offline-tested; broker-unverified): Platform emergency stop and safety-core kill switch combine in platformStop(), which fails closed on unreadable settings; agent kill switches are checked at the gate and re-checked immediately before submission; release is a single audited operation.

Evidence: `docs/TIER1_PLATFORM_SAFETY_SOURCE.md`; `artifacts/api-server/src/lib/selfTrade/killSwitchGate.ts`; `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §5`

**Acceptance criterion to match or beat:** Measured engage → last possible new broker order: zero orders submitted after the engage commit (including commands already in the mailbox); p95 engage latency reported; drill on demo.

*Note:* Whether already-queued mailbox entry commands are withdrawn on engage was not established in this research.

#### STOP-2 — Pause new entries while still managing exits

*Scorecard dimension:* usability · *Status:* **ahead**

**Competitors**

- *Freqtrade*: /stopentry stops new trades while exits continue; the pause is not persisted across restart. [F4](https://www.freqtrade.io/en/stable/telegram-usage/)

**ARX today** (offline-tested): LOCKDOWN/INCIDENT posture pauses autonomous entries; stops refuse only new risk while closes and stop tightening stay open; state is stored in the database.

Evidence: `artifacts/api-server/src/lib/selfTrade/autonomousCycle.ts:114`; `docs/TIER1_PLATFORM_SAFETY_SOURCE.md (preCheckStopRefusal)`

**Acceptance criterion to match or beat:** Pause survives process restart; protective closes and stop tightening succeed during pause in tests and on demo.

*Note:* 'Ahead' only versus Freqtrade's documented non-persistent pause; broker behaviour unverified.

#### STOP-3 — Flatten all / liquidate

*Scorecard dimension:* speed · *Status:* **not measured**

**Competitors**

- *QuantConnect LEAN*: Liquidate button sends market orders (market-on-open when closed) then stops the algorithm. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)
- *Freqtrade*: /forceexit all exits every open trade. [F4](https://www.freqtrade.io/en/stable/telegram-usage/)

**ARX today** (source review; broker-unverified): Operator emergency close supports ticket, user, allocation, all-shared and all scopes, only enqueuing closes through the normal gated pipeline; callers require admin/owner, confirmation phrase and reason.

Evidence: `artifacts/api-server/src/lib/live/emergencyClose.ts`

**Acceptance criterion to match or beat:** Demo drill with ≥10 positions across ≥2 accounts: time from command to all positions confirmed closed by broker evidence (median/p95), per-ticket outcome, zero closes against the wrong account.

#### STOP-4 — Scoped stops (agent, strategy, symbol, news)

*Scorecard dimension:* features · *Status:* **parity-claimed-unverified**

**Competitors**

- *Freqtrade*: Per-pair and global locks; /locks and /unlock. [F1](https://www.freqtrade.io/en/stable/plugins/) [F4](https://www.freqtrade.io/en/stable/telegram-usage/)

**ARX today** (offline-tested): Kill switch scopes GLOBAL, NEWS, AGENT, STRATEGY, SYMBOL with precedence; per-trader halt and frozen allocations.

Evidence: `artifacts/api-server/src/lib/selfTrade/killSwitchGate.ts:34`; `docs/TIER1_PLATFORM_SAFETY_SOURCE.md`

**Acceptance criterion to match or beat:** Each scope blocks exactly its target and nothing else in a table-driven test; engage/release audited with actor and reason.

### Paper/simulation

#### SIM-1 — Paper / dry-run forward test of automated agents

*Scorecard dimension:* features · *Status:* **behind**

**Competitors**

- *Freqtrade*: dry_run with dry_run_wallet (default 1000) and a separate dry-run database. [F3](https://www.freqtrade.io/en/stable/configuration/)
- *QuantConnect LEAN*: Deploy to the Paper Trading brokerage. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)
- *cTrader*: Cloud cBots on demo: 1 concurrent instance for 7 days. [C5](https://help.ctrader.com/ctrader-algo/documentation/cloud-features/)

**ARX today** (source review): Agents run in SHADOW (audit-only intent, no simulated fill) or LIVE; the executor submits with accountMode 'live' and the instant-trade helper rejects 'paper'. No agent DEMO or paper execution path with fill accounting was found, although the Capital Constitution requires demo execution before real money.

Evidence: `artifacts/api-server/src/lib/selfTrade/agentExecutor.ts:178-190,407`; `artifacts/api-server/src/lib/live/instantTrade.ts:22-28`; `docs/CAPITAL_CONSTITUTION.md Article VII`

**Acceptance criterion to match or beat:** Agent mode DEMO (governed demo queue) and PAPER (real-quote paper book) use the same decision, sizing and gate code as LIVE, with separate ledgers; a 2-week forward run reports fills, slippage and P/L per agent.

*Note:* Whether per-user SIMULATED routing intercepts agent intents was not established; the executor itself hard-codes live.

#### SIM-2 — Historical replay with realistic ticks, spread and delay

*Scorecard dimension:* accuracy · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: Every tick based on real ticks; zero/fixed/random execution delay; forward period split (1/2, 1/3, 1/4, custom); genetic optimisation. [M8](https://metatrader5.com/en/terminal/help/algotrading/testing) [M9](https://metaquotes.net/en/metatrader5/algorithmic-trading/tester)
- *cTrader*: Tick data from server; fixed/live/random spread; commission per million. [C6](https://help.ctrader.com/ctrader-algo/how-tos/cbots/backtest-a-cbot/)
- *TradingView*: Broker emulator with intrabar assumptions; bar magnifier uses lower-timeframe bars (up to 200,000). [T2](https://www.tradingview.com/pine-script-docs/concepts/strategies/)

**ARX today** (source review): Research backtest modules exist, but there is no replay harness for the self-trade agent decision/executor path (audit: 'no backtest harness for live scenario replay'; G4 end-to-end cycle test).

Evidence: `artifacts/api-server/src/lib/backtest/`; `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §10 G4, §11`

**Acceptance criterion to match or beat:** Agent replay on broker tick history with spread, commission and delay models, walk-forward splits, and recorded experiment count; results reproducible from a commit and dataset hash.

### Audit trail

#### AUD-1 — Decision and execution audit trail

*Scorecard dimension:* reliability · *Status:* **parity-claimed-unverified**

**Competitors**

- *Freqtrade*: Trade history stored in an SQL database; Telegram /status shows open trades and pending orders. [F3](https://www.freqtrade.io/en/stable/configuration/) [F4](https://www.freqtrade.io/en/stable/telegram-usage/)
- *TradingView*: Alert log shows webhook delivery status; webhooks may occasionally fail to arrive. [T3](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)

**ARX today** (offline-tested): Append-only ledgers by constitution; dispatch claim and its audit commit in one transaction (audit failure rolls back the claim); autonomous cycle aborts if the audit insert fails.

Evidence: `docs/CAPITAL_CONSTITUTION.md Article V`; `docs/SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md`; `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §5 Layer 0`

**Acceptance criterion to match or beat:** For a sampled set of automated orders, the audit chain reconstructs decision → admission → draft → claim → pickup → broker result → settlement with timestamps and actors, with no gaps.

*Note:* Competitor audit atomicity is undocumented; no comparison claim.

### Operator controls

#### OPS-1 — Mode control and LIVE escalation consent

*Scorecard dimension:* usability · *Status:* **parity-claimed-unverified**

**Competitors**

- *Interactive Brokers*: readOnlyApi blocks modifications through the API; trusted IPs / localhost-only. [I3](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config.md)
- *MetaTrader 5*: Global Algo Trading toggle; per-EA permissions; WebRequest URL allowlist. [M7](https://www.metatrader5.com/en/terminal/help/algotrading/trade_robots_indicators)

**ARX today** (offline-tested): PAPER/DEMO/LIVE per user; escalation to LIVE requires the exact phrase 'CONFIRM LIVE MODE' and a ≥10-character reason; every change audited; LIVE also requires the server env flag and all Phase B gates.

Evidence: `docs/OPERATOR_TRADING_MODE_CONTROL.md`; `lib/db/src/repositories/tradingModeGate.ts`

**Acceptance criterion to match or beat:** Truth-table tests for every transition; no automated path can raise authority without an audited owner action.

#### OPS-2 — Risk-event alerting and operational SLOs

*Scorecard dimension:* operating efficiency · *Status:* **behind**

**Competitors**

- *NinjaTrader partner (prop-firm)*: Alert thresholds below liquidation thresholds. [N6](https://partner.ninjatrader.com/overview/prop-firm-management/post-trade-risk)
- *Freqtrade*: Telegram control and status messages. [F4](https://www.freqtrade.io/en/stable/telegram-usage/)
- *NinjaTrader (retail)*: Staff state no app/email notification when the Daily Loss Limit is hit. [N5](https://forum.ninjatrader.com/forum/ninjatrader-8/platform-technical-support-aa/1238947-question-about-the-daily-loss-limit-in-account-risk-settings?p=1239084)

**ARX today** (source review): An OPERATIONAL_RATE_CAP_REACHED monitor exists; reconciliation lag, unresolved-claim age, rejection/duplicate rates and cycle latency SLOs are listed as missing.

Evidence: `artifacts/api-server/src/lib/alerts/operationalRateCapMonitor.ts`; `docs/SELF_TRADING_RELIABILITY_2026_10_26.md (operational SLOs)`

**Acceptance criterion to match or beat:** Defined SLOs with alert rules for: HELD settlements, unresolved claims older than X, reconciliation lag, EA heartbeat staleness, loss-limit breach, kill-switch engage; alert delivery tested end to end.

#### OPS-3 — Unattended 24/7 operation

*Scorecard dimension:* scalability · *Status:* **behind**

**Competitors**

- *cTrader*: Cloud cBots run with the app closed; up to 10 concurrent live instances (broker-dependent). [C5](https://help.ctrader.com/ctrader-algo/documentation/cloud-features/)
- *QuantConnect LEAN*: Cloud live deployments with optional automatic restart. [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)

**ARX today** (source review): By policy there is no always-on autonomous loop; cycles are admin-triggered. MT5 execution depends on a terminal-side EA.

Evidence: `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §1`; `docs/SELF_TRADING_RELIABILITY_2026_10_26.md`; `docs/CAPITAL_CONSTITUTION.md Article VII`

**Acceptance criterion to match or beat:** Owner-approved scheduler with explicit enable, bounded cadence, health checks and automatic disable on SLO breach; demonstrated on demo for 7 days.

*Note:* Deliberate safety posture; changing it needs an owner decision.

### Execution quality

#### SPEED-1 — Decision-to-broker latency

*Scorecard dimension:* speed · *Status:* **not measured**

**Competitors**

- *TradingView*: Webhook receiver must respond within 3 s or the request is cancelled; ports 80/443 only. [T3](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)

**ARX today** (local benchmarks only): Only local component timings exist: mailbox 50-command completion p95 6.989 ms; result receipt mixed-load p95 123.749 ms (fails the 100 ms target); no broker or network latency measured.

Evidence: `docs/SELF_TRADE_TERMINAL_TARGET_PREFLIGHT.md`; `docs/RESULT_SETTLEMENT_OUTBOX.md`

**Acceptance criterion to match or beat:** End-to-end median/p95/p99 from decision commit to broker result receipt on demo, acknowledgement and completion measured separately; receipt p95 ≤ 100 ms locally under the mixed fixture.

*Note:* No competitor publishes comparable latency figures in the researched docs.

### Risk controls

#### SCALE-1 — Agents and commands per account/install

*Scorecard dimension:* scalability · *Status:* **not measured**

**Competitors**

- *cTrader*: Up to 10 concurrent live cloud instances; 1 on demo. [C5](https://help.ctrader.com/ctrader-algo/documentation/cloud-features/)

**ARX today** (local benchmarks only): Mailbox pickup bounded to 50 commands and 64,000 bytes per row; accounting read p95 6.996 ms at 100 agents / 1,000 executions locally; 24-way admission contention tested.

Evidence: `docs/SELF_TRADE_TERMINAL_TARGET_PREFLIGHT.md`; `docs/SELF_TRADE_ACCOUNTING_REPORTING.md`; `docs/SELF_TRADING_ENTRY_CAPACITY_2026_10_26.md`

**Acceptance criterion to match or beat:** Documented capacity envelope (agents, cycles/min, commands/min per bridge) with p95 latency and zero correctness failures at 2× the target load.

### Execution quality

#### INTEG-1 — Venue / broker coverage

*Scorecard dimension:* integration · *Status:* **behind**

**Competitors**

- *QuantConnect LEAN*: Live brokerage integrations documented for multiple brokers (e.g. Interactive Brokers, Tradier, TradeStation). [Q5](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started)
- *TradingView*: Broker Integration API lets brokers expose order placement and position closing in TradingView. [T4](https://www.tradingview.com/broker-api-docs/)

**ARX today** (source review): MT5 via terminal-side EA only (constitutionally required when no direct broker API exists).

Evidence: `docs/CAPITAL_CONSTITUTION.md Article VII`; `mt5-bridge/`

**Acceptance criterion to match or beat:** A second certified venue adapter behind the same Trade Engine contract, passing the same duplicate/recovery/reconciliation suite.

*Note:* Breadth is a product choice; correctness on MT5 is the priority.

### Operator controls

#### USAB-1 — Strategy authoring and transparency for users

*Scorecard dimension:* usability · *Status:* **behind**

**Competitors**

- *MetaTrader 5*: MQL5 Expert Advisors. [M1](https://www.mql5.com/en/docs/trading/ordersend)
- *cTrader*: C# cBots with events and async APIs. [C3](https://help.ctrader.com/ctrader-algo/how-tos/cbots/cbot-trading-operations/) [C4](https://help.ctrader.com/ctrader-algo/how-tos/cbots/parallel-order-execution/)
- *TradingView*: Pine Script strategies with alert messages. [T1](https://tradingview.com/pine-script-docs/concepts/alerts) [T2](https://www.tradingview.com/pine-script-docs/concepts/strategies/)
- *Freqtrade*: Python strategies with protections and hyperopt. [F1](https://www.freqtrade.io/en/stable/plugins/)

**ARX today** (source review): Five fixed profile templates (ALPHA/BLAZE/ATLAS/NOVA/TITAN) seed agents; decisions come from the ARX decision engine; users cannot author strategies.

Evidence: `artifacts/api-server/src/lib/selfTrade/profiles.ts`; `docs/AUTO_TRADING_BOT_SAFETY_AUDIT.md §2`

**Acceptance criterion to match or beat:** User-visible per-trade rationale (entry, stop, target, R:R, invalidation) for 100% of automated decisions; any configurable parameter is bounded by deterministic limits.

*Note:* Custom authoring may be out of scope; transparency is the measurable target (audit R7).

### Reconciliation

#### EFF-1 — Reconciliation cost per cycle

*Scorecard dimension:* operating efficiency · *Status:* **not measured**

**Competitors**

- *Freqtrade*: stoploss_on_exchange_interval default 60 s to avoid exchange bans from checking every iteration. [F2](https://www.freqtrade.io/en/stable/stoploss/)

**ARX today** (offline-tested): Reconciliation reads only active execution states and batches linked command reads; accounting overview uses one grouped statement with constant query count.

Evidence: `docs/SELF_TRADING_RELIABILITY_2026_10_26.md`; `docs/SELF_TRADE_ACCOUNTING_REPORTING.md`

**Acceptance criterion to match or beat:** Queries per reconciliation cycle constant in the number of agents (asserted in tests) and broker/EA requests per minute within documented terminal limits (10024 TOO_MANY_REQUESTS never observed on demo).

## Highest-impact gaps, ranked

Ranked by the risk that ARX's record diverges from real broker exposure, then by what blocks the constitution's demo-before-live requirement, then by competitive breadth.

### 1. Truthful terminal fill results (EXQ-4)

A broker partial fill (10010) is reported as REJECTED by v154, and v131 reports LIVE_FILLED from the CTrade boolean with the requested lot as executed volume. Real exposure can diverge from ARX's record.

Next steps:

- Map retcodes exactly per the MQL5 table in both EAs: 10009 FILLED, 10010 PARTIAL, 10008 PLACED, connection/timeout codes UNKNOWN (never REJECTED).
- Add ResultVolume, ResultPrice, ResultDeal, request_id and the deal's position identifier (via HistoryDealSelect) to every result payload.
- Server: accept PARTIAL with executed volume; never default executed volume to requested volume; UNKNOWN goes to reconciliation.
- Extend the extracted C++ handler harness with a retcode matrix; schedule a demo partial-fill/rejection test under owner authorisation.

### 2. Agent DEMO / paper forward testing (SIM-1)

The Capital Constitution requires demo execution before real money, but the agent executor only submits LIVE intents; SHADOW records intents without fills.

Next steps:

- Add agent modes DEMO and PAPER that reuse decision, sizing, admission and gate code and route to the governed DEMO queue or the real-quote paper book.
- Separate agent ledgers per mode; reports must label simulated vs broker-demo fills.
- Run a 2-week forward test per profile and publish fills, slippage and P/L (no profitability claims).

### 3. Durable handoff on both sides of the bridge (RCV-1/RCV-2/DUP-2)

Claim-to-mailbox has no outbox, EA deduplication is RAM-only, and terminal results are not durably queued. A crash or restart at these points can lose or repeat a broker action.

Next steps:

- Server: transactional dispatch outbox written in the claim transaction, delivered idempotently.
- EA: persist commandId → outcome before acknowledging; replay original outcome on redelivery; local result outbox retried until acknowledged.
- Audited evidence-based repair action for uncertain handoffs (no time-based release).
- Kill -9 fault matrix at each boundary in the PostgreSQL + extracted-EA lanes.

### 4. Account-scoped identity and entry account pinning (REC-1/RCV-4)

Positions key on (user, ticket), the MT5 position identifier is discarded, and entry routing can still pick or rebind a bridge after admission.

Next steps:

- Implement slice B (signed immutable entry target checked by the terminal before mutation) and slice C (additive identity migration: connection, login, actual server, position identifier) from SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md.
- Tests: equal ticket numbers on two accounts; account switch between claim and pickup.

### 5. Loss limits: weekly cap and breach response (RISK-1/RISK-2)

maxWeeklyLossUsd is stored but never evaluated; a daily-loss breach blocks entries but does not flatten, and floating P/L is not included.

Next steps:

- Add WEEKLY_LOSS_CAP_REACHED to the execution permission evaluator using rolling 7-day realised (and optionally floating) P/L; unknown accounting refuses.
- Owner-configurable breach action: block, or block and flatten through emergencyClose; notify the operator.
- Measure breach-to-flat time on demo.

### 6. Dispatch-time spread and news re-check (EXQ-3/RISK-6)

Spread and news risk are judged at decision time only (audit G1, G3).

Next steps:

- Executor re-reads the live quote and news risk immediately before draft; refuses SPREAD_TOO_WIDE / NEWS_RISK_ESCALATED; unobservable inputs refuse.

### 7. Execution-quality and latency measurement (EXQ-5/SPEED-1)

No per-fill slippage or end-to-end latency is recorded, so execution quality cannot be compared with anything.

Next steps:

- Record requested vs fill price, signed slippage and stage timestamps per automated fill; median/p95/p99 dashboards; include in demo reports.

### 8. Margin-aware pre-check (EXQ-1/SIZE-2)

No OrderCheck() call; agent admission ignores margin.

Next steps:

- Call OrderCheck() in the EA before entry and report margin projections; add margin-aware agent admission using broker-reported requirements.

### 9. Alerting and SLOs (OPS-2)

Reliability doc lists missing SLOs for reconciliation lag, unresolved claims, rejection/duplicate rates.

Next steps:

- Define SLOs and alert rules; test delivery end to end.

### 10. Agent replay harness (SIM-2)

No tick-level replay of the agent path with spread, commission and delay.

Next steps:

- Build replay on broker tick history with walk-forward splits and recorded experiment counts.

## Sources

| ID | Source | Access |
|---|---|---|
| M1 | [MetaQuotes: OrderSend](https://www.mql5.com/en/docs/trading/ordersend) | fetched |
| M2 | [MetaQuotes: OrderCheck](https://www.mql5.com/en/docs/trading/ordercheck) | fetched |
| M3 | [MetaQuotes: MqlTradeRequest](https://www.mql5.com/en/docs/constants/structures/mqltraderequest) | fetched |
| M4 | [MetaQuotes: MqlTradeResult](https://www.mql5.com/en/docs/constants/structures/mqltraderesult) | fetched |
| M5 | [MetaQuotes: trade server return codes](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes) | fetched |
| M6 | [MetaQuotes: OnTradeTransaction](https://www.mql5.com/en/docs/event_handlers/ontradetransaction) | fetched |
| M7 | [MetaTrader 5 Help: Expert Advisors settings](https://www.metatrader5.com/en/terminal/help/algotrading/trade_robots_indicators) | fetched |
| M8 | [MetaTrader 5 Help: Strategy Testing](https://metatrader5.com/en/terminal/help/algotrading/testing) | fetched |
| M9 | [MetaQuotes: Strategy Tester overview](https://metaquotes.net/en/metatrader5/algorithmic-trading/tester) | fetched |
| M10 | [MetaQuotes: deal properties](https://www.mql5.com/en/docs/constants/tradingconstants/dealproperties) | cited by ARX docs; not re-fetched in this research |
| M11 | [MetaQuotes: position properties](https://www.mql5.com/en/docs/constants/tradingconstants/positionproperties) | cited by ARX docs; not re-fetched in this research |
| T1 | [TradingView Pine Script: alerts](https://tradingview.com/pine-script-docs/concepts/alerts) | fetched |
| T2 | [TradingView Pine Script: strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/) | fetched (strategy.risk.* section not retrieved) |
| T3 | [TradingView Help: webhook alerts](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/) | fetched |
| T4 | [TradingView: Broker Integration API](https://www.tradingview.com/broker-api-docs/) | fetched (landing page only) |
| Q1 | [QuantConnect: supported risk models](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/risk-management/supported-models) | fetched; only model names retrievable, parameters not rendered |
| Q2 | [QuantConnect: risk management key concepts](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/risk-management/key-concepts) | fetched (partial) |
| Q3 | [QuantConnect: order tickets](https://quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/order-management/order-tickets) | fetched (tracking section only) |
| Q4 | [QuantConnect: live reconciliation](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation) | fetched |
| Q5 | [QuantConnect: cloud live trading getting started](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/getting-started) | fetched |
| N1 | [NinjaTrader 8 Help: ATM Strategy](https://static.ninjatrader.com/support/helpGuides/nt8/atm_strategy.htm) | fetched |
| N2 | [NinjaTrader 8 Help: server-side vs local ATMs](https://static.ninjatrader.com/support/helpGuides/nt8/server-side-vs-local-atms.htm) | fetched |
| N3 | [NinjaTrader 8 Help: server-side ATM strategy](https://static.ninjatrader.com/support/helpGuides/nt8/server-side-atm-strategy.htm) | fetched |
| N4 | [NinjaTrader 8 Help: StartBehavior](https://static.ninjatrader.com/support/helpGuides/nt8/startbehavior.htm) | fetched |
| N5 | [NinjaTrader support forum (staff answers): account Daily Loss Limit](https://forum.ninjatrader.com/forum/ninjatrader-8/platform-technical-support-aa/1238947-question-about-the-daily-loss-limit-in-account-risk-settings?p=1239084) | fetched; official forum staff statements, not the help guide |
| N6 | [NinjaTrader partner docs: post-trade risk (prop-firm management)](https://partner.ninjatrader.com/overview/prop-firm-management/post-trade-risk) | fetched; partner/prop-firm API, not retail desktop |
| C1 | [cTrader Algo: TradeResult](https://help.ctrader.com/ctrader-algo/references/Trading/TradeResult/) | fetched |
| C2 | [cTrader Algo: ProtectionType](https://help.ctrader.com/ctrader-algo/references/Trading/ProtectionType) | fetched |
| C3 | [cTrader Algo: cBot trading operations](https://help.ctrader.com/ctrader-algo/how-tos/cbots/cbot-trading-operations/) | fetched |
| C4 | [cTrader Algo: parallel order execution](https://help.ctrader.com/ctrader-algo/how-tos/cbots/parallel-order-execution/) | fetched |
| C5 | [cTrader Algo: cloud features](https://help.ctrader.com/ctrader-algo/documentation/cloud-features/) | fetched |
| C6 | [cTrader Algo: backtest a cBot](https://help.ctrader.com/ctrader-algo/how-tos/cbots/backtest-a-cbot/) | fetched |
| I1 | [IBKR TWS API: order precautions](https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/order-precautions) | fetched |
| I2 | [IBKR TWS API: ApiPrecautionsConfig](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-precautions-config.md) | fetched |
| I3 | [IBKR TWS API: ApiSettingsConfig](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config.md) | fetched |
| I4 | [IBKR TWS API: error codes](https://www.interactivebrokers.com/docs/tws-api/doc/error-handling/error-codes) | fetched (first 100k chars) |
| I5 | [IBKR TWS Users' Guide (archived): precautionary settings](https://interactivebrokers.co.uk/en/software/tws.bak/usersguidebook/configuretws/define_precautionary_settings.htm) | fetched; archived guide, may be stale |
| I6 | [IBKR Campus: configuring TWS presets](https://ibkrcampus.com/campus/trading-lessons/configuring-tws-presets/) | fetched |
| F1 | [Freqtrade: plugins / protections](https://www.freqtrade.io/en/stable/plugins/) | fetched |
| F2 | [Freqtrade: stoploss](https://www.freqtrade.io/en/stable/stoploss/) | fetched |
| F3 | [Freqtrade: configuration](https://www.freqtrade.io/en/stable/configuration/) | fetched (first 100k chars) |
| F4 | [Freqtrade: Telegram usage](https://www.freqtrade.io/en/stable/telegram-usage/) | fetched |

### Not accessible or only partly accessible

- QuantConnect supported risk models: only model names rendered; parameters/defaults unverified.
- QuantConnect live-trading key concepts (Stateful Strategies, Algorithm Portfolio): body not retrievable.
- QuantConnect order tickets: update/cancel/OrderResponse sections not retrieved.
- TradingView strategies page: strategy.risk.* section not retrieved; Pine risk functions unverified.
- cTrader cBots landing and 'backtesting and optimizing' pages returned redirect stubs; ExecuteMarketOrder parameter names (label, market range) unverified.
- NinjaTrader: no official help-guide page for the account Daily Loss Limit was found; staff forum answers used. ConnectionLossHandling not verified.
- Interactive Brokers: current size/value limit precaution settings verified only via an archived Users' Guide and an IBKR Campus lesson.
- MQL5 ENUM_ORDER_TYPE_FILLING page not fetched; filling-mode semantics not compared.
- 3Commas not researched (Freqtrade chosen as the crypto bot platform).
- Direct HTTPS (curl) to all documentation hosts was refused by the sandbox proxy; WebFetch summaries were used instead of raw pages.

## Maintenance

Update a row only with new evidence: a test receipt for ARX, or a cited official page for a competitor. Moving a row to *ahead* or *parity* on the strength of broker behaviour requires an owner-authorised demo test receipt. Keep the JSON and Markdown in step; neither weakens a criterion silently.
