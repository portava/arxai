# MT5-style order controls (2026-11-04)

Owner request: Buy/Sell with a lot size on every chart and trade surface; Sell Limit,
Buy Limit, Buy Stop, Sell Stop and an execute button (or a small overlay to pick
them); buttons must behave exactly like MT5's; once in a trade, set Stop Loss /
Take Profit; let the AI shift SL/TP when the trader believes a fakeout is taking
place. Built on the one-click mode PR (#110) and Eleanor execution (#109).

## MT5 semantics implemented (MetaTrader 5 terminal help, "Types of Orders")

| Control | MT5 rule | Where enforced |
|---|---|---|
| Buy by Market / Sell by Market | Buy at Ask, Sell at Bid | one-click bar, order window |
| Buy Limit | price **below** the current Ask; fills when Ask falls to it | client `orderTicketRules.ts`, server `pendingOrderRules.ts`, broker |
| Sell Limit | price **above** the current Bid | same |
| Buy Stop | price **above** the current Ask | same |
| Sell Stop | price **below** the current Bid | same |
| Buy Stop Limit | stop above Ask, then a Buy Limit at a limit price **below** the stop | same |
| Sell Stop Limit | stop below Bid, then a Sell Limit at a limit price **above** the stop | same |
| Stop Loss / Take Profit | Buy: SL below, TP above the reference; Sell: reverse | same (reference = pending price, stop-limit's limit price, or Bid/Ask for market) |
| Expiration | GTC, Today, or a specified time (ORDER_TIME_SPECIFIED) | client + `expirationEpochSeconds` on the server |
| Modify open position | new SL/TP on the correct side of the current price | `validateModify`, instant router MODIFY_SL_TP, demo MODIFY_SLTP |

When no Bid/Ask is known the side check is skipped and the broker enforces it; a
missing pending price is always refused. The broker's own stops/freeze levels
apply after all of this.

## Surfaces

* **Chart one-click bar** (`OneClickTradePanel`): SELL bid | lot − + | BUY ask, plus a
  **Pending…** button that opens the order window; each open position row has an
  **SL/TP** button and the × close.
* **Trade from chart** card (`ChartTradeEntry`): Buy/Sell plus "Buy Limit · Sell Limit
  · Buy Stop · Sell Stop…" opening the order window (setup-preview SL/TP pre-filled).
* **Chart legend** (`ChartPositionOverlayPanel`): SL/TP button beside Close.
* **Scanner chart** (`ScannerChartPanel`): "Order types" beside Plan Buy / Plan Sell.
* **Quick Trade panel** (Trade Command Room): "Open order window (type)" pre-filled with
  the panel's order type, lot, SL/TP. SELL/BUY still hand off to the manual ticket only.
* **Open live positions** table: SL/TP button beside Close.

## Order window (`components/trade/OrderTicketOverlay.tsx`)

Live Bid/Ask from `/api/data/quote` (feed-scoped, with freshness); 8 MT5 types as
radio buttons with a one-line MT5 hint; lot with − / + (one-click default and cap);
price (+ stop-limit price); SL/TP with a live risk:reward; expiry GTC / Today /
Specified. Button wording is MT5's: "Buy by Market", "Sell by Market", "Place Buy
Limit", … The first validation error is shown under the button, which stays disabled
until the ticket is valid. Market orders are disabled while the quote is stale.

## Routing (`lib/tradeActions.ts`) — nothing bypasses a gate

| Scope | Path |
|---|---|
| live, one-click ON | instant-trade router `/api/trades/instant/execute` with `orderType`, `price`, `stopLimitPrice`, `expiration`, SL/TP |
| live, one-click OFF | standard `/api/me/live/commands` draft → confirm → dispatch; pending fields ride in `payload` |
| demo, market | governed demo queue `PLACE_MARKET_ORDER` |
| demo, pending | governed demo queue `PLACE_PENDING_ORDER` (EA v1.32+). The server refuses the draft for an older bridge EA with `EA_VERSION_TOO_OLD_FOR_COMMAND:PLACE_PENDING_ORDER:<v><1.32` (v1.31 and earlier answer `REJECTED_UNKNOWN_COMMAND_TYPE`); the ticket shows that refusal in plain words. |
| modify live | instant router `MODIFY_SL_TP` |
| modify demo | demo queue `MODIFY_SLTP` |

Live one-click requires the server's one-click flag (`LIVE_ONE_CLICK_DISABLED`
otherwise), which is why the OFF path uses the standard command.

## Server changes

* `lib/live/pendingOrderRules.ts` (new, pure): classify, validate pending price side,
  stop-limit leg, SL/TP side, expiration → epoch. Used by the instant router
  (`instantTrade.ts`) **and** the standard route (`routes/meLive.ts`).
* Instant-trade intent accepts `price`, `stopLimitPrice`, `expiration`.
* **Fix**: live pending orders never reached the EA with their type or price. The
  `mt5_commands` mirror (`liveCommandPipeline.buildBridgedMt5CommandPayload`) now
  carries `orderType`, `entry`, `stopLimitPrice`, `expirationEpoch`, the keys the
  v154 EA's `HandlePlacePending` reads.

## Eleanor fakeout authority (owner spec)

Per monitored position (not account-wide): a toggle in the Eleanor watches strip
("Shift SL/TP on fakeout") or "monitor my EURUSD and shift the stop on a fakeout"
in chat. Stored in the monitor's `risk_params` (no migration). Policy
(`lib/assistant/eleanorFakeoutPolicy.ts`, pure):

* Fakeout = the latest **completed** M15 bar spiked against the position
  (`fakeoutRiskScore ≥ 60`) and closed back on the trade's side, while reversal
  evidence is **not** standing (reversal score below the monitor threshold).
* Stop loss may move beyond the wick extreme (+10% of the bar's range) but at most
  **50% of the original risk** beyond the current stop, never to the wrong side of
  price. Widening adds risk, so the cap is hard.
* Take profit is **only tightened**: a favourable spike within 15% of the target that
  snapped back brings the target to just inside the spike.
* At most 2 shifts per monitor, one per 15 minutes; never while price is at/through
  the stop (protective close runs first). Fire-time gate: AI-Assisted authority +
  `allowEleanorModifyCommands` permission. Every shift is audited
  (`ELEANOR_FAKEOUT_SHIFT`), notified, and confirmed by the broker.

## Tests

`pnpm --filter @workspace/api-server run test:mt5-order-controls-20261104` (16) and
`pnpm --filter @workspace/trading-dashboard run test:mt5-order-controls` (24 new +
strip), both wired into root `ci`. All three packages typecheck; 87/87 guards.

Not done here (boundaries): no broker/terminal test, no migration. Demo pending
orders landed afterwards — see below.

## Update — demo pending orders (EA v1.32) and demo delivery fixes

**EA** `mt5-bridge/ReplitMT5BridgeEA_v132.mq5` (v1.31 + changes; v1.31 file untouched)
and `ArxDemoExecution.mqh` (`ExecuteDemoRequest`; v1.31's `ExecuteDemoCommand` unchanged):

* `PLACE_PENDING_ORDER`: the existing demo guards (demo hedging account, arms,
  maintenance, volume step, `DemoMaxLot`, finite SL/TP); entry / stop-limit / SL /
  TP rounded to tick size and digits; `expirationEpoch` (UTC) converted to
  trade-server time (offset rounded to 30 min), `ORDER_TIME_SPECIFIED` when set,
  else GTC. Limit/Stop via CTrade, Stop Limit via a raw `TRADE_ACTION_PENDING`
  request. Success only on retcode PLACED/DONE with an order ticket that
  `OrderSelect` finds → `PLACED_DEMO`; anything else `FAILED
  BROKER_OUTCOME_UNCONFIRMED_DO_NOT_RETRY`.
* `CANCEL_PENDING_ORDER`: `OrderSelect`, symbol match, pending type, `OrderDelete`,
  verified gone (and not filled in history) → `CANCELLED_DEMO`.
* Every served command carries `secondsUntilExpiry`; one still waiting when it runs
  out is answered `FAILED EXPIRED_BEFORE_EXECUTION` with no broker call.
* Reports EA version `1.32`. **Needs a MetaEditor compile** before release (the
  offline C++ harness `mt5-bridge/tests/run_demo_core.py` compiles the core for
  v1.31 and v1.32; it is not a MetaEditor check).

**Server**

* Statuses `PLACED_DEMO` (order resting at the broker — not a position) and
  `CANCELLED_DEMO` (text column, no migration). `SENT → PLACED/CANCELLED`,
  `PLACED → FILLED/CANCELLED/FAILED`. Position readers keep reading `FILLED_DEMO`
  only; the risk governor counts a `PLACED_DEMO` order as pending exposure. When the
  EA position snapshot shows a position under a placed order's ticket
  (`applyOwnPositionSnapshot`), the row becomes `FILLED_DEMO`
  (`PENDING_ORDER_FILLED_AT_BROKER`) and is tracked like any governed fill.
* Version gate: `PLACE_PENDING_ORDER` / `CANCEL_PENDING_ORDER` need EA ≥ 1.32
  (`DEMO_COMMAND_MIN_EA_VERSION`), checked at draft and again at dispatch; every
  other demo command keeps `EA_MIN_DEMO_VERSION` 1.26.
* Draft validation (`lib/mt5/demoPendingOrder.ts`) uses the server MT5 rules
  (`pendingOrderRules.ts`); a cancel may only name the trader's own `PLACED_DEMO`
  order. `GET /api/me/demo-pending-orders` lists them (user-scoped); the dashboard's
  Open Demo Positions card shows a **Pending orders** section with Cancel.
* The trade pipeline emits `entry`, `stopLimitPrice`, `expirationEpoch` for DEMO
  and for the LIVE pending draft (the v154 mirror forwards them).
* Poll: oldest-sent first, `secondsUntilExpiry` / `expiresAtEpoch` per command
  (TTL 120 s), expired rows not served. A server interval (30 s, unref'd;
  `ARX_DEMO_EXPIRY_SWEEP_ENABLED=false` opts out) FAILs rows with no EA result
  after TTL + 60 s grace (`EXPIRED_DEMO_NO_EA_RESULT`). A broker success that
  arrives after that is recorded and flagged (`LATE_RESULT_AFTER_EXPIRY`,
  `brokerRawResult.lateAfterExpiry`) instead of a 409.
* `/api/mt5/demo-command-result` matches the command's `bridgeConnectionId` to the
  reporting connection as well as the user.

**v154 Universal Agent → 1.55** (edited in place): pending orders run
`RunPreflight`, prices tick-normalised, UTC expiry → server time, retcode PLACED
accepted; pending modify keeps the order's expiry / price / stop-limit when not
given; `CLOSE_POSITION` closes `lot` when it is smaller than the position
(`PositionClosePartial`, volume-step checked). Needs a MetaEditor compile.

Tests: `pnpm --filter @workspace/api-server run test:demo-pending-orders`,
`test:mt5-demo-ea` (C++ harness), dashboard `test:mt5-order-controls`.
