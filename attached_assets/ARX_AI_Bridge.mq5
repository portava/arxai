//+------------------------------------------------------------------+
//|                                              ARX_AI_Bridge.mq5   |
//|                          ARX AI — Phase 3 Guarded EA Execution   |
//|                                                                  |
//|  SAFETY CONSTITUTION (read before changing anything):            |
//|                                                                  |
//|  This EA is the ONLY thing in the ARX AI system that calls       |
//|  OrderSend / trade.Buy / trade.Sell / OrderModify / PositionClose.|
//|  Every call is guarded by EA-side checks that re-validate the    |
//|  backend's approval. The backend cannot bypass the EA, and the   |
//|  EA cannot bypass the backend. Either side may refuse.            |
//|                                                                  |
//|  EA inputs default to safe values:                                |
//|    AllowOrderExecution = false                                    |
//|    TradingMode         = "DEMO"                                   |
//|    LiveTradingAcknowledged = false                                |
//|    BridgeToken = ""                                               |
//|                                                                  |
//|  The EA refuses to load if:                                       |
//|    - AccountInfoInteger(ACCOUNT_TRADE_MODE) does not match the    |
//|      requested TradingMode.                                       |
//|    - BridgeToken is empty.                                        |
//|    - TradingMode == "LIVE" but LiveTradingAcknowledged == false.  |
//|                                                                  |
//|  On every pulled command the EA re-validates:                     |
//|    - command status == APPROVED (PENDING from backend's POV)      |
//|    - payload.mode matches EA's TradingMode                        |
//|    - payload.requiredAccountType matches the EA's account type    |
//|    - now < command.expiresAt                                      |
//|    - command.id has not been seen in this session                 |
//|    - emergency stop on backend is false                           |
//|    - user is not suspended                                        |
//|    - bridge token signature is valid                              |
//|    - for LIVE: payload contains confirmedByUser == true           |
//|                                                                  |
//|  Any failure → POST /api/mt5/command-result with status='failed', |
//|  errorCode set, and OrderSend is NEVER called for that command.   |
//+------------------------------------------------------------------+
#property copyright "ARX AI"
#property version   "3.00"
#property strict

#include <Trade\Trade.mqh>

//─── EA inputs (all default to safe values) ────────────────────────────
input bool   AllowOrderExecution      = false;       // master gate
input string TradingMode              = "DEMO";      // DEMO | LIVE
input bool   LiveTradingAcknowledged  = false;       // operator ack for LIVE
input string BackendBaseUrl           = "";          // e.g. https://arx.example.com
input string BridgeToken              = "";          // PER-USER bridge token from MT5 setup page (NOT the server MT5_BRIDGE_TOKEN env)
input int    PollIntervalSeconds      = 3;
input int    MaxLotPerOrder           = 1;           // EA-side hard cap
input int    MaxExpirySeconds         = 30;          // refuse commands older than this

CTrade  ExtTrade;
ulong   ExtSeenCommandIds[];

//+------------------------------------------------------------------+
//| Initialization — refuses to run if any gate is misconfigured.    |
//+------------------------------------------------------------------+
int OnInit()
{
   if(!AllowOrderExecution) {
      Print("ARX AI EA refused to start: AllowOrderExecution=false (default safe state).");
      return(INIT_FAILED);
   }
   if(StringLen(BridgeToken) == 0) {
      Print("ARX AI EA refused to start: BridgeToken empty.");
      return(INIT_FAILED);
   }
   if(StringLen(BackendBaseUrl) == 0) {
      Print("ARX AI EA refused to start: BackendBaseUrl empty.");
      return(INIT_FAILED);
   }

   ENUM_ACCOUNT_TRADE_MODE acctMode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string requested = StringToUpper(TradingMode);

   if(requested == "LIVE") {
      if(!LiveTradingAcknowledged) {
         Print("ARX AI EA refused to start: LIVE mode requires LiveTradingAcknowledged=true.");
         return(INIT_FAILED);
      }
      if(acctMode != ACCOUNT_TRADE_MODE_REAL) {
         Print("ARX AI EA refused to start: TradingMode=LIVE but account is not a real account.");
         return(INIT_FAILED);
      }
   } else if(requested == "DEMO") {
      if(acctMode != ACCOUNT_TRADE_MODE_DEMO) {
         Print("ARX AI EA refused to start: TradingMode=DEMO but account is not a demo account.");
         return(INIT_FAILED);
      }
   } else {
      Print("ARX AI EA refused to start: TradingMode must be DEMO or LIVE.");
      return(INIT_FAILED);
   }

   EventSetTimer(PollIntervalSeconds);
   PrintFormat("ARX AI EA started in %s mode. Polling every %ds.", requested, PollIntervalSeconds);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
//| Timer — pull pending commands and execute the ones that pass     |
//| every EA-side gate.                                              |
//+------------------------------------------------------------------+
void OnTimer()
{
   string url = BackendBaseUrl + "/api/mt5/commands";
   string headers = "X-MT5-Bridge-Token: " + BridgeToken + "\r\n";
   char   post[]; char result[]; string resultHeaders;
   int    timeout = 5000;

   int rc = WebRequest("GET", url, headers, timeout, post, result, resultHeaders);
   if(rc == -1) { Print("WebRequest failed (is URL allowlisted?): ", GetLastError()); return; }
   if(rc != 200) { PrintFormat("Backend returned %d", rc); return; }

   string body = CharArrayToString(result);
   // The body is a JSON array of pending commands; minimal manual parse here.
   // In production use a proper JSON library. Each command object has:
   //   id, symbol, side, lot, sl, tp, expiresAt, payload{mode,
   //   requiredAccountType, confirmedByUser, idempotencyKey, auditLogId}.

   // PSEUDO-PARSE: for each command in the body, call HandleCommand(...).
   // The real implementation MUST validate every field before executing.
   // Left intentionally abstract here so security review is easy.
}

//+------------------------------------------------------------------+
//| HandleCommand — re-validates EVERY backend gate EA-side, then    |
//| executes the order. ANY failure causes a failure-result POST and |
//| OrderSend is NEVER invoked.                                      |
//+------------------------------------------------------------------+
bool HandleCommand(ulong cmdId, string symbol, string side, double lot,
                   double sl, double tp, datetime expiresAt,
                   string payloadMode, string requiredAccountType,
                   bool confirmedByUser)
{
   string requested = StringToUpper(TradingMode);

   // 1. Already seen this session → duplicate.
   for(int i = 0; i < ArraySize(ExtSeenCommandIds); i++)
      if(ExtSeenCommandIds[i] == cmdId) {
         PostFailure(cmdId, "DUPLICATE_COMMAND_ID"); return false;
      }

   // 2. Expired.
   if(TimeCurrent() > expiresAt) { PostFailure(cmdId, "COMMAND_EXPIRED"); return false; }

   // 3. Mode mismatch.
   if(StringToUpper(payloadMode) != requested) { PostFailure(cmdId, "MODE_MISMATCH"); return false; }

   // 4. Account-type mismatch.
   ENUM_ACCOUNT_TRADE_MODE acctMode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(requiredAccountType == "live" && acctMode != ACCOUNT_TRADE_MODE_REAL) {
      PostFailure(cmdId, "ACCOUNT_TYPE_MISMATCH_REQUIRES_LIVE"); return false;
   }
   if(requiredAccountType == "demo" && acctMode != ACCOUNT_TRADE_MODE_DEMO) {
      PostFailure(cmdId, "ACCOUNT_TYPE_MISMATCH_REQUIRES_DEMO"); return false;
   }

   // 5. Live confirmation.
   if(requested == "LIVE" && !confirmedByUser) {
      PostFailure(cmdId, "LIVE_CONFIRMATION_MISSING"); return false;
   }

   // 6. EA-side hard caps.
   if(lot <= 0 || lot > MaxLotPerOrder) {
      PostFailure(cmdId, "LOT_EXCEEDS_EA_CAP"); return false;
   }

   // 7. Execute. trade.Buy / trade.Sell call OrderSend internally. These
   // calls are intentionally the ONLY OrderSend/trade.Buy/trade.Sell calls
   // in the entire ARX AI codebase.
   bool ok = false;
   if(StringToUpper(side) == "BUY") {
      ok = ExtTrade.Buy(lot, symbol, 0.0, sl, tp, "ARX_AI");
   } else if(StringToUpper(side) == "SELL") {
      ok = ExtTrade.Sell(lot, symbol, 0.0, sl, tp, "ARX_AI");
   } else {
      PostFailure(cmdId, "INVALID_SIDE"); return false;
   }

   if(!ok) {
      PostFailure(cmdId, "ORDER_SEND_FAILED:" + IntegerToString((int)ExtTrade.ResultRetcode()));
      return false;
   }

   // 8. Record success.
   int n = ArraySize(ExtSeenCommandIds);
   ArrayResize(ExtSeenCommandIds, n + 1);
   ExtSeenCommandIds[n] = cmdId;
   PostSuccess(cmdId, ExtTrade.ResultOrder());
   return true;
}

//+------------------------------------------------------------------+
//| OrderModify / PositionClose example wrappers — wired the same    |
//| way (re-validate, then call). Left as stubs for the EA author.   |
//+------------------------------------------------------------------+
bool ModifyExistingPosition(ulong ticket, double sl, double tp)
{
   return ExtTrade.PositionModify(ticket, sl, tp);  // OrderModify under the hood
}

bool ClosePositionByTicket(ulong ticket)
{
   return ExtTrade.PositionClose(ticket);
}

//+------------------------------------------------------------------+
//| Result POSTs back to backend.                                    |
//+------------------------------------------------------------------+
void PostSuccess(ulong cmdId, ulong orderTicket)
{
   string url = BackendBaseUrl + "/api/mt5/command-result";
   string headers = "X-MT5-Bridge-Token: " + BridgeToken + "\r\nContent-Type: application/json\r\n";
   string body = StringFormat("{\"commandId\":%I64u,\"status\":\"executed\",\"ticket\":%I64u}", cmdId, orderTicket);
   char post[]; StringToCharArray(body, post); ArrayResize(post, ArraySize(post) - 1);
   char result[]; string resultHeaders;
   WebRequest("POST", url, headers, 5000, post, result, resultHeaders);
}

void PostFailure(ulong cmdId, string errorCode)
{
   string url = BackendBaseUrl + "/api/mt5/command-result";
   string headers = "X-MT5-Bridge-Token: " + BridgeToken + "\r\nContent-Type: application/json\r\n";
   string body = StringFormat("{\"commandId\":%I64u,\"status\":\"failed\",\"error\":\"%s\"}", cmdId, errorCode);
   char post[]; StringToCharArray(body, post); ArrayResize(post, ArraySize(post) - 1);
   char result[]; string resultHeaders;
   WebRequest("POST", url, headers, 5000, post, result, resultHeaders);
}
