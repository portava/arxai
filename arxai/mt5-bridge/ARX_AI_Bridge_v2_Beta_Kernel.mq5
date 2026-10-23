//+------------------------------------------------------------------+
//|  ARX_AI_Bridge_v2_Beta_Kernel.mq5                                |
//|  ARX AI — Bridge v2 Beta Kernel (broker-truth EVENT producer)    |
//|                                                                  |
//|  This is a SEPARATE, new EA — it does NOT replace or edit the    |
//|  working v1.50 universal agent. It is the launch-beta foundation |
//|  for Bridge v2: it turns the MT5 terminal from a snapshot/poll   |
//|  client into a sequenced, idempotent, broker-truth EVENT source. |
//|                                                                  |
//|  Every message carries the v2 envelope (protocolVersion=2,       |
//|  messageType, streamKey, monotonic per-stream sequence,          |
//|  idempotencyKey, eaCreatedAtEpochMs, eaVersion) and is POSTed to |
//|  POST /api/bridge/v2/ingest with the per-user bridge token. The  |
//|  wire shape matches lib/domain/src/bridge-v2/messageContract.ts  |
//|  field-by-field so validateBridgeV2Message() passes on contact.  |
//|                                                                  |
//|  ─────────────────────────────────────────────────────────────  |
//|  EXECUTION TRUTH — NON-NEGOTIABLE (mirrors v1.50)               |
//|    * The EA NEVER reports success it did not get from MT5.        |
//|    * "received by EA" is NOT "executed". COMMAND_RESULT.outcome   |
//|      is EXECUTED only with a real broker ticket from CTrade.      |
//|    * Anything not implemented is reported honestly, never faked.  |
//|                                                                  |
//|  SAFETY ARM INPUTS (DO NOT WEAKEN DEFAULTS):                     |
//|    ReadOnlyMode        = true   (ARM #1)                          |
//|    AllowOrderExecution = false  (ARM #2 — OrderSend gate)         |
//|    AllowPositionClose  = false  (ARM #3 — close/partial)          |
//|  Effective live gate = (!ReadOnlyMode && AllowOrderExecution &&   |
//|  remoteExecAllowed). Remote config can only PARTICIPATE in        |
//|  enabling and only TIGHTEN caps — it can never override the local |
//|  ARM inputs. With defaults locked, no remote config can make the  |
//|  EA send a single order.                                          |
//+------------------------------------------------------------------+
#property copyright "ARX AI"
#property version   "2.00"
#property strict
#property description "ARX AI Bridge v2 Beta Kernel — sequenced, idempotent broker-truth event producer (safe defaults, read-only)."

#include <Trade\Trade.mqh>

//─── Connection inputs ─────────────────────────────────────────────
input string  BridgeBaseUrl                 = "";    // e.g. https://your.replit.app (no trailing slash)
input string  BridgeToken                   = "";    // X-MT5-Bridge-Token (per-user token from MT5 Setup)

//─── Stream cadence (seconds) ──────────────────────────────────────
input int     HeartbeatIntervalSeconds      = 15;
input int     AccountSnapshotIntervalSeconds= 10;
input int     BookSnapshotIntervalSeconds   = 10;    // positions + pending sweep
input int     ConfigPollIntervalSeconds     = 30;    // remote-config manifest pull
input int     CommandPollIntervalSeconds    = 5;     // v2 command poll

//─── Market-data streams ───────────────────────────────────────────
input bool    EnableTickStream              = false; // opt-in (can be high volume)
input int     TickStreamMinIntervalMs       = 1000;  // throttle TICK pushes
input bool    EnableCandleStream            = true;  // closed bars only (low volume)

//─── Safety ARM inputs (locked off by default) ─────────────────────
input bool    ReadOnlyMode                  = true;  // ARM #1
input bool    AllowOrderExecution           = false; // ARM #2 — OrderSend at all
input bool    AllowPositionClose            = false; // ARM #3 — close/partial
input double  MaxLiveLot                     = 0.01; // hard per-trade lot ceiling

//─── Execution tuning ──────────────────────────────────────────────
input ulong   MagicNumber                   = 73154788; // ARX v2-tagged trades
input int     MaxSlippagePoints             = 30;
input int     CommandExpirySeconds          = 120;   // reject commands older than this

//─── Globals ───────────────────────────────────────────────────────
CTrade        trade;
string        EA_VERSION   = "2.00";
string        EA_NAME      = "ARX_AI_Bridge_v2_Beta_Kernel";
string        gInstanceId  = "";     // unique per EA load (for idempotency keys)
long          gIdemCounter = 0;       // monotonic, per-connection idempotency source

datetime      lastHeartbeatAt   = 0;
datetime      lastAccountAt     = 0;
datetime      lastBookAt        = 0;
datetime      lastConfigPollAt  = 0;
datetime      lastCommandPollAt = 0;
uint          lastTickPostMs    = 0;
datetime      lastBarTime       = 0;

//─── Remote-config state (default-locked) ──────────────────────────
long          gConfigVersion   = -1;     // -1 = none applied yet
bool          gRemoteExecAllowed= false; // remote permission flag (NEVER overrides local ARM)
double        gRemoteMaxLiveLot = 0.0;   // remote cap (0 = unset)

//─── Per-stream sequence registry (msgType#streamKey -> next seq) ───
#define MAX_STREAMS 128
string        gStreamKeys[MAX_STREAMS];
long          gStreamSeq[MAX_STREAMS];
int           gStreamCount = 0;

//─── Inbound command idempotency ring ──────────────────────────────
#define CMD_RING 256
string        gSeenCmd[CMD_RING];
int           gSeenHead  = 0;
int           gSeenCount = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(MaxSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   // Unique-per-load instance id seeds globally-unique idempotency keys.
   MathSrand((int)(TimeLocal() + GetTickCount()));
   gInstanceId = StringFormat("arxv2-%08x-%08x",
                              (uint)(TimeLocal() ^ GetTickCount()),
                              (uint)((MathRand() << 16) ^ MathRand()));

   ArrayInitialize(gStreamSeq, 0);
   for(int i = 0; i < MAX_STREAMS; i++) gStreamKeys[i] = "";
   for(int j = 0; j < CMD_RING; j++)    gSeenCmd[j]    = "";

   PrintFormat("ARX Bridge v2 Beta Kernel v%s loaded. instance=%s ReadOnly=%s Exec=%s Close=%s MaxLot=%.2f",
               EA_VERSION, gInstanceId, (string)ReadOnlyMode, (string)AllowOrderExecution,
               (string)AllowPositionClose, MaxLiveLot);

   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) {
      Print("ARX Bridge v2 — BridgeBaseUrl or BridgeToken missing; EA will idle until configured.");
      EventSetTimer(1);
      return INIT_SUCCEEDED;
   }

   // Announce identity + per-symbol contract spec immediately on attach.
   SendHeartbeat();      lastHeartbeatAt = TimeCurrent();
   PushSymbolSpec(_Symbol);
   lastBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);

   EventSetTimer(1);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) return;
   datetime now = TimeCurrent();

   if(now - lastHeartbeatAt   >= HeartbeatIntervalSeconds)       { SendHeartbeat();        lastHeartbeatAt   = now; }
   if(now - lastAccountAt     >= AccountSnapshotIntervalSeconds) { PushAccountSnapshot();  lastAccountAt     = now; }
   if(now - lastBookAt        >= BookSnapshotIntervalSeconds)    { PushPositionsSnapshot(); PushOrdersSnapshot(); lastBookAt = now; }
   if(now - lastConfigPollAt  >= ConfigPollIntervalSeconds)      { PollRemoteConfig();     lastConfigPollAt  = now; }
   if(now - lastCommandPollAt >= CommandPollIntervalSeconds)     { PollCommands();         lastCommandPollAt = now; }
}

//+------------------------------------------------------------------+
//|  OnTick — opt-in TICK stream + new-bar CANDLE detection.         |
//+------------------------------------------------------------------+
void OnTick()
{
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) return;

   // CANDLE: push the just-closed bar exactly once when a new bar opens.
   datetime barTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(barTime != lastBarTime && lastBarTime != 0) {
      if(EnableCandleStream) PushClosedCandle(_Symbol, PERIOD_CURRENT);
   }
   lastBarTime = barTime;

   // TICK: throttled, opt-in.
   if(EnableTickStream) {
      uint nowMs = GetTickCount();
      if(nowMs - lastTickPostMs >= (uint)TickStreamMinIntervalMs) {
         PushTick(_Symbol);
         lastTickPostMs = nowMs;
      }
   }
}

//+------------------------------------------------------------------+
//|  OnTradeTransaction — the core v2 upgrade. Broker-confirmed       |
//|  order/deal events, not poll-inferred state.                     |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest     &request,
                        const MqlTradeResult      &result)
{
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) return;

   string txType = TransTypeName(trans.type);

   // Push the transaction event itself (truth: a dealTicket on DEAL_ADD is a
   // confirmed fill; REQUEST/ORDER_ADD are received/accepted, NOT a fill).
   string symbol      = (StringLen(trans.symbol) > 0) ? StringSubstr(trans.symbol, 0, 32) : "";
   string orderTk     = (trans.order    > 0) ? StringFormat("%I64u", trans.order)    : "";
   string dealTk      = (trans.deal     > 0) ? StringFormat("%I64u", trans.deal)     : "";
   string positionTk  = (trans.position > 0) ? StringFormat("%I64u", trans.position) : "";

   string p = "{";
   p += "\"transactionType\":\"" + txType + "\",";
   p += "\"symbol\":"         + (StringLen(symbol) > 0 ? JsonEscape(symbol) : "null") + ",";
   p += "\"orderTicket\":"    + (StringLen(orderTk) > 0 ? ("\"" + orderTk + "\"") : "null") + ",";
   p += "\"dealTicket\":"     + (StringLen(dealTk) > 0 ? ("\"" + dealTk + "\"") : "null") + ",";
   p += "\"positionTicket\":" + (StringLen(positionTk) > 0 ? ("\"" + positionTk + "\"") : "null") + ",";
   p += "\"volume\":"  + SafeF(trans.volume, 4) + ",";
   p += "\"price\":"   + SafeF(trans.price, 5) + ",";
   p += "\"retcode\":" + (string)((long)trans.type == (long)TRADE_TRANSACTION_REQUEST ? (long)result.retcode : 0) + ",";
   p += "\"brokerComment\":null,";
   p += "\"arxCommandId\":null";
   p += "}";
   PostV2("TRADE_TRANSACTION", "default", p);

   // DEAL_HISTORY: emit realised-P/L truth on a closing deal only.
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD && trans.deal > 0)
      MaybePushDealHistory(trans.deal);
}

//+------------------------------------------------------------------+
//|  HEARTBEAT — identity, terminal readiness, capabilities.         |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   bool termConnected    = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   bool termTradeAllowed = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   bool mqlTradeAllowed  = (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
   bool algoAllowed      = (termTradeAllowed && mqlTradeAllowed);
   bool effExec          = EffectiveExecAllowed();
   string accountType    = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL) ? "live" : "demo";

   string eaInputs = "{";
   eaInputs += "\"enableLiveExecution\":" + (AllowOrderExecution ? "true" : "false") + ",";
   eaInputs += "\"readOnlyMode\":"        + (ReadOnlyMode ? "true" : "false") + ",";
   eaInputs += "\"maxLiveLot\":"          + SafeF(EffectiveMaxLot(), 2);
   eaInputs += "}";

   // capabilities: record<string, boolean> — boolean values ONLY.
   string caps = "{";
   caps += "\"heartbeat\":true,\"accountSnapshot\":true,\"positionsSnapshot\":true,";
   caps += "\"ordersSnapshot\":true,\"tradeTransactionEvents\":true,\"dealHistory\":true,";
   caps += "\"tickStream\":"  + (EnableTickStream  ? "true" : "false") + ",";
   caps += "\"candleStream\":" + (EnableCandleStream ? "true" : "false") + ",";
   caps += "\"commandResult\":true,\"remoteConfig\":true,\"symbolSpec\":true,\"errorReport\":true,";
   caps += "\"liveExecution\":" + (effExec ? "true" : "false");
   caps += "}";

   string payload = "{";
   payload += "\"accountType\":\""        + accountType + "\",";
   payload += "\"terminalConnected\":"    + (termConnected ? "true" : "false") + ",";
   payload += "\"algoTradingAllowed\":"   + (algoAllowed ? "true" : "false") + ",";
   payload += "\"eaInputs\":"             + eaInputs + ",";
   payload += "\"capabilities\":"         + caps;
   payload += "}";
   PostV2("HEARTBEAT", "default", payload);

   // Operator-actionable setup problems → honest ERROR_REPORT (non-fatal).
   if(!algoAllowed)
      PushError("ALGO_TRADING_DISABLED",
                "AutoTrading is off, so the bridge cannot execute even when armed.",
                "Click the AutoTrading button in the MT5 toolbar (and tick 'Allow Algo Trading' in the EA Common tab).",
                false);
   else if(!termConnected)
      PushError("TERMINAL_DISCONNECTED",
                "The MT5 terminal is not connected to the broker server.",
                "Check the connection indicator in the bottom-right of MT5.",
                false);
}

//+------------------------------------------------------------------+
//|  ACCOUNT_SNAPSHOT                                                 |
//+------------------------------------------------------------------+
void PushAccountSnapshot()
{
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   double mg  = AccountInfoDouble(ACCOUNT_MARGIN);
   double fm  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double ml  = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   string ccy = AccountInfoString(ACCOUNT_CURRENCY);
   if(StringLen(ccy) == 0) ccy = "USD";

   // marginLevel is nonneg|null — null when no positions / non-finite.
   string mlField = (mg > 0 && MathIsValidNumber(ml) && ml >= 0) ? SafeF(ml, 2) : "null";
   // brokerTimeEpochMs is int>0|null — emit null when the server time is unknown
   // (e.g. disconnected ⇒ TimeTradeServer()==0), never a non-positive 0.
   long brokerMs = (long)TimeTradeServer() * 1000;
   string brokerMsField = (brokerMs > 0) ? (string)brokerMs : "null";

   string payload = "{";
   payload += "\"balance\":"    + SafeF(bal, 2) + ",";
   payload += "\"equity\":"     + SafeF(eq, 2) + ",";
   payload += "\"margin\":"     + SafeF(mg < 0 ? 0 : mg, 2) + ",";
   payload += "\"freeMargin\":" + SafeF(fm, 2) + ",";
   payload += "\"marginLevel\":"+ mlField + ",";
   payload += "\"currency\":\"" + StringSubstr(ccy, 0, 8) + "\",";
   payload += "\"brokerTimeEpochMs\":" + brokerMsField;
   payload += "}";
   PostV2("ACCOUNT_SNAPSHOT", "default", payload);
}

//+------------------------------------------------------------------+
//|  POSITIONS_SNAPSHOT — full sweep (empty array is a real fact).   |
//+------------------------------------------------------------------+
void PushPositionsSnapshot()
{
   string arr = "[";
   int n = PositionsTotal();
   bool first = true;
   for(int i = 0; i < n; i++) {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(!PositionSelectByTicket(tk)) continue;

      double vol = PositionGetDouble(POSITION_VOLUME);
      double op  = PositionGetDouble(POSITION_PRICE_OPEN);
      if(vol <= 0 || op <= 0) continue; // would fail Zod (positive required)

      string sym = PositionGetString(POSITION_SYMBOL);
      bool   buy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double cur = buy ? SymbolInfoDouble(sym, SYMBOL_BID) : SymbolInfoDouble(sym, SYMBOL_ASK);
      double sl  = PositionGetDouble(POSITION_SL);
      double tp  = PositionGetDouble(POSITION_TP);

      if(!first) arr += ",";
      first = false;
      arr += "{";
      arr += "\"brokerTicket\":\"" + StringFormat("%I64u", tk) + "\",";
      arr += "\"symbol\":\""       + StringSubstr(sym, 0, 32) + "\",";
      arr += "\"side\":\""         + (buy ? "BUY" : "SELL") + "\",";
      arr += "\"volume\":"         + SafeF(vol, 4) + ",";
      arr += "\"openPrice\":"      + SafeF(op, 5) + ",";
      arr += "\"currentPrice\":"   + ((MathIsValidNumber(cur) && cur >= 0) ? SafeF(cur, 5) : "null") + ",";
      arr += "\"stopLoss\":"       + (sl > 0 ? SafeF(sl, 5) : "null") + ",";
      arr += "\"takeProfit\":"     + (tp > 0 ? SafeF(tp, 5) : "null") + ",";
      arr += "\"floatingPl\":"     + SafeF(PositionGetDouble(POSITION_PROFIT), 2) + ",";
      arr += "\"openedAtEpochMs\":"+ (string)((long)PositionGetInteger(POSITION_TIME) * 1000);
      arr += "}";
   }
   arr += "]";

   string payload = "{\"positions\":" + arr + ",\"sweepComplete\":true}";
   PostV2("POSITIONS_SNAPSHOT", "default", payload);
}

//+------------------------------------------------------------------+
//|  ORDERS_SNAPSHOT — full pending sweep.                           |
//+------------------------------------------------------------------+
void PushOrdersSnapshot()
{
   string arr = "[";
   int n = OrdersTotal();
   bool first = true;
   for(int i = 0; i < n; i++) {
      ulong tk = OrderGetTicket(i);
      if(tk == 0) continue;

      double vol = OrderGetDouble(ORDER_VOLUME_CURRENT);
      if(vol <= 0) continue; // would fail Zod (positive required)

      string sym = OrderGetString(ORDER_SYMBOL);
      double price = OrderGetDouble(ORDER_PRICE_OPEN);
      double sl = OrderGetDouble(ORDER_SL);
      double tp = OrderGetDouble(ORDER_TP);

      if(!first) arr += ",";
      first = false;
      arr += "{";
      arr += "\"brokerTicket\":\"" + StringFormat("%I64u", tk) + "\",";
      arr += "\"symbol\":\""       + StringSubstr(sym, 0, 32) + "\",";
      arr += "\"orderType\":\""    + OrderTypeName((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)) + "\",";
      arr += "\"volume\":"         + SafeF(vol, 4) + ",";
      arr += "\"price\":"          + SafeF(price < 0 ? 0 : price, 5) + ",";
      arr += "\"stopLoss\":"       + (sl > 0 ? SafeF(sl, 5) : "null") + ",";
      arr += "\"takeProfit\":"     + (tp > 0 ? SafeF(tp, 5) : "null");
      arr += "}";
   }
   arr += "]";

   string payload = "{\"orders\":" + arr + ",\"sweepComplete\":true}";
   PostV2("ORDERS_SNAPSHOT", "default", payload);
}

//+------------------------------------------------------------------+
//|  TICK                                                            |
//+------------------------------------------------------------------+
void PushTick(const string symbol)
{
   MqlTick t;
   if(!SymbolInfoTick(symbol, t)) return;
   if(t.bid <= 0 || t.ask <= 0) return; // positive required by contract
   long tEpochMs = (t.time_msc > 0) ? t.time_msc : ((long)TimeTradeServer() * 1000);
   if(tEpochMs <= 0) tEpochMs = NowEpochMs();

   string payload = "{";
   payload += "\"symbol\":\""          + StringSubstr(symbol, 0, 32) + "\",";
   payload += "\"bid\":"               + SafeF(t.bid, 5) + ",";
   payload += "\"ask\":"               + SafeF(t.ask, 5) + ",";
   payload += "\"brokerTimeEpochMs\":" + (string)tEpochMs;
   payload += "}";
   PostV2("TICK", StringSubstr(symbol, 0, 32), payload);
}

//+------------------------------------------------------------------+
//|  CANDLE — only the just-closed bar (index 1).                   |
//+------------------------------------------------------------------+
void PushClosedCandle(const string symbol, ENUM_TIMEFRAMES tf)
{
   MqlRates r[];
   if(CopyRates(symbol, tf, 1, 1, r) != 1) return; // index 1 = last CLOSED bar
   if(r[0].open <= 0 || r[0].high <= 0 || r[0].low <= 0 || r[0].close <= 0) return;

   string tfName = TimeframeName(tf);
   string payload = "{";
   payload += "\"symbol\":\""       + StringSubstr(symbol, 0, 32) + "\",";
   payload += "\"timeframe\":\""    + tfName + "\",";
   payload += "\"openTimeEpochMs\":"+ (string)((long)r[0].time * 1000) + ",";
   payload += "\"open\":"  + SafeF(r[0].open, 5) + ",";
   payload += "\"high\":"  + SafeF(r[0].high, 5) + ",";
   payload += "\"low\":"   + SafeF(r[0].low, 5) + ",";
   payload += "\"close\":" + SafeF(r[0].close, 5) + ",";
   payload += "\"volume\":"+ (string)(long)r[0].tick_volume + ",";
   payload += "\"isClosed\":true";
   payload += "}";
   PostV2("CANDLE", StringSubstr(symbol, 0, 32) + "|" + tfName, payload);
}

//+------------------------------------------------------------------+
//|  SYMBOL_SPEC                                                      |
//+------------------------------------------------------------------+
void PushSymbolSpec(const string symbol)
{
   double cs   = SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double minL = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(cs <= 0 || minL <= 0 || maxL <= 0 || step <= 0) return; // positive required

   long   digits = SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double tv     = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);

   string payload = "{";
   payload += "\"symbol\":\""     + StringSubstr(symbol, 0, 32) + "\",";
   payload += "\"digits\":"       + (string)(digits < 0 ? 0 : digits) + ",";
   payload += "\"contractSize\":" + SafeF(cs, 2) + ",";
   payload += "\"minLot\":"       + SafeF(minL, 4) + ",";
   payload += "\"maxLot\":"       + SafeF(maxL, 4) + ",";
   payload += "\"lotStep\":"      + SafeF(step, 4) + ",";
   payload += "\"tickValue\":"    + ((MathIsValidNumber(tv) && tv >= 0) ? SafeF(tv, 5) : "null");
   payload += "}";
   PostV2("SYMBOL_SPEC", StringSubstr(symbol, 0, 32), payload);
}

//+------------------------------------------------------------------+
//|  ERROR_REPORT                                                     |
//+------------------------------------------------------------------+
void PushError(const string code, const string message, const string hint, bool fatal)
{
   string payload = "{";
   payload += "\"code\":\""    + StringSubstr(code, 0, 64) + "\",";
   payload += "\"message\":"   + JsonEscape(StringSubstr(message, 0, 512)) + ",";
   payload += "\"operatorHint\":" + (StringLen(hint) > 0 ? JsonEscape(StringSubstr(hint, 0, 512)) : "null") + ",";
   payload += "\"fatal\":"     + (fatal ? "true" : "false");
   payload += "}";
   PostV2("ERROR_REPORT", "default", payload);
}

//+------------------------------------------------------------------+
//|  DEAL_HISTORY — realised-P/L truth on a closing deal.           |
//+------------------------------------------------------------------+
void MaybePushDealHistory(ulong dealTicket)
{
   // Load a recent history window so the deal fields are available.
   if(!HistorySelect(TimeCurrent() - 7 * 86400, TimeCurrent() + 60)) return;

   long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
   // Only realised legs carry P/L truth. Opening deals (DEAL_ENTRY_IN) are
   // covered by TRADE_TRANSACTION; do not fabricate a realised close for them.
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) return;

   double vol   = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
   double price = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
   if(vol <= 0 || price <= 0) return; // positive required by contract

   long   dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
   string side     = (dealType == DEAL_TYPE_BUY) ? "BUY" : "SELL";
   string sym      = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
   if(StringLen(sym) == 0) return;
   long   posId    = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   double profit   = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
   double commis   = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
   double swap     = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
   long   closedAt = (long)HistoryDealGetInteger(dealTicket, DEAL_TIME) * 1000;
   if(closedAt <= 0) closedAt = NowEpochMs();

   string payload = "{";
   payload += "\"dealTicket\":\""    + StringFormat("%I64u", dealTicket) + "\",";
   payload += "\"positionTicket\":"  + (posId > 0 ? ("\"" + StringFormat("%I64d", posId) + "\"") : "null") + ",";
   payload += "\"symbol\":\""        + StringSubstr(sym, 0, 32) + "\",";
   payload += "\"side\":\""          + side + "\",";
   payload += "\"volume\":"          + SafeF(vol, 4) + ",";
   payload += "\"price\":"           + SafeF(price, 5) + ",";
   payload += "\"profit\":"          + SafeF(profit, 2) + ",";
   payload += "\"commission\":"      + SafeF(commis, 2) + ",";
   payload += "\"swap\":"            + SafeF(swap, 2) + ",";
   payload += "\"closedAtEpochMs\":" + (string)closedAt;
   payload += "}";
   PostV2("DEAL_HISTORY", "default", payload);
}

//+------------------------------------------------------------------+
//|  REMOTE CONFIG — pull manifest, apply (tighten-only), ACK.       |
//|  Backend gap: GET /api/bridge/v2/config (built in backend task). |
//|  Missing/empty response ⇒ stays locked. Remote config can NEVER  |
//|  override the local ARM inputs — it can only participate in       |
//|  enabling and only tighten caps.                                 |
//+------------------------------------------------------------------+
void PollRemoteConfig()
{
   string resp = GetJson("/api/bridge/v2/config");
   if(StringLen(resp) == 0) return; // not built yet / nothing to apply → stay locked

   long ver = JsonLong(resp, "configVersion");
   if(ver < 0) return;
   if(ver <= gConfigVersion) return; // already applied (or older)

   gRemoteExecAllowed = (JsonStr(resp, "executionAllowed") == "true");
   double remoteLot   = JsonNum(resp, "maxLiveLot");
   gRemoteMaxLiveLot  = (remoteLot > 0 ? remoteLot : 0.0);
   gConfigVersion     = ver;

   PrintFormat("ARX Bridge v2 — applied remote config v%I64d (remoteExec=%s remoteMaxLot=%.2f effExec=%s)",
               ver, (string)gRemoteExecAllowed, gRemoteMaxLiveLot, (string)EffectiveExecAllowed());

   // Acknowledge the applied version.
   string payload = "{\"appliedConfigVersion\":" + (string)ver + "}";
   PostV2("CONFIG_ACK", "default", payload);
}

//+------------------------------------------------------------------+
//|  COMMAND POLL — whitelist-restricted, gated, honest results.     |
//|  Backend gap: GET /api/bridge/v2/commands (built in backend      |
//|  task). Results are emitted as COMMAND_RESULT v2 messages.       |
//+------------------------------------------------------------------+
void PollCommands()
{
   string resp = GetJson("/api/bridge/v2/commands");
   if(StringLen(resp) == 0) return;

   int pos = 0;
   while(true) {
      int s = StringFind(resp, "\"arxCommandId\":", pos);
      if(s < 0) s = StringFind(resp, "\"action\":", pos); // fall back to action delimiter
      if(s < 0) break;
      int sliceEnd = StringFind(resp, "},{", s);
      if(sliceEnd < 0) sliceEnd = StringFind(resp, "}]", s);
      if(sliceEnd < 0) sliceEnd = StringLen(resp);
      string slice = StringSubstr(resp, s, sliceEnd - s + 1);
      pos = sliceEnd + 1;
      HandleCommand(slice);
   }
}

//+------------------------------------------------------------------+
//|  Per-command dispatcher. Gate order:                             |
//|   idempotency → whitelist → expiry → ARM → remote-exec →         |
//|   entry-confirmation → lot cap → execute.                        |
//+------------------------------------------------------------------+
void HandleCommand(const string slice)
{
   string cmdId = JsonStr(slice, "arxCommandId");
   if(StringLen(cmdId) == 0) cmdId = JsonStr(slice, "id");
   if(StringLen(cmdId) == 0) return; // arxCommandId is required by the contract
   string action = JsonStr(slice, "action");

   // ── Idempotency: never act on the same command twice ──
   if(WasCmdSeen(cmdId)) {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0, "Duplicate command ignored (idempotency).");
      return;
   }

   // ── Whitelist (hard-coded) ──
   if(!IsWhitelisted(action)) {
      RememberCmd(cmdId);
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0, "Action not in bridge whitelist: " + action);
      return;
   }

   // ── Expiry: reject stale commands ──
   long createdAtEpoch = JsonLong(slice, "createdAtEpoch");
   if(createdAtEpoch > 0) {
      long ageSec = (long)TimeGMT() - createdAtEpoch;
      if(ageSec > CommandExpirySeconds) {
         RememberCmd(cmdId);
         PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0,
            StringFormat("Command expired (age %I64ds > %ds).", ageSec, CommandExpirySeconds));
         return;
      }
   }

   // ── ARM gate (ReadOnly / AllowOrderExecution) ──
   if(ReadOnlyMode || !AllowOrderExecution) {
      RememberCmd(cmdId);
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0,
         "Live execution is switched off on the bridge (ReadOnlyMode/AllowOrderExecution).");
      return;
   }

   // ── Remote-exec gate (env+remote must also allow) ──
   if(!gRemoteExecAllowed) {
      RememberCmd(cmdId);
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0,
         "Remote config has not enabled execution for this bridge.");
      return;
   }

   RememberCmd(cmdId);

   // ── Execution handlers (only OPEN_MARKET / CLOSE_POSITION in this kernel) ──
   if(action == "OPEN_MARKET")        HandleOpenMarket(cmdId, slice);
   else if(action == "CLOSE_POSITION") HandleClosePosition(cmdId, slice);
   else
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0,
         "Whitelisted but not implemented in the beta kernel: " + action);
}

//+------------------------------------------------------------------+
void HandleOpenMarket(const string cmdId, const string slice)
{
   bool confirm = (JsonStr(slice, "confirmedByUser") == "true");
   if(!confirm) {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0, "Entry not confirmed by user.");
      return;
   }
   string sym  = JsonStr(slice, "symbol");
   string side = JsonStr(slice, "side");
   double vol  = JsonNum(slice, "volume");
   double sl   = JsonNum(slice, "stopLoss");
   double tp   = JsonNum(slice, "takeProfit");

   // Strict side enum: reject anything that is not exactly BUY/SELL. NEVER
   // default an unknown/empty side to a direction — that would place an
   // unintended order once the ARM + remote gates are open.
   if(side != "BUY" && side != "SELL") {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0,
         "Invalid side (must be exactly BUY or SELL): " + side);
      return;
   }

   double cap = EffectiveMaxLot();
   if(vol <= 0 || vol > cap) {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0,
         StringFormat("Volume %.4f outside bridge cap (0 < lot <= %.2f).", vol, cap));
      return;
   }
   if(StringLen(sym) == 0 || !SymbolSelect(sym, true)) {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0, "Unknown/unavailable symbol: " + sym);
      return;
   }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetTypeFillingBySymbol(sym);
   bool ok = (side == "SELL")
      ? trade.Sell(vol, sym, 0.0, sl, tp, "ARX-v2")
      : trade.Buy(vol, sym, 0.0, sl, tp, "ARX-v2");

   long   retcode = (long)trade.ResultRetcode();
   ulong  order   = trade.ResultOrder();
   ulong  deal    = trade.ResultDeal();
   double fillP   = trade.ResultPrice();
   double fillV   = trade.ResultVolume();

   // EXECUTION TRUTH: report EXECUTED only with a real broker ticket.
   if(ok && (order > 0 || deal > 0)) {
      string brokerTk = (order > 0) ? StringFormat("%I64u", order) : StringFormat("%I64u", deal);
      string dealTk   = (deal  > 0) ? StringFormat("%I64u", deal)  : "";
      PostCommandResult(cmdId, "EXECUTED", brokerTk, dealTk, fillV, fillP, retcode, trade.ResultComment());
   } else {
      PostCommandResult(cmdId, "FAILED", "", "", -1, -1, retcode,
         "OrderSend did not return a ticket: " + trade.ResultComment());
   }
}

//+------------------------------------------------------------------+
void HandleClosePosition(const string cmdId, const string slice)
{
   if(!AllowPositionClose) {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0, "Position close is disarmed on the bridge (ARM #3).");
      return;
   }
   string tkStr = JsonStr(slice, "brokerTicket");
   if(StringLen(tkStr) == 0) tkStr = JsonStr(slice, "ticket");
   ulong tk = (ulong)StringToInteger(tkStr);
   if(tk == 0 || !PositionSelectByTicket(tk)) {
      PostCommandResult(cmdId, "REJECTED", "", "", -1, -1, 0, "Position not found for ticket: " + tkStr);
      return;
   }

   bool ok = trade.PositionClose(tk);
   long retcode = (long)trade.ResultRetcode();
   ulong deal   = trade.ResultDeal();
   if(ok && deal > 0) {
      PostCommandResult(cmdId, "EXECUTED", tkStr, StringFormat("%I64u", deal),
                        trade.ResultVolume(), trade.ResultPrice(), retcode, trade.ResultComment());
   } else {
      PostCommandResult(cmdId, "FAILED", "", "", -1, -1, retcode,
         "PositionClose did not confirm: " + trade.ResultComment());
   }
}

//+------------------------------------------------------------------+
//|  COMMAND_RESULT emitter (negative fill values ⇒ null).          |
//+------------------------------------------------------------------+
void PostCommandResult(const string arxCommandId, const string outcome,
                       const string brokerTicket, const string dealTicket,
                       double filledVolume, double fillPrice, long retcode,
                       const string brokerMessage)
{
   string payload = "{";
   payload += "\"arxCommandId\":\"" + StringSubstr(arxCommandId, 0, 64) + "\",";
   payload += "\"outcome\":\""      + outcome + "\",";
   payload += "\"brokerTicket\":"   + (StringLen(brokerTicket) > 0 ? ("\"" + StringSubstr(brokerTicket, 0, 64) + "\"") : "null") + ",";
   payload += "\"dealTicket\":"     + (StringLen(dealTicket) > 0 ? ("\"" + StringSubstr(dealTicket, 0, 64) + "\"") : "null") + ",";
   payload += "\"filledVolume\":"   + (filledVolume >= 0 ? SafeF(filledVolume, 4) : "null") + ",";
   payload += "\"fillPrice\":"      + (fillPrice >= 0 ? SafeF(fillPrice, 5) : "null") + ",";
   payload += "\"retcode\":"        + (retcode != 0 ? (string)retcode : "null") + ",";
   payload += "\"brokerMessage\":"  + (StringLen(brokerMessage) > 0 ? JsonEscape(StringSubstr(brokerMessage, 0, 256)) : "null");
   payload += "}";
   PostV2("COMMAND_RESULT", "default", payload);
}

//+------------------------------------------------------------------+
//|  ENVELOPE + TRANSPORT                                             |
//+------------------------------------------------------------------+
// Build the full v2 envelope around a payload and POST it. Single retry on
// transport failure reuses the SAME sequence + idempotencyKey so the server
// dedupes (never double-records). Returns true on HTTP 200.
bool PostV2(const string messageType, const string streamKey, const string payloadJson)
{
   long   seq  = NextSequence(messageType, streamKey);
   string idem = NextIdempotencyKey();
   long   nowMs= NowEpochMs();

   string env = "{";
   env += "\"protocolVersion\":2,";
   env += "\"messageType\":\""      + messageType + "\",";
   env += "\"streamKey\":\""        + StringSubstr(streamKey, 0, 64) + "\",";
   env += "\"sequence\":"           + (string)seq + ",";
   env += "\"idempotencyKey\":\""   + idem + "\",";
   env += "\"eaCreatedAtEpochMs\":" + (string)nowMs + ",";
   env += "\"eaVersion\":\""        + EA_VERSION + "\",";
   env += "\"payload\":"            + payloadJson;
   env += "}";

   int code = PostJsonRaw("/api/bridge/v2/ingest", env);
   if(code != 200) code = PostJsonRaw("/api/bridge/v2/ingest", env); // idempotent retry
   return code == 200;
}

// Monotonic per-(messageType, streamKey) sequence. First call on a stream
// returns 0 (server records FIRST), then 1, 2, ... (IN_ORDER).
long NextSequence(const string messageType, const string streamKey)
{
   string key = messageType + "#" + streamKey;
   for(int i = 0; i < gStreamCount; i++) {
      if(gStreamKeys[i] == key) {
         long v = gStreamSeq[i];
         gStreamSeq[i] = v + 1;
         return v;
      }
   }
   if(gStreamCount < MAX_STREAMS) {
      gStreamKeys[gStreamCount] = key;
      gStreamSeq[gStreamCount]  = 1; // next will be 1; we return 0 now
      gStreamCount++;
      return 0;
   }
   // Registry full (should never happen): fall back to a global-ish counter.
   return gIdemCounter;
}

// Globally-unique-per-connection idempotency key (>= 8 chars, <= 128).
string NextIdempotencyKey()
{
   gIdemCounter++;
   return gInstanceId + "-" + (string)gIdemCounter;
}

// EA wall clock in UTC ms. Honest: never back-dated. Latency = serverRecv - this.
long NowEpochMs()
{
   long s = (long)TimeGMT();
   if(s <= 0) s = (long)TimeCurrent();
   return s * 1000;
}

//+------------------------------------------------------------------+
//|  Inbound command idempotency ring                                |
//+------------------------------------------------------------------+
bool WasCmdSeen(const string id)
{
   for(int i = 0; i < gSeenCount; i++)
      if(gSeenCmd[i] == id) return true;
   return false;
}
void RememberCmd(const string id)
{
   if(gSeenCount < CMD_RING) { gSeenCmd[gSeenCount] = id; gSeenCount++; }
   else { gSeenCmd[gSeenHead] = id; gSeenHead = (gSeenHead + 1) % CMD_RING; }
}

bool IsWhitelisted(const string action)
{
   return (action == "OPEN_MARKET" || action == "CLOSE_POSITION" ||
           action == "CLOSE_ALL"   || action == "MODIFY_POSITION" ||
           action == "PARTIAL_CLOSE");
}

//+------------------------------------------------------------------+
//|  Effective live gates (local ARM authoritative; remote tightens) |
//+------------------------------------------------------------------+
bool EffectiveExecAllowed()
{
   return (!ReadOnlyMode && AllowOrderExecution && gRemoteExecAllowed);
}
double EffectiveMaxLot()
{
   double cap = MaxLiveLot;
   if(gRemoteMaxLiveLot > 0 && gRemoteMaxLiveLot < cap) cap = gRemoteMaxLiveLot; // remote tightens only
   return cap;
}

//+------------------------------------------------------------------+
//|  ENUM → contract string mappers                                  |
//+------------------------------------------------------------------+
string TransTypeName(ENUM_TRADE_TRANSACTION_TYPE t)
{
   switch(t) {
      case TRADE_TRANSACTION_ORDER_ADD:      return "ORDER_ADD";
      case TRADE_TRANSACTION_ORDER_UPDATE:   return "ORDER_UPDATE";
      case TRADE_TRANSACTION_ORDER_DELETE:   return "ORDER_DELETE";
      case TRADE_TRANSACTION_DEAL_ADD:       return "DEAL_ADD";
      case TRADE_TRANSACTION_DEAL_UPDATE:    return "DEAL_UPDATE";
      case TRADE_TRANSACTION_DEAL_DELETE:    return "DEAL_DELETE";
      case TRADE_TRANSACTION_HISTORY_ADD:    return "HISTORY_ADD";
      case TRADE_TRANSACTION_HISTORY_UPDATE: return "HISTORY_UPDATE";
      case TRADE_TRANSACTION_HISTORY_DELETE: return "HISTORY_DELETE";
      case TRADE_TRANSACTION_POSITION:       return "POSITION";
      case TRADE_TRANSACTION_REQUEST:        return "REQUEST";
      default:                               return "UNKNOWN";
   }
}

string OrderTypeName(ENUM_ORDER_TYPE t)
{
   switch(t) {
      case ORDER_TYPE_BUY:            return "BUY";
      case ORDER_TYPE_SELL:           return "SELL";
      case ORDER_TYPE_BUY_LIMIT:      return "BUY_LIMIT";
      case ORDER_TYPE_SELL_LIMIT:     return "SELL_LIMIT";
      case ORDER_TYPE_BUY_STOP:       return "BUY_STOP";
      case ORDER_TYPE_SELL_STOP:      return "SELL_STOP";
      case ORDER_TYPE_BUY_STOP_LIMIT: return "BUY_STOP_LIMIT";
      case ORDER_TYPE_SELL_STOP_LIMIT:return "SELL_STOP_LIMIT";
      default:                        return "UNKNOWN";
   }
}

string TimeframeName(ENUM_TIMEFRAMES tf)
{
   switch(tf) {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_M30: return "M30";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
      case PERIOD_D1:  return "D1";
      case PERIOD_W1:  return "W1";
      case PERIOD_MN1: return "MN1";
      default:         return "M5";
   }
}

//+------------------------------------------------------------------+
//|  HTTP + JSON HELPERS (proven, reused from v1.50)                 |
//+------------------------------------------------------------------+
string GetJson(const string path)
{
   char post[]; char result[]; string respHeaders;
   string url = BridgeBaseUrl + path;
   string reqHeaders = "X-MT5-Bridge-Token: " + BridgeToken + "\r\nAccept: application/json\r\n";
   ResetLastError();
   int code = WebRequest("GET", url, reqHeaders, 10000, post, result, respHeaders);
   if(code != 200) return "";
   return CharArrayToString(result);
}

// Returns the HTTP status code (0 on transport error). Caller decides retry.
int PostJsonRaw(const string path, const string json)
{
   char post[]; char result[]; string respHeaders;
   string url = BridgeBaseUrl + path;
   // Convert the WHOLE string so StringToCharArray appends exactly one NUL and
   // returns the byte count INCLUDING it; drop ONLY that trailing NUL. (An
   // explicit count drops a real byte and chops the final "}" — see v1.50.)
   int len = StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(post, len - 1);
   string reqHeaders = "X-MT5-Bridge-Token: " + BridgeToken
                     + "\r\nContent-Type: application/json\r\nAccept: application/json\r\n";
   ResetLastError();
   int code = WebRequest("POST", url, reqHeaders, 10000, post, result, respHeaders);
   if(code != 200) PrintFormat("ARX Bridge v2 POST %s -> %d (err=%d)", path, code, GetLastError());
   return code;
}

string JsonStr(const string s, const string key)
{
   string needle = "\"" + key + "\":";
   int p = StringFind(s, needle);
   if(p < 0) return "";
   p += StringLen(needle);
   while(p < StringLen(s) && (StringGetCharacter(s, p) == ' ' || StringGetCharacter(s, p) == '\t')) p++;
   if(p >= StringLen(s)) return "";
   ushort ch = StringGetCharacter(s, p);
   if(ch == '"') {
      int e = StringFind(s, "\"", p + 1);
      if(e < 0) return "";
      return StringSubstr(s, p + 1, e - p - 1);
   }
   int e = p;
   while(e < StringLen(s)) {
      ushort c = StringGetCharacter(s, e);
      if(c == ',' || c == '}' || c == ']' || c == ' ' || c == '\n' || c == '\r') break;
      e++;
   }
   return StringSubstr(s, p, e - p);
}
double JsonNum(const string s, const string key) { string v = JsonStr(s, key); return (v == "" || v == "null") ? 0.0 : (double)StringToDouble(v); }
long   JsonLong(const string s, const string key){ string v = JsonStr(s, key); return (v == "" || v == "null") ? 0   : (long)StringToInteger(v); }

// SafeF — format a double for JSON. MQL5's StringFormat emits "inf"/"nan" for
// non-finite values which is INVALID JSON and 400s the whole body. Guard here.
string SafeF(const double v, const int digits = 2)
{
   if(!MathIsValidNumber(v)) return "0";
   return StringFormat("%.*f", digits, v);
}
string JsonEscape(const string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", "\\n");
   return "\"" + r + "\"";
}
//+------------------------------------------------------------------+
