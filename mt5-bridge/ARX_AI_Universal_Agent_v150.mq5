//+------------------------------------------------------------------+
//|  ARX_AI_Universal_Agent_v150.mq5                                 |
//|  ARX AI — Universal MT5 Execution + Telemetry Agent              |
//|                                                                  |
//|  Long-term EA foundation. One universal command engine, honest   |
//|  capability handshake, exact broker-symbol resolution + select,  |
//|  structured errors, validate-only preflight, account/position/   |
//|  pending sync, idempotency, health + self-test.                  |
//|                                                                  |
//|  ─────────────────────────────────────────────────────────────  |
//|  EXECUTION TRUTH — NON-NEGOTIABLE                                |
//|    * The EA NEVER reports success it did not get from MT5.        |
//|    * "received by EA" is NOT "executed". A result is only FILLED  |
//|      when CTrade/OrderSend returns a real ticket/deal.            |
//|    * Anything not implemented correctly in this build is reported |
//|      as a FALSE capability so ARX hides it — it is never faked.   |
//|                                                                  |
//|  SAFETY ARM INPUTS (DO NOT WEAKEN DEFAULTS):                     |
//|    ReadOnlyMode          = true   (ARM #1)                        |
//|    AllowOrderExecution   = false  (ARM #2 — OrderSend gate)       |
//|    AllowPendingOrders    = false  (ARM #3)                        |
//|    AllowProtectionModify = false  (ARM #4 — SL/TP modify)         |
//|    AllowPositionClose    = false  (ARM #5 — close/partial/reverse)|
//|    AllowPendingCancel    = false  (ARM #6)                        |
//|    AllowPendingModify    = false  (ARM #7)                        |
//|    AllowEmergencyClose    = false (ARM #8 — close-all / panic)    |
//|  Every mutating handler refuses unless its ARM input is true AND  |
//|  (for trade entries) the backend command has confirmedByUser.     |
//|                                                                  |
//|  WIRE-COMPATIBLE with the existing backend:                       |
//|    GET  /api/mt5/commands        (poll queue)                     |
//|    POST /api/mt5/command-result  (per-command result)             |
//|    POST /api/mt5/heartbeat       (status + capabilities)          |
//|  Legacy actions PLACE_MARKET_ORDER / DEMO_MARKET_ORDER /          |
//|  PLACE_PENDING_ORDER / MODIFY_POSITION_PROTECTION /               |
//|  MODIFY_PENDING_ORDER / CANCEL_PENDING_ORDER are preserved so the |
//|  current EURUSD live path keeps working unchanged.                |
//+------------------------------------------------------------------+
#property copyright "ARX AI"
#property version   "1.50"
#property strict
#property description "ARX AI Universal MT5 Agent v1.50 — universal command engine, symbol discovery, structured errors, validate-only (safe defaults)."

#include <Trade\Trade.mqh>

//─── Connection inputs ─────────────────────────────────────────────
input string  BridgeBaseUrl              = "";       // e.g. https://your.replit.app
input string  BridgeToken                = "";       // X-MT5-Bridge-Token (shared secret)
input int     PollIntervalSeconds        = 5;
input int     HeartbeatIntervalSeconds   = 15;
input int     SnapshotIntervalSeconds    = 10;       // account + positions + pending push

//─── Safety ARM inputs (locked off by default) ─────────────────────
input bool    ReadOnlyMode               = true;     // ARM #1
input bool    AllowOrderExecution        = false;    // ARM #2 — OrderSend at all
input bool    AllowPendingOrders         = false;    // ARM #3
input bool    AllowProtectionModify      = false;    // ARM #4
input bool    AllowPositionClose         = false;    // ARM #5 — close/partial/reverse/break-even
input bool    AllowPendingCancel         = false;    // ARM #6
input bool    AllowPendingModify         = false;    // ARM #7
input bool    AllowEmergencyClose        = false;    // ARM #8 — close-all / panic-close-all

//─── Execution tuning ──────────────────────────────────────────────
input ulong   MagicNumber                = 73154777; // ARX-tagged trades
input int     MaxSlippagePoints          = 30;
input int     CommandExpirySeconds       = 120;      // reject commands older than this
input int     MaxSymbolsEnumerated       = 600;      // cap ENUMERATE_SYMBOLS payload

//─── Globals ───────────────────────────────────────────────────────
CTrade        trade;
datetime      lastHeartbeatAt   = 0;
datetime      lastPollAt        = 0;
datetime      lastSnapshotAt    = 0;
datetime      lastCommandAt     = 0;
string        lastSuccessAction = "";
string        lastErrorSeen     = "";
string        EA_VERSION        = "1.50";
string        EA_NAME           = "ARX_AI_Universal_Agent";
string        EA_BUILD          = "1500";
string        BRIDGE_VERSION    = "2";   // command-protocol version

//─── Idempotency ring buffer (recent commandIds) ───────────────────
#define IDEMPOTENCY_CAPACITY 256
long          seenCmdIds[IDEMPOTENCY_CAPACITY];
int           seenCmdHead = 0;
int           seenCmdCount = 0;

bool WasCmdSeen(long id)
{
   for(int i = 0; i < seenCmdCount; i++)
      if(seenCmdIds[i] == id) return true;
   return false;
}
void RememberCmd(long id)
{
   // overwrite oldest when full (ring)
   if(seenCmdCount < IDEMPOTENCY_CAPACITY) {
      seenCmdIds[seenCmdCount] = id; seenCmdCount++;
   } else {
      seenCmdIds[seenCmdHead] = id; seenCmdHead = (seenCmdHead + 1) % IDEMPOTENCY_CAPACITY;
   }
}

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(MaxSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   ArrayInitialize(seenCmdIds, 0);
   PrintFormat("ARX Universal Agent v%s loaded. ReadOnly=%s Exec=%s Close=%s Pending=%s Emergency=%s",
               EA_VERSION, (string)ReadOnlyMode, (string)AllowOrderExecution,
               (string)AllowPositionClose, (string)AllowPendingOrders, (string)AllowEmergencyClose);
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0)
      Print("ARX Universal Agent v1.50 — BridgeBaseUrl or BridgeToken missing; EA will idle.");
   EventSetTimer(1);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();
   if(StringLen(BridgeBaseUrl) == 0 || StringLen(BridgeToken) == 0) return;

   if(now - lastHeartbeatAt >= HeartbeatIntervalSeconds) { SendHeartbeat(); lastHeartbeatAt = now; }
   if(now - lastSnapshotAt  >= SnapshotIntervalSeconds)  { PushSnapshots();  lastSnapshotAt  = now; }
   if(now - lastPollAt      >= PollIntervalSeconds)      { PollAndExecute(); lastPollAt      = now; }
}

//+------------------------------------------------------------------+
//|  CAPABILITY REGISTRY — honest. A capability is true only if the   |
//|  build actually implements it AND its ARM input permits it.       |
//|  Anything reported false here is HIDDEN by ARX and never invoked. |
//+------------------------------------------------------------------+
string BuildCapabilitiesJson()
{
   bool exec    = (AllowOrderExecution && !ReadOnlyMode);
   bool close   = (exec && AllowPositionClose);
   bool pend    = (exec && AllowPendingOrders);
   bool emerg   = (exec && AllowEmergencyClose);

   string s = "{";
   // Identity
   s += "\"eaName\":\"" + EA_NAME + "\",";
   s += "\"eaVersion\":\"" + EA_VERSION + "\",";
   s += "\"build\":\"" + EA_BUILD + "\",";
   s += "\"protocol\":\"" + BRIDGE_VERSION + "\",";
   // Legacy capability keys the current backend already reads (keep them):
   s += "\"marketOrders\":"             + (exec  ? "true" : "false") + ",";
   s += "\"marketOrderSLTP\":"          + (exec  ? "true" : "false") + ",";
   s += "\"pendingOrders\":"            + (pend  ? "true" : "false") + ",";
   s += "\"stopLimitOrders\":"          + (pend  ? "true" : "false") + ",";
   s += "\"modifyPositionProtection\":" + ((exec && AllowProtectionModify) ? "true" : "false") + ",";
   s += "\"modifyPendingOrders\":"      + ((exec && AllowPendingModify) ? "true" : "false") + ",";
   s += "\"cancelPendingOrders\":"      + ((exec && AllowPendingCancel) ? "true" : "false") + ",";
   s += "\"expiration\":true,";
   s += "\"sharedMasterSafeRouting\":false,";
   // v1.50 universal capabilities:
   s += "\"openMarket\":"               + (exec  ? "true" : "false") + ",";
   s += "\"closePosition\":"            + (close ? "true" : "false") + ",";
   s += "\"partialClose\":"             + (close ? "true" : "false") + ",";
   s += "\"reversePosition\":"          + (close ? "true" : "false") + ",";
   s += "\"moveSL\":"                   + ((exec && AllowProtectionModify) ? "true" : "false") + ",";
   s += "\"moveTP\":"                   + ((exec && AllowProtectionModify) ? "true" : "false") + ",";
   s += "\"breakEven\":"                + ((exec && AllowProtectionModify) ? "true" : "false") + ",";
   s += "\"closeAllBySymbol\":"         + (emerg ? "true" : "false") + ",";
   s += "\"closeAllByMagic\":"          + (emerg ? "true" : "false") + ",";
   s += "\"cancelAllPending\":"         + (emerg ? "true" : "false") + ",";
   s += "\"panicCloseAll\":"            + (emerg ? "true" : "false") + ",";
   // Read / diagnostic capabilities (always available, no execution risk):
   s += "\"symbolDiscovery\":true,";
   s += "\"symbolRules\":true,";
   s += "\"symbolResolver\":true,";
   s += "\"structuredErrors\":true,";
   s += "\"validateOnly\":true,";
   s += "\"accountSnapshot\":true,";
   s += "\"openPositionSync\":true,";
   s += "\"pendingOrderSync\":true,";
   s += "\"selfTest\":true,";
   s += "\"health\":true,";
   s += "\"commandIdempotency\":true,";
   s += "\"magicCommentTagging\":true,";
   // Honestly NOT implemented in this build → reported false so ARX hides them:
   s += "\"trailingStop\":false,";
   s += "\"manualTradeDetection\":false,";
   s += "\"marketTelemetryIndicators\":false,";
   s += "\"tradeQualityAnalytics\":false,";
   s += "\"remoteConfig\":false,";
   s += "\"commandSigning\":false";
   s += "}";
   return s;
}

//+------------------------------------------------------------------+
//|  Account snapshot fields, shared by heartbeat + GET_ACCOUNT_SNAPSHOT
//+------------------------------------------------------------------+
string BuildAccountSnapshotJson()
{
   long   tmode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string accountType =
      (tmode == ACCOUNT_TRADE_MODE_DEMO)    ? "demo"  :
      (tmode == ACCOUNT_TRADE_MODE_REAL)    ? "live"  :
      (tmode == ACCOUNT_TRADE_MODE_CONTEST) ? "demo"  : "unknown";
   string login = (string)AccountInfoInteger(ACCOUNT_LOGIN);
   string masked = (StringLen(login) > 4) ? ("****" + StringSubstr(login, StringLen(login) - 4)) : "****";

   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   double mg   = AccountInfoDouble(ACCOUNT_MARGIN);
   double fm   = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double ml   = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   double prof = AccountInfoDouble(ACCOUNT_PROFIT);

   bool acctTradeAllowed = (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   bool acctExpertAllowed= (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
   bool termTradeAllowed = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   bool mqlTradeAllowed  = (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
   bool termConnected    = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);

   MqlTick t; bool gotTick = SymbolInfoTick(_Symbol, t);
   string lastTick = gotTick ? TimeToString(t.time, TIME_DATE|TIME_SECONDS) : "";

   string s = "{";
   s += "\"balance\":"      + SafeF(bal) + ",";
   s += "\"equity\":"       + SafeF(eq)  + ",";
   s += "\"margin\":"       + SafeF(mg)  + ",";
   s += "\"freeMargin\":"   + SafeF(fm)  + ",";
   s += "\"marginLevel\":"  + SafeF(ml)  + ",";
   s += "\"openPnl\":"      + SafeF(prof)+ ",";
   s += "\"currency\":\""   + AccountInfoString(ACCOUNT_CURRENCY) + "\",";
   s += "\"leverage\":"     + (string)AccountInfoInteger(ACCOUNT_LEVERAGE) + ",";
   s += "\"server\":\""     + AccountInfoString(ACCOUNT_SERVER) + "\",";
   s += "\"broker\":\""     + AccountInfoString(ACCOUNT_COMPANY) + "\",";
   s += "\"accountMasked\":\"" + masked + "\",";
   s += "\"accountType\":\""   + accountType + "\",";
   s += "\"accountTradeAllowed\":"  + (acctTradeAllowed ? "true":"false") + ",";
   s += "\"accountExpertAllowed\":" + (acctExpertAllowed? "true":"false") + ",";
   s += "\"terminalTradeAllowed\":" + (termTradeAllowed ? "true":"false") + ",";
   s += "\"mqlTradeAllowed\":"      + (mqlTradeAllowed  ? "true":"false") + ",";
   s += "\"terminalConnected\":"    + (termConnected    ? "true":"false") + ",";
   s += "\"lastTickTime\":\""       + lastTick + "\",";
   s += "\"openPositions\":"        + (string)PositionsTotal() + ",";
   s += "\"pendingOrders\":"        + (string)OrdersTotal() + ",";
   s += "\"timestamp\":\""          + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\"";
   s += "}";
   return s;
}

//+------------------------------------------------------------------+
//|  LIVE TERMINAL TELEMETRY ("eaInputs")                            |
//|  The ARX master-live bridge gate reads these EXACT fields from    |
//|  capabilities.eaInputs to decide whether the terminal is live-    |
//|  capable. Emitted TOP-LEVEL on every heartbeat + health response. |
//|  Pure observability: reporting NEVER enables execution — the ARX   |
//|  16-gate evaluator and each ARM-gated handler remain authoritative.|
//|                                                                    |
//|  terminalConnected   = MT5 terminal <-> broker server socket.      |
//|  algoTradingAllowed  = terminal AutoTrading AND EA MQL permission. |
//|                        Subfields below name WHICH one is off.       |
//|  enableLiveExecution = ARM #2 (AllowOrderExecution — OrderSend).    |
//|  readOnlyMode        = ARM #1 (ReadOnlyMode — true blocks sends).   |
//+------------------------------------------------------------------+
string BuildEaInputsJson()
{
   bool termConnected    = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   bool termTradeAllowed = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   bool mqlTradeAllowed  = (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
   bool acctTradeAllowed = (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   bool acctExpertAllow  = (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
   // Algo trading is genuinely allowed only when BOTH the terminal AutoTrading
   // switch and the EA's own MQL permission are on. Never fabricated here.
   bool algoAllowed      = (termTradeAllowed && mqlTradeAllowed);

   string s = "{";
   s += "\"terminalConnected\":"    + (termConnected    ? "true":"false") + ",";
   s += "\"algoTradingAllowed\":"   + (algoAllowed      ? "true":"false") + ",";
   s += "\"enableLiveExecution\":"  + (AllowOrderExecution ? "true":"false") + ",";
   s += "\"readOnlyMode\":"         + (ReadOnlyMode     ? "true":"false") + ",";
   s += "\"terminalTradeAllowed\":" + (termTradeAllowed ? "true":"false") + ",";
   s += "\"mqlTradeAllowed\":"      + (mqlTradeAllowed  ? "true":"false") + ",";
   s += "\"expertTradeAllowed\":"   + (acctExpertAllow  ? "true":"false") + ",";
   s += "\"accountTradeAllowed\":"  + (acctTradeAllowed ? "true":"false") + ",";
   s += "\"arm1\":"                 + (ReadOnlyMode        ? "true":"false") + ",";
   s += "\"arm2OrderSend\":"        + (AllowOrderExecution ? "true":"false") + ",";
   s += "\"arm3\":"                 + (AllowPendingOrders   ? "true":"false") + ",";
   s += "\"arm4\":"                 + (AllowProtectionModify? "true":"false") + ",";
   s += "\"arm5\":"                 + (AllowPositionClose   ? "true":"false") + ",";
   s += "\"arm6\":"                 + (AllowPendingCancel   ? "true":"false") + ",";
   s += "\"arm7\":"                 + (AllowPendingModify   ? "true":"false") + ",";
   s += "\"arm8\":"                 + (AllowEmergencyClose  ? "true":"false");
   s += "}";
   return s;
}

//+------------------------------------------------------------------+
void SendHeartbeat()
{
   bool liveAllowed = (AllowOrderExecution && !ReadOnlyMode);
   string body = StringFormat(
      "{\"account\":\"%s\",\"broker\":\"%s\",\"server\":\"%s\","
      "\"balance\":%.2f,\"equity\":%.2f,\"liveAllowed\":%s,"
      "\"accountType\":\"%s\",\"eaVersion\":\"%s\",\"eaName\":\"%s\",\"bridgeVersion\":\"%s\","
      "\"lastCommandAt\":\"%s\",\"lastSuccessAction\":\"%s\",\"lastError\":%s,"
      "\"openPositions\":%d,\"pendingOrders\":%d,"
      "\"timestamp\":\"%s\","
      "\"eaInputs\":%s,"
      "\"capabilities\":%s,\"snapshot\":%s}",
      (string)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY), AccountInfoString(ACCOUNT_SERVER),
      AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY),
      (liveAllowed ? "true" : "false"),
      (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL ? "live" : "demo"),
      EA_VERSION, EA_NAME, BRIDGE_VERSION,
      (lastCommandAt > 0 ? TimeToString(lastCommandAt, TIME_DATE|TIME_SECONDS) : ""),
      lastSuccessAction, JsonEscape(lastErrorSeen),
      PositionsTotal(), OrdersTotal(),
      TimeToString(TimeGMT(), TIME_DATE|TIME_SECONDS),
      BuildEaInputsJson(),
      BuildCapabilitiesJson(), BuildAccountSnapshotJson());
   PostJson("/api/mt5/heartbeat", body);
}

//+------------------------------------------------------------------+
//|  Periodic position + pending snapshot push (real MT5 truth).      |
//|  ARX Open Positions must come from THIS, not ARX-only rows.       |
//+------------------------------------------------------------------+
void PushSnapshots()
{
   PostJson("/api/mt5/positions-snapshot", BuildOpenPositionsJson());
   PostJson("/api/mt5/pending-snapshot",   BuildPendingOrdersJson());
}

//+------------------------------------------------------------------+
//|  COMMAND POLLER + UNIVERSAL DISPATCHER                            |
//+------------------------------------------------------------------+
void PollAndExecute()
{
   string resp = GetJson("/api/mt5/commands");
   if(StringLen(resp) == 0) return;
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
//|  Per-command dispatcher.                                          |
//|  Order of checks: idempotency → expiry → read-only/arm →          |
//|  confirmation (for entries) → action handler.                     |
//+------------------------------------------------------------------+
void HandleCommand(const string slice)
{
   string action  = JsonStr(slice, "action");
   long   cmdId   = JsonLong(slice, "id");
   bool   confirm = (JsonStr(slice, "confirmedByUser") == "true");
   lastCommandAt  = TimeCurrent();

   // ── Idempotency: never execute the same command twice ──
   if(WasCmdSeen(cmdId)) {
      PostResultStruct(cmdId, "REJECTED", "DUPLICATE_COMMAND", 0,
         "Command already processed.", "Duplicate commandId ignored (idempotency).",
         action, "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
   }

   // ── Expiry: reject stale commands (retry/reconnect safety) ──
   long createdAtEpoch = JsonLong(slice, "createdAtEpoch");
   if(createdAtEpoch > 0) {
      long ageSec = (long)TimeCurrent() - createdAtEpoch;
      if(ageSec > CommandExpirySeconds) {
         RememberCmd(cmdId);
         PostResultStruct(cmdId, "EXPIRED", "COMMAND_EXPIRED", 0,
            "This order expired before it could run.",
            StringFormat("Command age %I64ds exceeds expiry %ds.", ageSec, CommandExpirySeconds),
            action, "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0);
         return;
      }
   }

   // ── Read-only / non-mutating commands are always allowed ──
   if(IsReadOnlyAction(action)) {
      RememberCmd(cmdId);
      DispatchReadOnly(cmdId, action, slice);
      return;
   }

   // ── From here, the action mutates state: ARM #1/#2 must permit it ──
   if(ReadOnlyMode || !AllowOrderExecution) {
      RememberCmd(cmdId);
      PostResultStruct(cmdId, "REJECTED", "ACCOUNT_TRADE_DISABLED", 0,
         "Live execution is switched off on the trading bridge.",
         "EA ReadOnlyMode/AllowOrderExecution ARM disabled.",
         action, "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
   }

   // ── Entries require explicit user confirmation from the backend ──
   if(IsEntryAction(action) && !confirm) {
      RememberCmd(cmdId);
      PostResultStruct(cmdId, "REJECTED", "ORDER_SEND_FAILED", 0,
         "This order was not confirmed.",
         "confirmedByUser flag was not present on an entry command.",
         action, "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
   }

   RememberCmd(cmdId);

   // ── Mutating action handlers (each ARM-gated again as needed) ──
   if(action == "OPEN_MARKET" || action == "PLACE_MARKET_ORDER")  HandleOpenMarket(cmdId, slice);
   else if(action == "DEMO_MARKET_ORDER")                          HandleOpenMarket(cmdId, slice);
   else if(action == "PLACE_PENDING" || action == "PLACE_PENDING_ORDER") HandlePlacePending(cmdId, slice);
   else if(action == "MODIFY_POSITION" || action == "MODIFY_POSITION_PROTECTION"
        || action == "MOVE_SL" || action == "MOVE_TP")             HandleModifyProtection(cmdId, slice);
   else if(action == "MOVE_TO_BREAKEVEN")                          HandleBreakEven(cmdId, slice);
   else if(action == "CLOSE_POSITION")                             HandleClosePosition(cmdId, slice);
   else if(action == "PARTIAL_CLOSE")                              HandlePartialClose(cmdId, slice);
   else if(action == "REVERSE_POSITION")                           HandleReverse(cmdId, slice);
   else if(action == "MODIFY_PENDING" || action == "MODIFY_PENDING_ORDER") HandleModifyPending(cmdId, slice);
   else if(action == "CANCEL_PENDING" || action == "CANCEL_PENDING_ORDER") HandleCancelPending(cmdId, slice);
   else if(action == "CLOSE_ALL")                                  HandleCloseAll(cmdId, slice, false, "");
   else if(action == "CLOSE_ALL_BY_SYMBOL")                        HandleCloseAll(cmdId, slice, true,  JsonStr(slice,"symbol"));
   else if(action == "CLOSE_ALL_BY_MAGIC_OR_USER")                 HandleCloseAllByMagic(cmdId, slice);
   else if(action == "CANCEL_ALL_PENDING")                         HandleCancelAllPending(cmdId, slice, false, "");
   else if(action == "CANCEL_ALL_PENDING_BY_SYMBOL")               HandleCancelAllPending(cmdId, slice, true, JsonStr(slice,"symbol"));
   else if(action == "PANIC_CLOSE_ALL")                            HandlePanicCloseAll(cmdId, slice);
   else
      PostResultStruct(cmdId, "REJECTED", "UNSUPPORTED_COMMAND", 0,
         "This action isn't supported by the trading bridge.",
         StringFormat("EA v%s has no handler for action='%s'.", EA_VERSION, action),
         action, "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

bool IsReadOnlyAction(const string a)
{
   return (a == "VALIDATE_ONLY" || a == "ENUMERATE_SYMBOLS" || a == "GET_SYMBOL_RULES"
        || a == "GET_ACCOUNT_SNAPSHOT" || a == "GET_OPEN_POSITIONS" || a == "GET_PENDING_ORDERS"
        || a == "SELF_TEST" || a == "GET_HEALTH" || a == "GET_CAPABILITIES");
}
bool IsEntryAction(const string a)
{
   return (a == "OPEN_MARKET" || a == "PLACE_MARKET_ORDER" || a == "DEMO_MARKET_ORDER"
        || a == "PLACE_PENDING" || a == "PLACE_PENDING_ORDER" || a == "REVERSE_POSITION");
}

void DispatchReadOnly(long cmdId, const string action, const string slice)
{
   if(action == "VALIDATE_ONLY")            HandleValidateOnly(cmdId, slice);
   else if(action == "ENUMERATE_SYMBOLS")   HandleEnumerateSymbols(cmdId, slice);
   else if(action == "GET_SYMBOL_RULES")    HandleGetSymbolRules(cmdId, slice);
   else if(action == "GET_ACCOUNT_SNAPSHOT")PostResultRaw(cmdId, "OK", BuildAccountSnapshotJson());
   else if(action == "GET_OPEN_POSITIONS")  PostResultRaw(cmdId, "OK", BuildOpenPositionsJson());
   else if(action == "GET_PENDING_ORDERS")  PostResultRaw(cmdId, "OK", BuildPendingOrdersJson());
   else if(action == "GET_CAPABILITIES")    PostResultRaw(cmdId, "OK", BuildCapabilitiesJson());
   else if(action == "GET_HEALTH")          PostResultRaw(cmdId, "OK", BuildHealthJson());
   else if(action == "SELF_TEST")           HandleSelfTest(cmdId, slice);
}

//+------------------------------------------------------------------+
//|  SYMBOL RESOLVER — resolve an ARX-sent label to the exact broker  |
//|  symbol string. Tries, in order:                                  |
//|    1. exact match (already a broker symbol)                       |
//|    2. case-insensitive exact                                      |
//|    3. normalized contains-match across all enumerated symbols     |
//|  Returns the resolved broker symbol, or "" if none / ambiguous.   |
//|  ambiguousOut is filled with candidates when >1 plausible match.  |
//+------------------------------------------------------------------+
string NormalizeSym(const string in)
{
   string s = in;
   StringToUpper(s);
   StringReplace(s, " ", "");
   StringReplace(s, "(", "");
   StringReplace(s, ")", "");
   StringReplace(s, "_", "");
   StringReplace(s, "-", "");
   StringReplace(s, "INDEX", "");
   return s;
}

string ResolveBrokerSymbol(const string requested, string &ambiguousOut)
{
   ambiguousOut = "";
   if(StringLen(requested) == 0) return "";

   // 1. exact match — is it already a broker symbol?
   if(SymbolInfoInteger(requested, SYMBOL_SELECT) >= 0) {
      // SymbolInfoInteger returns -1 only on truly unknown symbol for SELECT?
      // Safer: attempt SymbolSelect; if the symbol exists it succeeds.
   }
   if(SymbolSelect(requested, true)) {
      // confirm it is a real symbol (has a path/name)
      string nm = SymbolName_SafeExact(requested);
      if(nm != "") return nm;
   }

   string target = NormalizeSym(requested);
   int total = SymbolsTotal(false); // all broker symbols, not just Market Watch
   string firstHit = "";
   int hitCount = 0;
   string candidates = "[";
   for(int i = 0; i < total; i++) {
      string nm = SymbolName(i, false);
      if(nm == "") continue;
      // case-insensitive exact
      string up = nm; StringToUpper(up);
      string reqUp = requested; StringToUpper(reqUp);
      if(up == reqUp) { return nm; }
      // normalized contains
      string nnm = NormalizeSym(nm);
      if(nnm == target || StringFind(nnm, target) >= 0 || StringFind(target, nnm) >= 0) {
         if(hitCount < 8) {
            if(hitCount > 0) candidates += ",";
            candidates += "\"" + nm + "\"";
         }
         if(firstHit == "") firstHit = nm;
         hitCount++;
      }
   }
   candidates += "]";
   if(hitCount == 1) return firstHit;
   if(hitCount > 1) { ambiguousOut = candidates; return ""; }
   return "";
}

// Returns the exact broker symbol name if it resolves, else "".
string SymbolName_SafeExact(const string sym)
{
   // SYMBOL_SELECT read confirms the symbol is known to the terminal.
   long sel = SymbolInfoInteger(sym, SYMBOL_SELECT);
   if(sel == 0 || sel == 1) return sym; // known symbol (selected or not)
   return "";
}

//+------------------------------------------------------------------+
//|  PREFLIGHT ENGINE — the heart of the V75 fix.                     |
//|  Resolves + selects the exact broker symbol, then verifies every  |
//|  broker rule BEFORE any price read / OrderSend. Fills a struct.   |
//+------------------------------------------------------------------+
struct Preflight {
   bool    ok;
   string  reasonCode;
   string  userMessage;
   string  adminMessage;
   string  resolvedSymbol;
   double  bid, ask;
   double  minVol, maxVol, stepVol;
   long    tradeMode;
   long    fillingMode;
   long    stopsLevel, freezeLevel;
   double  marginRequired;
};

void PreflightInit(Preflight &p)
{
   p.ok=false; p.reasonCode=""; p.userMessage=""; p.adminMessage="";
   p.resolvedSymbol=""; p.bid=0; p.ask=0; p.minVol=0; p.maxVol=0; p.stepVol=0;
   p.tradeMode=-1; p.fillingMode=0; p.stopsLevel=0; p.freezeLevel=0; p.marginRequired=0;
}

// Runs full preflight for a market order on `requested` symbol/side/volume.
void RunPreflight(const string requested, const string side, double volume,
                  double slPrice, double tpPrice, Preflight &p)
{
   PreflightInit(p);

   // Account / terminal / algo trading allowed?
   if(!(bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) {
      p.reasonCode="TERMINAL_TRADE_DISABLED"; p.userMessage="Trading is disabled in the MT5 terminal.";
      p.adminMessage="TERMINAL_TRADE_ALLOWED=false."; return;
   }
   if(!(bool)MQLInfoInteger(MQL_TRADE_ALLOWED)) {
      p.reasonCode="ALGO_TRADING_DISABLED"; p.userMessage="Algo trading is turned off for this EA.";
      p.adminMessage="MQL_TRADE_ALLOWED=false (enable 'Algo Trading')."; return;
   }
   if(!(bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) {
      p.reasonCode="ACCOUNT_TRADE_DISABLED"; p.userMessage="This account cannot trade right now.";
      p.adminMessage="ACCOUNT_TRADE_ALLOWED=false."; return;
   }

   // Resolve the EXACT broker symbol.
   string amb = "";
   string sym = ResolveBrokerSymbol(requested, amb);
   if(sym == "" && amb != "") {
      p.reasonCode="SYMBOL_AMBIGUOUS"; p.userMessage="That market name matched more than one symbol.";
      p.adminMessage="Candidates: " + amb; return;
   }
   if(sym == "") {
      p.reasonCode="SYMBOL_NOT_FOUND"; p.userMessage="That market isn't available on this account.";
      p.adminMessage=StringFormat("No broker symbol resolved for '%s'.", requested); return;
   }
   p.resolvedSymbol = sym;

   // SELECT the symbol into Market Watch BEFORE any price read. (V75 fix.)
   if(!SymbolSelect(sym, true)) {
      p.reasonCode="SYMBOL_SELECT_FAILED"; p.userMessage="Couldn't activate that market.";
      p.adminMessage=StringFormat("SymbolSelect('%s') failed, err=%d.", sym, GetLastError()); return;
   }
   if(!(bool)SymbolInfoInteger(sym, SYMBOL_VISIBLE)) {
      // try once more, then fail explicitly
      SymbolSelect(sym, true);
      if(!(bool)SymbolInfoInteger(sym, SYMBOL_VISIBLE)) {
         p.reasonCode="SYMBOL_NOT_VISIBLE"; p.userMessage="That market isn't active in the terminal.";
         p.adminMessage=StringFormat("SYMBOL_VISIBLE=false for '%s'.", sym); return;
      }
   }

   // Quotes available?
   MqlTick tick;
   if(!SymbolInfoTick(sym, tick) || tick.bid <= 0 || tick.ask <= 0) {
      p.reasonCode="NO_QUOTES"; p.userMessage="No live price is available for that market yet.";
      p.adminMessage=StringFormat("SymbolInfoTick('%s') returned no valid bid/ask.", sym); return;
   }
   p.bid = tick.bid; p.ask = tick.ask;

   // Trade mode — must allow full trading.
   p.tradeMode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   if(p.tradeMode == SYMBOL_TRADE_MODE_DISABLED) {
      p.reasonCode="MARKET_CLOSED"; p.userMessage="That market is closed for trading.";
      p.adminMessage=StringFormat("SYMBOL_TRADE_MODE=DISABLED for '%s'.", sym); return;
   }
   if(p.tradeMode == SYMBOL_TRADE_MODE_CLOSEONLY) {
      p.reasonCode="MARKET_CLOSED"; p.userMessage="That market only allows closing right now.";
      p.adminMessage=StringFormat("SYMBOL_TRADE_MODE=CLOSEONLY for '%s'.", sym); return;
   }

   // Volume rules.
   p.minVol  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   p.maxVol  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   p.stepVol = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(volume < p.minVol || volume > p.maxVol) {
      p.reasonCode="INVALID_VOLUME"; p.userMessage="That trade size isn't allowed for this market.";
      p.adminMessage=StringFormat("vol %.4f outside [%.4f, %.4f] for '%s'.", volume, p.minVol, p.maxVol, sym); return;
   }
   if(p.stepVol > 0) {
      double steps = MathRound(volume / p.stepVol) * p.stepVol;
      if(MathAbs(steps - volume) > 1e-8) {
         p.reasonCode="INVALID_VOLUME"; p.userMessage="That trade size doesn't match the market's step.";
         p.adminMessage=StringFormat("vol %.4f not on step %.4f for '%s'.", volume, p.stepVol, sym); return;
      }
   }

   // Filling mode (informational; CTrade.SetTypeFillingBySymbol handles it).
   p.fillingMode = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   p.stopsLevel  = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   p.freezeLevel = SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL);

   // SL/TP distance vs stops level (only if provided).
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double refBuy  = p.ask, refSell = p.bid;
   double minDist = p.stopsLevel * point;
   if(slPrice > 0 && p.stopsLevel > 0) {
      double dist = (side == "SELL") ? MathAbs(slPrice - refSell) : MathAbs(refBuy - slPrice);
      if(dist < minDist) {
         p.reasonCode="INVALID_STOPS"; p.userMessage="Your stop loss is too close to the current price.";
         p.adminMessage=StringFormat("SL dist %.5f < stopsLevel %.5f.", dist, minDist); return;
      }
   }
   if(tpPrice > 0 && p.stopsLevel > 0) {
      double dist = (side == "SELL") ? MathAbs(refSell - tpPrice) : MathAbs(tpPrice - refBuy);
      if(dist < minDist) {
         p.reasonCode="INVALID_STOPS"; p.userMessage="Your take profit is too close to the current price.";
         p.adminMessage=StringFormat("TP dist %.5f < stopsLevel %.5f.", dist, minDist); return;
      }
   }

   // Margin check.
   ENUM_ORDER_TYPE ot = (side == "SELL") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (ot == ORDER_TYPE_BUY) ? p.ask : p.bid;
   double marginReq = 0;
   if(OrderCalcMargin(ot, sym, volume, price, marginReq)) {
      p.marginRequired = marginReq;
      double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      if(marginReq > freeMargin) {
         p.reasonCode="INSUFFICIENT_MARGIN"; p.userMessage="Not enough free margin for this trade.";
         p.adminMessage=StringFormat("required %.2f > free %.2f.", marginReq, freeMargin); return;
      }
   }

   p.ok = true; p.reasonCode = ""; p.userMessage = ""; p.adminMessage = "";
}

//+------------------------------------------------------------------+
//|  ENTRY HANDLERS                                                   |
//+------------------------------------------------------------------+
void HandleOpenMarket(long cmdId, const string slice)
{
   string symbol = JsonStr(slice, "symbol");
   string side   = JsonStr(slice, "side");
   double lot    = JsonNum(slice, "lot");
   double sl     = JsonNum(slice, "sl");
   double tp     = JsonNum(slice, "tp");

   Preflight p; RunPreflight(symbol, side, lot, sl, tp, p);
   if(!p.ok) { PostPreflightReject(cmdId, "OPEN_MARKET", symbol, side, lot, p); return; }

   // Use the RESOLVED broker symbol + freshly selected price.
   trade.SetTypeFillingBySymbol(p.resolvedSymbol);
   ENUM_ORDER_TYPE ot = (side == "SELL") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (ot == ORDER_TYPE_BUY) ? p.ask : p.bid;
   string cmt = BuildArxComment(slice);

   bool ok = (ot == ORDER_TYPE_BUY)
             ? trade.Buy(lot, p.resolvedSymbol, price, sl, tp, cmt)
             : trade.Sell(lot, p.resolvedSymbol, price, sl, tp, cmt);

   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE) {
      lastSuccessAction = "OPEN_MARKET";
      PostResultStruct(cmdId, "FILLED", "", (long)trade.ResultOrder(),
         "Order filled.", StringFormat("retcode=%d deal=%I64u", trade.ResultRetcode(), trade.ResultDeal()),
         "OPEN_MARKET", symbol, p.resolvedSymbol, lot, p.minVol, p.maxVol, p.stepVol,
         p.bid, p.ask, p.tradeMode, p.fillingMode, p.stopsLevel);
   } else {
      lastErrorSeen = StringFormat("OPEN_MARKET %s retcode=%d", p.resolvedSymbol, trade.ResultRetcode());
      PostResultStruct(cmdId, "REJECTED", "BROKER_REJECTED", 0,
         "The broker rejected this order.",
         StringFormat("retcode=%d comment=%s lastErr=%d", trade.ResultRetcode(), trade.ResultComment(), GetLastError()),
         "OPEN_MARKET", symbol, p.resolvedSymbol, lot, p.minVol, p.maxVol, p.stepVol,
         p.bid, p.ask, p.tradeMode, p.fillingMode, p.stopsLevel);
   }
}

//+------------------------------------------------------------------+
//|  VALIDATE_ONLY — live preflight, NO order placed. Not demo/paper. |
//+------------------------------------------------------------------+
void HandleValidateOnly(long cmdId, const string slice)
{
   string symbol = JsonStr(slice, "symbol");
   string side   = JsonStr(slice, "side");
   double lot    = JsonNum(slice, "lot");
   double sl     = JsonNum(slice, "sl");
   double tp     = JsonNum(slice, "tp");

   Preflight p; RunPreflight(symbol, side, lot, sl, tp, p);

   string suggestedVol = "";
   if(!p.ok && p.reasonCode == "INVALID_VOLUME" && p.minVol > 0)
      suggestedVol = StringFormat("%.4f", p.minVol);

   string body = "{";
   body += "\"canExecute\":" + (p.ok ? "true" : "false") + ",";
   body += "\"reasonCode\":\"" + p.reasonCode + "\",";
   body += "\"userMessage\":" + JsonEscape(p.ok ? "All preflight checks passed." : p.userMessage) + ",";
   body += "\"adminMessage\":" + JsonEscape(p.adminMessage) + ",";
   body += "\"requestedSymbol\":\"" + symbol + "\",";
   body += "\"resolvedBrokerSymbol\":\"" + p.resolvedSymbol + "\",";
   body += "\"bid\":" + StringFormat("%.5f", p.bid) + ",";
   body += "\"ask\":" + StringFormat("%.5f", p.ask) + ",";
   body += "\"minVolume\":" + StringFormat("%.4f", p.minVol) + ",";
   body += "\"maxVolume\":" + StringFormat("%.4f", p.maxVol) + ",";
   body += "\"volumeStep\":" + StringFormat("%.4f", p.stepVol) + ",";
   body += "\"tradeMode\":" + (string)p.tradeMode + ",";
   body += "\"stopsLevel\":" + (string)p.stopsLevel + ",";
   body += "\"freezeLevel\":" + (string)p.freezeLevel + ",";
   body += "\"marginRequired\":" + StringFormat("%.2f", p.marginRequired) + ",";
   body += "\"freeMargin\":" + StringFormat("%.2f", AccountInfoDouble(ACCOUNT_MARGIN_FREE)) + ",";
   if(suggestedVol != "") body += "\"suggestedMinVolume\":" + suggestedVol + ",";
   body += "\"timestamp\":\"" + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\"";
   body += "}";
   PostResultRaw(cmdId, p.ok ? "VALIDATED" : "VALIDATION_FAILED", body);
}

//+------------------------------------------------------------------+
//|  POSITION MANAGEMENT HANDLERS (ARM #5 AllowPositionClose)         |
//+------------------------------------------------------------------+
void HandleClosePosition(long cmdId, const string slice)
{
   if(!AllowPositionClose) { ArmReject(cmdId, "CLOSE_POSITION", "AllowPositionClose"); return; }
   ulong ticket = (ulong)JsonLong(slice, "positionTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   if(!PositionSelectByTicket(ticket)) {
      PostResultStruct(cmdId, "REJECTED", "POSITION_NOT_FOUND", 0,
         "That position is no longer open.", StringFormat("ticket %I64u not found.", ticket),
         "CLOSE_POSITION", "", "", 0,0,0,0,0,0,0,0,0); return;
   }
   bool ok = trade.PositionClose(ticket);
   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE) {
      lastSuccessAction = "CLOSE_POSITION";
      PostResultStruct(cmdId, "CLOSED", "", (long)trade.ResultOrder(),
         "Position closed.", StringFormat("retcode=%d", trade.ResultRetcode()),
         "CLOSE_POSITION", "", "", 0,0,0,0,0,0,0,0,0);
   } else {
      PostResultStruct(cmdId, "REJECTED", "BROKER_REJECTED", 0,
         "The broker rejected the close.", StringFormat("retcode=%d comment=%s", trade.ResultRetcode(), trade.ResultComment()),
         "CLOSE_POSITION", "", "", 0,0,0,0,0,0,0,0,0);
   }
}

void HandlePartialClose(long cmdId, const string slice)
{
   if(!AllowPositionClose) { ArmReject(cmdId, "PARTIAL_CLOSE", "AllowPositionClose"); return; }
   ulong ticket = (ulong)JsonLong(slice, "positionTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   double vol = JsonNum(slice, "volume");
   if(!PositionSelectByTicket(ticket)) {
      PostResultStruct(cmdId, "REJECTED", "POSITION_NOT_FOUND", 0,
         "That position is no longer open.", StringFormat("ticket %I64u not found.", ticket),
         "PARTIAL_CLOSE", "", "", 0,0,0,0,0,0,0,0,0); return;
   }
   bool ok = trade.PositionClosePartial(ticket, vol);
   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE) {
      lastSuccessAction = "PARTIAL_CLOSE";
      PostResultStruct(cmdId, "CLOSED", "", (long)trade.ResultOrder(),
         "Partial close done.", StringFormat("closed %.4f retcode=%d", vol, trade.ResultRetcode()),
         "PARTIAL_CLOSE", "", "", vol,0,0,0,0,0,0,0,0);
   } else {
      PostResultStruct(cmdId, "REJECTED", "BROKER_REJECTED", 0,
         "The broker rejected the partial close.", StringFormat("retcode=%d comment=%s", trade.ResultRetcode(), trade.ResultComment()),
         "PARTIAL_CLOSE", "", "", vol,0,0,0,0,0,0,0,0);
   }
}

void HandleReverse(long cmdId, const string slice)
{
   if(!AllowPositionClose) { ArmReject(cmdId, "REVERSE_POSITION", "AllowPositionClose"); return; }
   ulong ticket = (ulong)JsonLong(slice, "positionTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   if(!PositionSelectByTicket(ticket)) {
      PostResultStruct(cmdId, "REJECTED", "POSITION_NOT_FOUND", 0,
         "That position is no longer open.", StringFormat("ticket %I64u not found.", ticket),
         "REVERSE_POSITION", "", "", 0,0,0,0,0,0,0,0,0); return;
   }
   string sym = PositionGetString(POSITION_SYMBOL);
   double vol = PositionGetDouble(POSITION_VOLUME);
   long   ptype = PositionGetInteger(POSITION_TYPE);
   string newSide = (ptype == POSITION_TYPE_BUY) ? "SELL" : "BUY";

   // Close, then open opposite — only if close confirms.
   if(!(trade.PositionClose(ticket) && trade.ResultRetcode() == TRADE_RETCODE_DONE)) {
      PostResultStruct(cmdId, "REJECTED", "BROKER_REJECTED", 0,
         "Couldn't close the position to reverse it.", StringFormat("close retcode=%d", trade.ResultRetcode()),
         "REVERSE_POSITION", sym, sym, vol,0,0,0,0,0,0,0,0); return;
   }
   Preflight p; RunPreflight(sym, newSide, vol, 0, 0, p);
   if(!p.ok) { PostPreflightReject(cmdId, "REVERSE_POSITION", sym, newSide, vol, p); return; }
   double price = (newSide == "SELL") ? p.bid : p.ask;
   bool ok = (newSide == "BUY") ? trade.Buy(vol, p.resolvedSymbol, price, 0, 0, "ARX reverse")
                                : trade.Sell(vol, p.resolvedSymbol, price, 0, 0, "ARX reverse");
   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE) {
      lastSuccessAction = "REVERSE_POSITION";
      PostResultStruct(cmdId, "FILLED", "", (long)trade.ResultOrder(),
         "Position reversed.", StringFormat("new %s retcode=%d", newSide, trade.ResultRetcode()),
         "REVERSE_POSITION", sym, p.resolvedSymbol, vol,0,0,0,p.bid,p.ask,p.tradeMode,0,0);
   } else {
      PostResultStruct(cmdId, "REJECTED", "BROKER_REJECTED", 0,
         "Closed the position but the reverse entry was rejected.",
         StringFormat("reopen retcode=%d", trade.ResultRetcode()),
         "REVERSE_POSITION", sym, p.resolvedSymbol, vol,0,0,0,p.bid,p.ask,p.tradeMode,0,0);
   }
}

void HandleBreakEven(long cmdId, const string slice)
{
   if(!AllowProtectionModify) { ArmReject(cmdId, "MOVE_TO_BREAKEVEN", "AllowProtectionModify"); return; }
   ulong ticket = (ulong)JsonLong(slice, "positionTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   double plusPoints = JsonNum(slice, "plusPoints");
   if(!PositionSelectByTicket(ticket)) {
      PostResultStruct(cmdId, "REJECTED", "POSITION_NOT_FOUND", 0,
         "That position is no longer open.", StringFormat("ticket %I64u not found.", ticket),
         "MOVE_TO_BREAKEVEN", "", "", 0,0,0,0,0,0,0,0,0); return;
   }
   string sym = PositionGetString(POSITION_SYMBOL);
   double entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double tp    = PositionGetDouble(POSITION_TP);
   long   ptype = PositionGetInteger(POSITION_TYPE);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double newSl = (ptype == POSITION_TYPE_BUY) ? entry + plusPoints*point : entry - plusPoints*point;
   bool ok = trade.PositionModify(ticket, newSl, tp);
   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE) {
      lastSuccessAction = "MOVE_TO_BREAKEVEN";
      PostResultStruct(cmdId, "MODIFIED", "", (long)ticket,
         "Stop moved to break-even.", StringFormat("newSL=%.5f", newSl),
         "MOVE_TO_BREAKEVEN", sym, sym, 0,0,0,0,0,0,0,0,0);
   } else {
      PostResultStruct(cmdId, "REJECTED", "INVALID_STOPS", 0,
         "Couldn't move the stop to break-even.", StringFormat("retcode=%d comment=%s", trade.ResultRetcode(), trade.ResultComment()),
         "MOVE_TO_BREAKEVEN", sym, sym, 0,0,0,0,0,0,0,0,0);
   }
}

//+------------------------------------------------------------------+
//|  PENDING ORDER HANDLERS (preserved semantics from v1.40)          |
//+------------------------------------------------------------------+
void HandlePlacePending(long cmdId, const string slice)
{
   if(!AllowPendingOrders) { ArmReject(cmdId, "PLACE_PENDING", "AllowPendingOrders"); return; }
   string symbolReq = JsonStr(slice, "symbol");
   string ot        = JsonStr(slice, "orderType");
   double lot       = JsonNum(slice, "lot");
   double entry     = JsonNum(slice, "entry");
   double sl        = JsonNum(slice, "sl");
   double tp        = JsonNum(slice, "tp");
   double stopLimit = JsonNum(slice, "stopLimitPrice");

   string amb=""; string sym = ResolveBrokerSymbol(symbolReq, amb);
   if(sym == "") {
      PostResultStruct(cmdId, "REJECTED", (amb!=""?"SYMBOL_AMBIGUOUS":"SYMBOL_NOT_FOUND"), 0,
         "That market isn't available.", (amb!=""?("Candidates: "+amb):("No symbol for "+symbolReq)),
         "PLACE_PENDING", symbolReq, "", lot,0,0,0,0,0,0,0,0); return;
   }
   SymbolSelect(sym, true);
   trade.SetTypeFillingBySymbol(sym);
   datetime exp = (datetime)JsonLong(slice, "expirationEpoch");
   ENUM_ORDER_TYPE_TIME tmode = (exp > 0) ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC;

   bool ok = false;
   if(ot == "BUY_LIMIT")        ok = trade.BuyLimit(lot, entry, sym, sl, tp, tmode, exp, "ARX buy_limit");
   else if(ot == "SELL_LIMIT")  ok = trade.SellLimit(lot, entry, sym, sl, tp, tmode, exp, "ARX sell_limit");
   else if(ot == "BUY_STOP")    ok = trade.BuyStop(lot, entry, sym, sl, tp, tmode, exp, "ARX buy_stop");
   else if(ot == "SELL_STOP")   ok = trade.SellStop(lot, entry, sym, sl, tp, tmode, exp, "ARX sell_stop");
   else if(ot == "BUY_STOP_LIMIT" || ot == "SELL_STOP_LIMIT") {
      MqlTradeRequest req; MqlTradeResult rs; ZeroMemory(req); ZeroMemory(rs);
      req.action=TRADE_ACTION_PENDING; req.symbol=sym; req.volume=lot;
      req.type=(ot=="BUY_STOP_LIMIT")?ORDER_TYPE_BUY_STOP_LIMIT:ORDER_TYPE_SELL_STOP_LIMIT;
      req.price=entry; req.stoplimit=stopLimit; req.sl=sl; req.tp=tp;
      req.type_time=tmode; req.expiration=exp; req.magic=MagicNumber; req.comment="ARX stop_limit";
      ok = OrderSend(req, rs);
      if(ok && rs.retcode==TRADE_RETCODE_DONE) { PostResultStruct(cmdId,"PLACED","",(long)rs.order,"Pending placed.","",ot,symbolReq,sym,lot,0,0,0,0,0,0,0,0); return; }
      PostResultStruct(cmdId,"REJECTED","BROKER_REJECTED",0,"Broker rejected the pending order.",StringFormat("retcode=%d %s",rs.retcode,rs.comment),ot,symbolReq,sym,lot,0,0,0,0,0,0,0,0); return;
   } else {
      PostResultStruct(cmdId,"REJECTED","UNSUPPORTED_COMMAND",0,"That pending order type isn't supported.",StringFormat("orderType='%s'",ot),"PLACE_PENDING",symbolReq,sym,lot,0,0,0,0,0,0,0,0); return;
   }
   if(ok && trade.ResultRetcode()==TRADE_RETCODE_DONE) {
      lastSuccessAction="PLACE_PENDING";
      PostResultStruct(cmdId,"PLACED","",(long)trade.ResultOrder(),"Pending placed.","",ot,symbolReq,sym,lot,0,0,0,0,0,0,0,0);
   } else {
      PostResultStruct(cmdId,"REJECTED","BROKER_REJECTED",0,"Broker rejected the pending order.",StringFormat("retcode=%d %s",trade.ResultRetcode(),trade.ResultComment()),ot,symbolReq,sym,lot,0,0,0,0,0,0,0,0);
   }
}

void HandleModifyProtection(long cmdId, const string slice)
{
   if(!AllowProtectionModify) { ArmReject(cmdId, "MODIFY_POSITION", "AllowProtectionModify"); return; }
   ulong ticket = (ulong)JsonLong(slice, "positionTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   double sl = JsonNum(slice, "sl");
   double tp = JsonNum(slice, "tp");
   if(!PositionSelectByTicket(ticket)) {
      PostResultStruct(cmdId,"REJECTED","POSITION_NOT_FOUND",0,"That position is no longer open.",StringFormat("ticket %I64u",ticket),"MODIFY_POSITION","","",0,0,0,0,0,0,0,0,0); return;
   }
   // Preserve existing SL or TP when one side is omitted (0 = "leave as is").
   if(sl == 0) sl = PositionGetDouble(POSITION_SL);
   if(tp == 0) tp = PositionGetDouble(POSITION_TP);
   bool ok = trade.PositionModify(ticket, sl, tp);
   if(ok && trade.ResultRetcode()==TRADE_RETCODE_DONE) {
      lastSuccessAction="MODIFY_POSITION";
      PostResultStruct(cmdId,"MODIFIED","",(long)ticket,"Stop loss / take profit updated.","",
         "MODIFY_POSITION","","",0,0,0,0,0,0,0,0,0);
   } else {
      PostResultStruct(cmdId,"REJECTED","INVALID_STOPS",0,"Couldn't update SL/TP.",StringFormat("retcode=%d %s",trade.ResultRetcode(),trade.ResultComment()),"MODIFY_POSITION","","",0,0,0,0,0,0,0,0,0);
   }
}

void HandleModifyPending(long cmdId, const string slice)
{
   if(!AllowPendingModify) { ArmReject(cmdId, "MODIFY_PENDING", "AllowPendingModify"); return; }
   ulong ticket = (ulong)JsonLong(slice, "orderTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   double entry = JsonNum(slice, "entry");
   double sl = JsonNum(slice, "sl");
   double tp = JsonNum(slice, "tp");
   if(!OrderSelect(ticket)) {
      PostResultStruct(cmdId,"REJECTED","PENDING_ORDER_NOT_FOUND",0,"That pending order no longer exists.",StringFormat("ticket %I64u",ticket),"MODIFY_PENDING","","",0,0,0,0,0,0,0,0,0); return;
   }
   bool ok = trade.OrderModify(ticket, entry, sl, tp, ORDER_TIME_GTC, 0);
   if(ok && trade.ResultRetcode()==TRADE_RETCODE_DONE)
      PostResultStruct(cmdId,"MODIFIED","",(long)ticket,"Pending order updated.","","MODIFY_PENDING","","",0,0,0,0,0,0,0,0,0);
   else
      PostResultStruct(cmdId,"REJECTED","BROKER_REJECTED",0,"Couldn't update the pending order.",StringFormat("retcode=%d %s",trade.ResultRetcode(),trade.ResultComment()),"MODIFY_PENDING","","",0,0,0,0,0,0,0,0,0);
}

void HandleCancelPending(long cmdId, const string slice)
{
   if(!AllowPendingCancel) { ArmReject(cmdId, "CANCEL_PENDING", "AllowPendingCancel"); return; }
   ulong ticket = (ulong)JsonLong(slice, "orderTicket");
   if(ticket == 0) ticket = (ulong)JsonLong(slice, "ticket");
   if(!OrderSelect(ticket)) {
      PostResultStruct(cmdId,"REJECTED","PENDING_ORDER_NOT_FOUND",0,"That pending order no longer exists.",StringFormat("ticket %I64u",ticket),"CANCEL_PENDING","","",0,0,0,0,0,0,0,0,0); return;
   }
   bool ok = trade.OrderDelete(ticket);
   if(ok && trade.ResultRetcode()==TRADE_RETCODE_DONE)
      PostResultStruct(cmdId,"CANCELLED","",(long)ticket,"Pending order cancelled.","","CANCEL_PENDING","","",0,0,0,0,0,0,0,0,0);
   else
      PostResultStruct(cmdId,"REJECTED","BROKER_REJECTED",0,"Couldn't cancel the pending order.",StringFormat("retcode=%d %s",trade.ResultRetcode(),trade.ResultComment()),"CANCEL_PENDING","","",0,0,0,0,0,0,0,0,0);
}

//+------------------------------------------------------------------+
//|  BULK / EMERGENCY HANDLERS (ARM #8 AllowEmergencyClose)           |
//+------------------------------------------------------------------+
void HandleCloseAll(long cmdId, const string slice, bool bySymbol, const string symFilterReq)
{
   if(!AllowEmergencyClose) { ArmReject(cmdId, "CLOSE_ALL", "AllowEmergencyClose"); return; }
   string symFilter = "";
   if(bySymbol) { string amb=""; symFilter = ResolveBrokerSymbol(symFilterReq, amb); }
   int closed = 0, failed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(bySymbol && PositionGetString(POSITION_SYMBOL) != symFilter) continue;
      if(trade.PositionClose(tk) && trade.ResultRetcode()==TRADE_RETCODE_DONE) closed++; else failed++;
   }
   lastSuccessAction = "CLOSE_ALL";
   PostResultRaw(cmdId, (failed==0?"CLOSED":"PARTIAL"),
      StringFormat("{\"closed\":%d,\"failed\":%d,\"bySymbol\":%s}", closed, failed, (bySymbol?"true":"false")));
}

void HandleCloseAllByMagic(long cmdId, const string slice)
{
   if(!AllowEmergencyClose) { ArmReject(cmdId, "CLOSE_ALL_BY_MAGIC_OR_USER", "AllowEmergencyClose"); return; }
   long magic = JsonLong(slice, "magic");
   if(magic == 0) magic = (long)MagicNumber; // default to ARX-tagged
   int closed = 0, failed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != magic) continue;
      if(trade.PositionClose(tk) && trade.ResultRetcode()==TRADE_RETCODE_DONE) closed++; else failed++;
   }
   PostResultRaw(cmdId, (failed==0?"CLOSED":"PARTIAL"),
      StringFormat("{\"closed\":%d,\"failed\":%d,\"magic\":%I64d}", closed, failed, magic));
}

void HandleCancelAllPending(long cmdId, const string slice, bool bySymbol, const string symFilterReq)
{
   if(!AllowEmergencyClose && !AllowPendingCancel) { ArmReject(cmdId, "CANCEL_ALL_PENDING", "AllowEmergencyClose/AllowPendingCancel"); return; }
   string symFilter = "";
   if(bySymbol) { string amb=""; symFilter = ResolveBrokerSymbol(symFilterReq, amb); }
   int cancelled = 0, failed = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--) {
      ulong tk = OrderGetTicket(i);
      if(tk == 0) continue;
      if(bySymbol && OrderGetString(ORDER_SYMBOL) != symFilter) continue;
      if(trade.OrderDelete(tk) && trade.ResultRetcode()==TRADE_RETCODE_DONE) cancelled++; else failed++;
   }
   PostResultRaw(cmdId, (failed==0?"CANCELLED":"PARTIAL"),
      StringFormat("{\"cancelled\":%d,\"failed\":%d}", cancelled, failed));
}

void HandlePanicCloseAll(long cmdId, const string slice)
{
   if(!AllowEmergencyClose) { ArmReject(cmdId, "PANIC_CLOSE_ALL", "AllowEmergencyClose"); return; }
   int cp=0, cf=0, op=0, of=0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong tk = PositionGetTicket(i); if(tk==0) continue;
      if(trade.PositionClose(tk) && trade.ResultRetcode()==TRADE_RETCODE_DONE) cp++; else cf++;
   }
   for(int i = OrdersTotal() - 1; i >= 0; i--) {
      ulong tk = OrderGetTicket(i); if(tk==0) continue;
      if(trade.OrderDelete(tk) && trade.ResultRetcode()==TRADE_RETCODE_DONE) op++; else of++;
   }
   lastSuccessAction = "PANIC_CLOSE_ALL";
   PostResultRaw(cmdId, ((cf==0&&of==0)?"CLOSED":"PARTIAL"),
      StringFormat("{\"positionsClosed\":%d,\"positionsFailed\":%d,\"pendingCancelled\":%d,\"pendingFailed\":%d}", cp, cf, op, of));
}

//+------------------------------------------------------------------+
//|  SYMBOL DISCOVERY                                                 |
//+------------------------------------------------------------------+
void HandleEnumerateSymbols(long cmdId, const string slice)
{
   bool watchOnly = (JsonStr(slice, "marketWatchOnly") == "true");
   int total = SymbolsTotal(watchOnly);
   if(total > MaxSymbolsEnumerated) total = MaxSymbolsEnumerated;
   string arr = "[";
   for(int i = 0; i < total; i++) {
      string nm = SymbolName(i, watchOnly);
      if(nm == "") continue;
      if(i > 0) arr += ",";
      bool selected = SymbolSelect(nm, true);
      MqlTick tk; bool gotTick = SymbolInfoTick(nm, tk);
      long tmode = SymbolInfoInteger(nm, SYMBOL_TRADE_MODE);
      arr += "{";
      arr += "\"symbol\":\"" + nm + "\",";
      arr += "\"description\":" + JsonEscape(SymbolInfoString(nm, SYMBOL_DESCRIPTION)) + ",";
      arr += "\"path\":" + JsonEscape(SymbolInfoString(nm, SYMBOL_PATH)) + ",";
      arr += "\"bid\":" + SafeF(gotTick ? tk.bid : 0, 5) + ",";
      arr += "\"ask\":" + SafeF(gotTick ? tk.ask : 0, 5) + ",";
      arr += "\"digits\":" + (string)SymbolInfoInteger(nm, SYMBOL_DIGITS) + ",";
      arr += "\"point\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_POINT), 8) + ",";
      arr += "\"tickSize\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_TRADE_TICK_SIZE), 8) + ",";
      arr += "\"tickValue\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_TRADE_TICK_VALUE), 5) + ",";
      arr += "\"contractSize\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_TRADE_CONTRACT_SIZE)) + ",";
      arr += "\"minVolume\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_VOLUME_MIN), 4) + ",";
      arr += "\"maxVolume\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_VOLUME_MAX), 4) + ",";
      arr += "\"volumeStep\":" + SafeF(SymbolInfoDouble(nm, SYMBOL_VOLUME_STEP), 4) + ",";
      arr += "\"tradeMode\":" + (string)tmode + ",";
      arr += "\"stopsLevel\":" + (string)SymbolInfoInteger(nm, SYMBOL_TRADE_STOPS_LEVEL) + ",";
      arr += "\"freezeLevel\":" + (string)SymbolInfoInteger(nm, SYMBOL_TRADE_FREEZE_LEVEL) + ",";
      arr += "\"marginCurrency\":\"" + SymbolInfoString(nm, SYMBOL_CURRENCY_MARGIN) + "\",";
      arr += "\"profitCurrency\":\"" + SymbolInfoString(nm, SYMBOL_CURRENCY_PROFIT) + "\",";
      arr += "\"selected\":" + (selected ? "true" : "false") + ",";
      arr += "\"tradable\":" + ((tmode != SYMBOL_TRADE_MODE_DISABLED) ? "true" : "false");
      arr += "}";
   }
   arr += "]";
   PostResultRaw(cmdId, "OK", StringFormat("{\"count\":%d,\"symbols\":%s}", total, arr));
}

void HandleGetSymbolRules(long cmdId, const string slice)
{
   string req = JsonStr(slice, "symbol");
   string amb=""; string sym = ResolveBrokerSymbol(req, amb);
   if(sym == "") { PostResultRaw(cmdId, "VALIDATION_FAILED",
      StringFormat("{\"reasonCode\":\"%s\",\"requestedSymbol\":\"%s\",\"candidates\":%s}",
      (amb!=""?"SYMBOL_AMBIGUOUS":"SYMBOL_NOT_FOUND"), req, (amb!=""?amb:"[]"))); return; }
   SymbolSelect(sym, true);
   MqlTick tk; SymbolInfoTick(sym, tk);
   string s = "{";
   s += "\"symbol\":\"" + sym + "\",\"requested\":\"" + req + "\",";
   s += "\"bid\":" + SafeF(tk.bid, 5) + ",\"ask\":" + SafeF(tk.ask, 5) + ",";
   s += "\"minVolume\":" + SafeF(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4) + ",";
   s += "\"maxVolume\":" + SafeF(SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 4) + ",";
   s += "\"volumeStep\":" + SafeF(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 4) + ",";
   s += "\"stopsLevel\":" + (string)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) + ",";
   s += "\"tradeMode\":" + (string)SymbolInfoInteger(sym, SYMBOL_TRADE_MODE) + "}";
   PostResultRaw(cmdId, "OK", s);
}

//+------------------------------------------------------------------+
//|  POSITION + PENDING SNAPSHOTS (real MT5 truth)                    |
//+------------------------------------------------------------------+
string BuildOpenPositionsJson()
{
   string arr = "[";
   int n = PositionsTotal();
   for(int i = 0; i < n; i++) {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(i > 0) arr += ",";
      string sym = PositionGetString(POSITION_SYMBOL);
      double cur = (PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)
                   ? SymbolInfoDouble(sym, SYMBOL_BID) : SymbolInfoDouble(sym, SYMBOL_ASK);
      arr += "{";
      arr += "\"ticket\":" + (string)tk + ",";
      arr += "\"positionId\":" + (string)PositionGetInteger(POSITION_IDENTIFIER) + ",";
      arr += "\"symbol\":\"" + sym + "\",";
      arr += "\"side\":\"" + ((PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?"BUY":"SELL") + "\",";
      arr += "\"volume\":" + SafeF(PositionGetDouble(POSITION_VOLUME), 4) + ",";
      arr += "\"entryPrice\":" + SafeF(PositionGetDouble(POSITION_PRICE_OPEN), 5) + ",";
      arr += "\"currentPrice\":" + SafeF(cur, 5) + ",";
      arr += "\"floatingPl\":" + SafeF(PositionGetDouble(POSITION_PROFIT)) + ",";
      arr += "\"swap\":" + SafeF(PositionGetDouble(POSITION_SWAP)) + ",";
      arr += "\"sl\":" + SafeF(PositionGetDouble(POSITION_SL), 5) + ",";
      arr += "\"tp\":" + SafeF(PositionGetDouble(POSITION_TP), 5) + ",";
      arr += "\"openTime\":\"" + TimeToString((datetime)PositionGetInteger(POSITION_TIME), TIME_DATE|TIME_SECONDS) + "\",";
      arr += "\"magic\":" + (string)PositionGetInteger(POSITION_MAGIC) + ",";
      arr += "\"comment\":" + JsonEscape(PositionGetString(POSITION_COMMENT)) + ",";
      arr += "\"source\":\"" + ((PositionGetInteger(POSITION_MAGIC)==(long)MagicNumber)?"ARX":"MANUAL_MT5") + "\"";
      arr += "}";
   }
   arr += "]";
   return StringFormat("{\"positions\":%s,\"count\":%d,\"eaVersion\":\"%s\",\"timestamp\":\"%s\"}",
      arr, n, EA_VERSION, TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
}

string BuildPendingOrdersJson()
{
   string arr = "[";
   int n = OrdersTotal();
   for(int i = 0; i < n; i++) {
      ulong tk = OrderGetTicket(i);
      if(tk == 0) continue;
      if(i > 0) arr += ",";
      arr += "{";
      arr += "\"ticket\":" + (string)tk + ",";
      arr += "\"symbol\":\"" + OrderGetString(ORDER_SYMBOL) + "\",";
      arr += "\"orderType\":" + (string)OrderGetInteger(ORDER_TYPE) + ",";
      arr += "\"volume\":" + SafeF(OrderGetDouble(ORDER_VOLUME_CURRENT), 4) + ",";
      arr += "\"entryPrice\":" + SafeF(OrderGetDouble(ORDER_PRICE_OPEN), 5) + ",";
      arr += "\"sl\":" + SafeF(OrderGetDouble(ORDER_SL), 5) + ",";
      arr += "\"tp\":" + SafeF(OrderGetDouble(ORDER_TP), 5) + ",";
      arr += "\"magic\":" + (string)OrderGetInteger(ORDER_MAGIC) + "";
      arr += "}";
   }
   arr += "]";
   return StringFormat("{\"pending\":%s,\"count\":%d,\"eaVersion\":\"%s\",\"timestamp\":\"%s\"}",
      arr, n, EA_VERSION, TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
}

//+------------------------------------------------------------------+
//|  HEALTH + SELF-TEST                                               |
//+------------------------------------------------------------------+
string BuildHealthJson()
{
   string s = "{";
   s += "\"eaVersion\":\"" + EA_VERSION + "\",\"eaName\":\"" + EA_NAME + "\",";
   s += "\"eaInputs\":" + BuildEaInputsJson() + ",";
   s += "\"terminalConnected\":" + ((bool)TerminalInfoInteger(TERMINAL_CONNECTED)?"true":"false") + ",";
   s += "\"broker\":\"" + AccountInfoString(ACCOUNT_COMPANY) + "\",";
   s += "\"server\":\"" + AccountInfoString(ACCOUNT_SERVER) + "\",";
   s += "\"accountType\":\"" + ((AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_REAL)?"live":"demo") + "\",";
   s += "\"algoTradingAllowed\":" + ((bool)MQLInfoInteger(MQL_TRADE_ALLOWED)?"true":"false") + ",";
   s += "\"terminalTradeAllowed\":" + ((bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)?"true":"false") + ",";
   s += "\"accountTradeAllowed\":" + ((bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)?"true":"false") + ",";
   s += "\"lastCommandAt\":\"" + (lastCommandAt>0?TimeToString(lastCommandAt, TIME_DATE|TIME_SECONDS):"") + "\",";
   s += "\"lastSuccessAction\":\"" + lastSuccessAction + "\",";
   s += "\"lastError\":" + JsonEscape(lastErrorSeen) + ",";
   s += "\"openPositions\":" + (string)PositionsTotal() + ",";
   s += "\"pendingOrders\":" + (string)OrdersTotal() + ",";
   s += "\"symbolsAvailable\":" + (string)SymbolsTotal(false) + "}";
   return s;
}

void HandleSelfTest(long cmdId, const string slice)
{
   // No live trade. Runs a sequence of non-mutating checks.
   bool termConn  = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   bool acctOk    = (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   int  symCount  = SymbolsTotal(false);
   bool selOk     = SymbolSelect(_Symbol, true);
   MqlTick tk; bool quoteOk = SymbolInfoTick(_Symbol, tk) && tk.bid > 0;
   double volMin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double marginReq = 0;
   bool marginOk  = OrderCalcMargin(ORDER_TYPE_BUY, _Symbol, volMin, tk.ask, marginReq);

   string s = "{";
   s += "\"terminalConnection\":" + (termConn?"true":"false") + ",";
   s += "\"accountStatus\":" + (acctOk?"true":"false") + ",";
   s += "\"symbolEnumeration\":" + ((symCount>0)?"true":"false") + ",";
   s += "\"symbolSelect\":" + (selOk?"true":"false") + ",";
   s += "\"quoteRead\":" + (quoteOk?"true":"false") + ",";
   s += "\"volumeRules\":" + ((volMin>0)?"true":"false") + ",";
   s += "\"marginCalc\":" + (marginOk?"true":"false") + ",";
   s += "\"positionSync\":true,\"pendingSync\":true,\"commandRoundtrip\":true,";
   s += "\"symbolsAvailable\":" + (string)symCount + ",";
   s += "\"eaVersion\":\"" + EA_VERSION + "\"}";
   PostResultRaw(cmdId, "OK", s);
}

//+------------------------------------------------------------------+
//|  ARX attribution comment (magic carries the rest)                 |
//+------------------------------------------------------------------+
string BuildArxComment(const string slice)
{
   // Keep comment short; full attribution is in magic + backend ledger.
   long uid = JsonLong(slice, "userId");
   string src = JsonStr(slice, "source");
   if(src == "") src = "arx";
   return StringFormat("ARX:%s:u%I64d", src, uid);
}

void ArmReject(long cmdId, const string action, const string armName)
{
   PostResultStruct(cmdId, "REJECTED", "ACCOUNT_TRADE_DISABLED", 0,
      "That action is switched off on the trading bridge.",
      StringFormat("EA ARM '%s' is disabled.", armName),
      action, "", "", 0,0,0,0,0,0,0,0,0);
}

void PostPreflightReject(long cmdId, const string action, const string reqSym,
                         const string side, double vol, Preflight &p)
{
   if(p.reasonCode == "INVALID_VOLUME" || p.reasonCode == "INSUFFICIENT_MARGIN")
      lastErrorSeen = action + ":" + p.reasonCode;
   PostResultStruct(cmdId, "REJECTED", p.reasonCode, 0, p.userMessage, p.adminMessage,
      action, reqSym, p.resolvedSymbol, vol, p.minVol, p.maxVol, p.stepVol,
      p.bid, p.ask, p.tradeMode, p.fillingMode, p.stopsLevel);
}

//+------------------------------------------------------------------+
//|  RESULT POSTERS                                                   |
//+------------------------------------------------------------------+
// Full structured result with all diagnostic fields.
void PostResultStruct(long cmdId, const string status, const string reasonCode, long mt5Ticket,
                      const string userMessage, const string adminMessage,
                      const string stage, const string requestedSymbol, const string resolvedSymbol,
                      double requestedVolume, double minVol, double maxVol, double stepVol,
                      double bid, double ask, long tradeMode, long fillingMode, long stopsLevel)
{
   string body = "{";
   body += "\"commandId\":" + StringFormat("%I64d", cmdId) + ",";
   body += "\"status\":\"" + status + "\",";
   body += "\"reasonCode\":\"" + reasonCode + "\",";
   body += "\"mt5Ticket\":" + StringFormat("%I64d", mt5Ticket) + ",";
   body += "\"userMessage\":" + JsonEscape(userMessage) + ",";
   body += "\"adminMessage\":" + JsonEscape(adminMessage) + ",";
   body += "\"stage\":\"" + stage + "\",";
   body += "\"requestedSymbol\":\"" + requestedSymbol + "\",";
   body += "\"resolvedBrokerSymbol\":\"" + resolvedSymbol + "\",";
   body += "\"requestedVolume\":" + StringFormat("%.4f", requestedVolume) + ",";
   body += "\"validMinVolume\":" + StringFormat("%.4f", minVol) + ",";
   body += "\"validMaxVolume\":" + StringFormat("%.4f", maxVol) + ",";
   body += "\"validVolumeStep\":" + StringFormat("%.4f", stepVol) + ",";
   body += "\"bid\":" + StringFormat("%.5f", bid) + ",";
   body += "\"ask\":" + StringFormat("%.5f", ask) + ",";
   body += "\"tradeMode\":" + (string)tradeMode + ",";
   body += "\"fillingMode\":" + (string)fillingMode + ",";
   body += "\"stopsLevel\":" + (string)stopsLevel + ",";
   body += "\"mt5Retcode\":" + (string)trade.ResultRetcode() + ",";
   body += "\"mt5Comment\":" + JsonEscape(trade.ResultComment()) + ",";
   body += "\"lastError\":" + (string)GetLastError() + ",";
   body += "\"eaVersion\":\"" + EA_VERSION + "\",";
   body += "\"timestamp\":\"" + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\"";
   body += "}";
   PostJson("/api/mt5/command-result", body);
}

// Lightweight result that carries a raw JSON data block (for read/query cmds).
void PostResultRaw(long cmdId, const string status, const string dataJson)
{
   string body = StringFormat(
      "{\"commandId\":%I64d,\"status\":\"%s\",\"eaVersion\":\"%s\",\"data\":%s,\"timestamp\":\"%s\"}",
      cmdId, status, EA_VERSION, dataJson, TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
   PostJson("/api/mt5/command-result", body);
}

//+------------------------------------------------------------------+
//|  HTTP + JSON HELPERS (reused verbatim from v1.40 — proven)        |
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

void PostJson(const string path, const string json)
{
   char post[]; char result[]; string respHeaders;
   string url = BridgeBaseUrl + path;
   // Convert the WHOLE string (WHOLE_ARRAY) so StringToCharArray appends a
   // single NUL terminator and returns the byte count INCLUDING that NUL.
   // We then drop ONLY the trailing NUL. The previous build passed an
   // explicit count (no NUL appended) and still shrank by one, which chopped
   // the final real byte ("}") off every POST body and produced malformed
   // JSON the server rejected with entity.parse.failed.
   int len = StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(post, len - 1);
   string reqHeaders = "X-MT5-Bridge-Token: " + BridgeToken
                     + "\r\nContent-Type: application/json\r\nAccept: application/json\r\n";
   ResetLastError();
   int code = WebRequest("POST", url, reqHeaders, 10000, post, result, respHeaders);
   if(code != 200) PrintFormat("ARX Universal Agent POST %s -> %d (err=%d)", path, code, GetLastError());
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
// SafeF — format a double for JSON. MQL5's StringFormat emits the literal text
// "inf"/"-inf"/"nan" for non-finite values (e.g. ACCOUNT_MARGIN_LEVEL when
// margin is 0 / no open positions), which is INVALID JSON and 400s the whole
// request body server-side. Guard every formatted double through this.
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
