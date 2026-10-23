//+------------------------------------------------------------------+
//|  ARX_AI_Bridge_v140_PendingOrders.mq5                            |
//|  ARX AI — Phase TU Bridge upgrade                                |
//|                                                                  |
//|  Adds vocabulary + handlers for pending-order placement,         |
//|  modification, cancellation, and open-position SL/TP             |
//|  modification. Reports a closed capability set to the backend    |
//|  on every heartbeat so the dashboard + AI assistant know         |
//|  honestly which actions this EA understands.                     |
//|                                                                  |
//|  SAFETY DEFAULTS (DO NOT WEAKEN):                                |
//|    ReadOnlyMode             = true                                |
//|    AllowOrderExecution      = false                               |
//|    AllowPendingOrders       = false                               |
//|    AllowProtectionModify    = false                               |
//|    AllowPendingCancel       = false                               |
//|                                                                  |
//|  Every order-mutating handler refuses unless BOTH:               |
//|    1. The corresponding `Allow*` input is true, AND              |
//|    2. The backend command says confirmedByUser==true.            |
//|                                                                  |
//|  If a command is refused, the EA returns status="REJECTED" with  |
//|  an errorCode and errorMessage. It NEVER returns a fake success. |
//|  Result payload always includes commandId so the backend can     |
//|  reconcile per-row.                                              |
//|                                                                  |
//|  Supported actions (case-sensitive):                             |
//|    DEMO_MARKET_ORDER          (preserved from v1.30)             |
//|    PLACE_MARKET_ORDER         (BUY/SELL with SL/TP)              |
//|    PLACE_PENDING_ORDER        (BUY_LIMIT/SELL_LIMIT/BUY_STOP/    |
//|                                SELL_STOP/BUY_STOP_LIMIT/         |
//|                                SELL_STOP_LIMIT)                  |
//|    MODIFY_POSITION_PROTECTION (SL/TP on open position)           |
//|    MODIFY_PENDING_ORDER       (price/SL/TP/expiration)           |
//|    CANCEL_PENDING_ORDER       (delete pending by ticket)         |
//|                                                                  |
//|  Stop-limit relationship (canonical MT5, do NOT invert):         |
//|    BUY_STOP_LIMIT  : stopLimitPrice  <  stopTriggerPrice         |
//|    SELL_STOP_LIMIT : stopLimitPrice  >  stopTriggerPrice         |
//|  (Once the stop trigger is broken, the broker places a *Limit*   |
//|   order at stopLimitPrice. The Limit must sit on the pullback    |
//|   side of the trigger — below for buys, above for sells.)        |
//+------------------------------------------------------------------+

#property copyright "ARX AI"
#property version   "1.40"
#property strict
#property description "ARX AI Bridge v1.40 — pending orders + SL/TP modify (safe defaults)."

#include <Trade\Trade.mqh>

//─── Inputs (safety-locked by default) ─────────────────────────────
input string  BridgeBaseUrl              = "";       // e.g. https://your.replit.app
input string  BridgeToken                = "";       // X-MT5-Bridge-Token (shared secret)
input int     PollIntervalSeconds        = 5;
input int     HeartbeatIntervalSeconds   = 15;

input bool    ReadOnlyMode               = true;     // ARM #1 — must be false to do anything mutating
input bool    AllowOrderExecution        = false;    // ARM #2 — must be true to call OrderSend at all
input bool    AllowPendingOrders         = false;    // ARM #3 — must be true to place a pending order
input bool    AllowProtectionModify      = false;    // ARM #4 — must be true to MODIFY_POSITION_PROTECTION
input bool    AllowPendingCancel         = false;    // ARM #5 — must be true to CANCEL_PENDING_ORDER
input bool    AllowPendingModify         = false;    // ARM #6 — must be true to MODIFY_PENDING_ORDER

input ulong   MagicNumber                = 73154777; // for trades placed by this EA
input int     MaxSlippagePoints          = 30;

//─── Globals ───────────────────────────────────────────────────────
CTrade        trade;
datetime      lastHeartbeatAt   = 0;
datetime      lastPollAt        = 0;
string        EA_VERSION        = "1.40";
string        BRIDGE_VERSION    = "1";    // protocol version (distinct from EA build number)

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(MaxSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   PrintFormat("ARX AI Bridge v%s loaded. ReadOnlyMode=%s AllowOrderExecution=%s AllowPendingOrders=%s AllowProtectionModify=%s",
               EA_VERSION,
               (string)ReadOnlyMode, (string)AllowOrderExecution,
               (string)AllowPendingOrders, (string)AllowProtectionModify);
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) {
      Print("ARX AI Bridge v1.40 — BridgeBaseUrl or BridgeToken missing; EA will idle.");
   }
   EventSetTimer(1);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) return;

   if(now - lastHeartbeatAt >= HeartbeatIntervalSeconds) {
      SendHeartbeat();
      lastHeartbeatAt = now;
   }
   if(now - lastPollAt >= PollIntervalSeconds) {
      PollAndExecute();
      lastPollAt = now;
   }
}

//+------------------------------------------------------------------+
//|  Capability JSON — exactly the keys the backend recognises.       |
//+------------------------------------------------------------------+
string BuildCapabilitiesJson()
{
   // Each capability is reported true ONLY if the corresponding Allow*
   // input is set true at EA load. This gives the operator a kill-switch:
   // disable a capability in the EA inputs and the backend will refuse
   // submission with BRIDGE_UNSUPPORTED before any command is queued.
   string s = "{";
   s += "\"marketOrders\":"             + (AllowOrderExecution ? "true" : "false") + ",";
   s += "\"marketOrderSLTP\":"          + (AllowOrderExecution ? "true" : "false") + ",";
   s += "\"pendingOrders\":"            + ((AllowOrderExecution && AllowPendingOrders) ? "true" : "false") + ",";
   s += "\"stopLimitOrders\":"          + ((AllowOrderExecution && AllowPendingOrders) ? "true" : "false") + ",";
   s += "\"modifyPositionProtection\":" + ((AllowOrderExecution && AllowProtectionModify) ? "true" : "false") + ",";
   s += "\"modifyPendingOrders\":"      + ((AllowOrderExecution && AllowPendingModify) ? "true" : "false") + ",";
   s += "\"cancelPendingOrders\":"      + ((AllowOrderExecution && AllowPendingCancel) ? "true" : "false") + ",";
   s += "\"expiration\":true,";
   s += "\"sharedMasterSafeRouting\":false";
   s += "}";
   return s;
}

//+------------------------------------------------------------------+
void SendHeartbeat()
{
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   string acct = (string)AccountInfoInteger(ACCOUNT_LOGIN);
   string brk  = AccountInfoString(ACCOUNT_COMPANY);
   string srv  = AccountInfoString(ACCOUNT_SERVER);
   long   tmode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string accountType =
      (tmode == ACCOUNT_TRADE_MODE_DEMO)   ? "demo"  :
      (tmode == ACCOUNT_TRADE_MODE_REAL)   ? "live"  :
      (tmode == ACCOUNT_TRADE_MODE_CONTEST)? "demo"  : "unknown";
   bool liveAllowed = (AllowOrderExecution && !ReadOnlyMode);

   string body = StringFormat(
      "{\"account\":\"%s\",\"broker\":\"%s\",\"server\":\"%s\","
      "\"balance\":%.2f,\"equity\":%.2f,\"liveAllowed\":%s,"
      "\"accountType\":\"%s\",\"eaVersion\":\"%s\",\"bridgeVersion\":\"%s\","
      "\"capabilities\":%s}",
      acct, brk, srv, bal, eq, (liveAllowed ? "true" : "false"),
      accountType, EA_VERSION, BRIDGE_VERSION, BuildCapabilitiesJson());
   PostJson("/api/mt5/heartbeat", body);
}

//+------------------------------------------------------------------+
void PollAndExecute()
{
   string resp = GetJson("/api/mt5/commands");
   if(StringLen(resp) == 0) return;
   // Backend response shape: { "commands": [ { id, action, payload, ... } ] }
   // We do a minimal scan + per-command handler. JSON parsing is intentionally
   // narrow to avoid bringing in a heavyweight parser.
   int pos = 0;
   while(true) {
      int s = StringFind(resp, "\"id\":", pos);
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
//|  Per-command dispatcher. Each handler is responsible for          |
//|  - respecting its Allow* input                                    |
//|  - checking confirmedByUser                                       |
//|  - reporting a clean (commandId, status, ...) result              |
//+------------------------------------------------------------------+
void HandleCommand(const string slice)
{
   string action  = JsonStr(slice, "action");
   long   cmdId   = JsonLong(slice, "id");
   bool   confirm = (JsonStr(slice, "confirmedByUser") == "true");

   if(ReadOnlyMode || !AllowOrderExecution) {
      PostResult(cmdId, "REJECTED", 0, "EA_READ_ONLY",
                 "EA is in read-only mode (ARM #1/#2 disabled).");
      return;
   }
   // confirmedByUser is mandatory for EVERY mutating action, including
   // DEMO_MARKET_ORDER. The backend is required to set this flag only
   // after the user confirms in the trade-ticket modal.
   if(!confirm) {
      PostResult(cmdId, "REJECTED", 0, "EA_MISSING_CONFIRMATION",
                 "Command rejected — confirmedByUser flag was not present.");
      return;
   }

   if(action == "DEMO_MARKET_ORDER")          HandleDemoMarket(cmdId, slice);
   else if(action == "PLACE_MARKET_ORDER")    HandlePlaceMarket(cmdId, slice);
   else if(action == "PLACE_PENDING_ORDER")   HandlePlacePending(cmdId, slice);
   else if(action == "MODIFY_POSITION_PROTECTION") HandleModifyProtection(cmdId, slice);
   else if(action == "MODIFY_PENDING_ORDER")  HandleModifyPending(cmdId, slice);
   else if(action == "CANCEL_PENDING_ORDER")  HandleCancelPending(cmdId, slice);
   else PostResult(cmdId, "REJECTED", 0, "EA_UNKNOWN_ACTION",
                   StringFormat("EA v%s does not handle action='%s'.", EA_VERSION, action));
}

//+------------------------------------------------------------------+
void HandleDemoMarket(long cmdId, const string slice)
{
   // Preserved from v1.30. Single OrderSend, no retries.
   string symbol = JsonStr(slice, "symbol");
   string side   = JsonStr(slice, "side");
   double lot    = JsonNum(slice, "lot");
   double sl     = JsonNum(slice, "sl");
   double tp     = JsonNum(slice, "tp");
   ENUM_ORDER_TYPE ot = (side == "SELL") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (ot == ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                                         : SymbolInfoDouble(symbol, SYMBOL_BID);
   bool ok = (ot == ORDER_TYPE_BUY) ? trade.Buy(lot, symbol, price, sl, tp, "ARX AI demo")
                                    : trade.Sell(lot, symbol, price, sl, tp, "ARX AI demo");
   if(ok) PostResult(cmdId, "FILLED", (long)trade.ResultOrder(), "", "");
   else   PostResult(cmdId, "REJECTED", 0, (string)trade.ResultRetcode(), trade.ResultComment());
}

//+------------------------------------------------------------------+
void HandlePlaceMarket(long cmdId, const string slice)
{
   if(!AllowOrderExecution) {
      PostResult(cmdId, "REJECTED", 0, "EA_ORDER_EXECUTION_DISABLED",
                 "AllowOrderExecution input is false.");
      return;
   }
   string symbol = JsonStr(slice, "symbol");
   string side   = JsonStr(slice, "side");
   double lot    = JsonNum(slice, "lot");
   double sl     = JsonNum(slice, "sl");
   double tp     = JsonNum(slice, "tp");
   ENUM_ORDER_TYPE ot = (side == "SELL") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (ot == ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                                         : SymbolInfoDouble(symbol, SYMBOL_BID);
   bool ok = (ot == ORDER_TYPE_BUY) ? trade.Buy(lot, symbol, price, sl, tp, "ARX AI market")
                                    : trade.Sell(lot, symbol, price, sl, tp, "ARX AI market");
   if(ok) PostResult(cmdId, "FILLED", (long)trade.ResultOrder(), "", "");
   else   PostResult(cmdId, "REJECTED", 0, (string)trade.ResultRetcode(), trade.ResultComment());
}

//+------------------------------------------------------------------+
void HandlePlacePending(long cmdId, const string slice)
{
   if(!AllowPendingOrders) {
      PostResult(cmdId, "REJECTED", 0, "EA_PENDING_DISABLED",
                 "AllowPendingOrders input is false.");
      return;
   }
   string symbol = JsonStr(slice, "symbol");
   string ot     = JsonStr(slice, "orderType");
   double lot    = JsonNum(slice, "lot");
   double entry  = JsonNum(slice, "entryPrice");
   double trig   = JsonNum(slice, "stopTriggerPrice");
   double limit  = JsonNum(slice, "stopLimitPrice");
   double sl     = JsonNum(slice, "sl");
   double tp     = JsonNum(slice, "tp");
   datetime exp  = (datetime)(long)JsonNum(slice, "expiration");

   // Canonical MT5 stop-limit relationship — must match backend/UI.
   // BUY_STOP_LIMIT: limit STRICTLY BELOW trigger. SELL_STOP_LIMIT: limit
   // STRICTLY ABOVE trigger. Equality rejected (broker would return Invalid
   // Stops). Defense-in-depth — server already validates the same rule.
   if(ot == "BUY_STOP_LIMIT" && limit >= trig) {
      PostResult(cmdId, "REJECTED", 0, "EA_STOP_LIMIT_RELATIONSHIP",
                 "BUY_STOP_LIMIT limit must be STRICTLY BELOW trigger (per MT5).");
      return;
   }
   if(ot == "SELL_STOP_LIMIT" && limit <= trig) {
      PostResult(cmdId, "REJECTED", 0, "EA_STOP_LIMIT_RELATIONSHIP",
                 "SELL_STOP_LIMIT limit must be STRICTLY ABOVE trigger (per MT5).");
      return;
   }

   bool ok = false;
   if(ot == "BUY_LIMIT")        ok = trade.BuyLimit(lot, entry, symbol, sl, tp, ORDER_TIME_GTC, exp, "ARX AI buy_limit");
   else if(ot == "SELL_LIMIT")  ok = trade.SellLimit(lot, entry, symbol, sl, tp, ORDER_TIME_GTC, exp, "ARX AI sell_limit");
   else if(ot == "BUY_STOP")    ok = trade.BuyStop(lot, entry, symbol, sl, tp, ORDER_TIME_GTC, exp, "ARX AI buy_stop");
   else if(ot == "SELL_STOP")   ok = trade.SellStop(lot, entry, symbol, sl, tp, ORDER_TIME_GTC, exp, "ARX AI sell_stop");
   else if(ot == "BUY_STOP_LIMIT") {
      MqlTradeRequest  req={}; MqlTradeResult  rs={};
      req.action = TRADE_ACTION_PENDING; req.symbol = symbol; req.volume = lot;
      req.type = ORDER_TYPE_BUY_STOP_LIMIT; req.price = trig; req.stoplimit = limit;
      req.sl = sl; req.tp = tp; req.type_time = (exp > 0) ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC;
      req.expiration = exp; req.magic = MagicNumber; req.comment = "ARX AI buy_stop_limit";
      ok = OrderSend(req, rs);
      if(ok) { PostResult(cmdId, "PLACED", (long)rs.order, "", ""); return; }
      PostResult(cmdId, "REJECTED", 0, (string)rs.retcode, rs.comment); return;
   }
   else if(ot == "SELL_STOP_LIMIT") {
      MqlTradeRequest  req={}; MqlTradeResult  rs={};
      req.action = TRADE_ACTION_PENDING; req.symbol = symbol; req.volume = lot;
      req.type = ORDER_TYPE_SELL_STOP_LIMIT; req.price = trig; req.stoplimit = limit;
      req.sl = sl; req.tp = tp; req.type_time = (exp > 0) ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC;
      req.expiration = exp; req.magic = MagicNumber; req.comment = "ARX AI sell_stop_limit";
      ok = OrderSend(req, rs);
      if(ok) { PostResult(cmdId, "PLACED", (long)rs.order, "", ""); return; }
      PostResult(cmdId, "REJECTED", 0, (string)rs.retcode, rs.comment); return;
   }
   else {
      PostResult(cmdId, "REJECTED", 0, "EA_UNKNOWN_ORDER_TYPE",
                 StringFormat("Unknown pending orderType='%s'.", ot));
      return;
   }
   if(ok) PostResult(cmdId, "PLACED", (long)trade.ResultOrder(), "", "");
   else   PostResult(cmdId, "REJECTED", 0, (string)trade.ResultRetcode(), trade.ResultComment());
}

//+------------------------------------------------------------------+
void HandleModifyProtection(long cmdId, const string slice)
{
   if(!AllowProtectionModify) {
      PostResult(cmdId, "REJECTED", 0, "EA_PROTECTION_MODIFY_DISABLED",
                 "AllowProtectionModify input is false.");
      return;
   }
   ulong ticket = (ulong)JsonNum(slice, "ticket");
   double sl    = JsonNum(slice, "sl");
   double tp    = JsonNum(slice, "tp");
   if(!PositionSelectByTicket(ticket)) {
      PostResult(cmdId, "REJECTED", 0, "EA_POSITION_NOT_FOUND",
                 StringFormat("Position %I64u not found.", ticket));
      return;
   }
   bool ok = trade.PositionModify(ticket, sl, tp);
   if(ok) PostResult(cmdId, "MODIFIED", (long)ticket, "", "");
   else   PostResult(cmdId, "REJECTED", (long)ticket, (string)trade.ResultRetcode(), trade.ResultComment());
}

//+------------------------------------------------------------------+
void HandleModifyPending(long cmdId, const string slice)
{
   if(!AllowPendingModify) {
      PostResult(cmdId, "REJECTED", 0, "EA_PENDING_MODIFY_DISABLED",
                 "AllowPendingModify input is false.");
      return;
   }
   ulong ticket  = (ulong)JsonNum(slice, "ticket");
   double price  = JsonNum(slice, "entryPrice");
   double limit  = JsonNum(slice, "stopLimitPrice");
   double sl     = JsonNum(slice, "sl");
   double tp     = JsonNum(slice, "tp");
   datetime exp  = (datetime)(long)JsonNum(slice, "expiration");
   if(!OrderSelect(ticket)) {
      PostResult(cmdId, "REJECTED", 0, "EA_ORDER_NOT_FOUND",
                 StringFormat("Pending order %I64u not found.", ticket));
      return;
   }
   bool ok = trade.OrderModify(ticket, price, sl, tp,
                               (exp > 0) ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC,
                               exp, limit);
   if(ok) PostResult(cmdId, "MODIFIED", (long)ticket, "", "");
   else   PostResult(cmdId, "REJECTED", (long)ticket, (string)trade.ResultRetcode(), trade.ResultComment());
}

//+------------------------------------------------------------------+
void HandleCancelPending(long cmdId, const string slice)
{
   if(!AllowPendingCancel) {
      PostResult(cmdId, "REJECTED", 0, "EA_PENDING_CANCEL_DISABLED",
                 "AllowPendingCancel input is false.");
      return;
   }
   ulong ticket = (ulong)JsonNum(slice, "ticket");
   if(!OrderSelect(ticket)) {
      PostResult(cmdId, "REJECTED", 0, "EA_ORDER_NOT_FOUND",
                 StringFormat("Pending order %I64u not found.", ticket));
      return;
   }
   bool ok = trade.OrderDelete(ticket);
   if(ok) PostResult(cmdId, "CANCELLED", (long)ticket, "", "");
   else   PostResult(cmdId, "REJECTED", (long)ticket, (string)trade.ResultRetcode(), trade.ResultComment());
}

//+------------------------------------------------------------------+
void PostResult(long cmdId, const string status, long mt5Ticket,
                const string errorCode, const string errorMessage)
{
   string body = StringFormat(
      "{\"commandId\":%I64d,\"status\":\"%s\",\"mt5Ticket\":%I64d,"
      "\"errorCode\":\"%s\",\"errorMessage\":%s,\"executedAt\":\"%s\","
      "\"eaVersion\":\"%s\"}",
      cmdId, status, mt5Ticket,
      errorCode, JsonEscape(errorMessage),
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS), EA_VERSION);
   PostJson("/api/mt5/command-result", body);
}

//+------------------------------------------------------------------+
//  HTTP helpers (use MT5 WebRequest — URL must be allow-listed in   |
//  Tools > Options > Expert Advisors > Allow WebRequest for URL).   |
//+------------------------------------------------------------------+
string GetJson(const string path)
{
   char post[]; char result[]; string headers; string respHeaders;
   string url = BridgeBaseUrl + path;
   string reqHeaders = "X-MT5-Bridge-Token: " + BridgeToken + "\r\nAccept: application/json\r\n";
   ResetLastError();
   int code = WebRequest("GET", url, reqHeaders, 10000, post, result, respHeaders);
   if(code != 200) return "";
   return CharArrayToString(result);
}

void PostJson(const string path, const string json)
{
   char post[]; char result[]; string headers; string respHeaders;
   string url = BridgeBaseUrl + path;
   StringToCharArray(json, post, 0, StringLen(json), CP_UTF8);
   ArrayResize(post, ArraySize(post) - 1); // drop trailing \0
   string reqHeaders = "X-MT5-Bridge-Token: " + BridgeToken
                     + "\r\nContent-Type: application/json\r\nAccept: application/json\r\n";
   ResetLastError();
   int code = WebRequest("POST", url, reqHeaders, 10000, post, result, respHeaders);
   if(code != 200) PrintFormat("ARX AI Bridge POST %s -> %d (err=%d)", path, code, GetLastError());
}

//+------------------------------------------------------------------+
//  Minimal JSON helpers. Narrow on purpose — only what the EA needs. |
//+------------------------------------------------------------------+
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
   // bool/number/null literal
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
string JsonEscape(const string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", "\\n");
   return "\"" + r + "\"";
}
//+------------------------------------------------------------------+
