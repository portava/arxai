//+------------------------------------------------------------------+
//| ReplitMT5BridgeEA_DemoExec_v130.mq5                              |
//|                                                                  |
//| ARX AI MT5 bridge — DEMO-ONLY execution layer.                   |
//|                                                                  |
//| This is a SEPARATE EA file. Do NOT replace v1.21 with this.      |
//| v1.21 is the read-only EA and stays the production safety       |
//| baseline for live broker accounts. v1.30 may ONLY be attached   |
//| to a DEMO MT5 account chart.                                    |
//|                                                                  |
//| HARD SAFETY MATRIX (every condition must hold to send an order): |
//|   1. AccountInfoInteger(ACCOUNT_TRADE_MODE) ==                   |
//|        ACCOUNT_TRADE_MODE_DEMO                                   |
//|   2. Environment input == "demo"                                 |
//|   3. DemoExecutionMode      == true                              |
//|   4. AllowDemoOrderExecution == true                             |
//|   5. ReadOnlyMode           == false                             |
//|   6. RequireDemoAccount     == true (default; if user flips it,  |
//|        EA still re-validates ACCOUNT_TRADE_MODE_DEMO via #1)     |
//|   7. command.action         == "DEMO_MARKET_ORDER"               |
//|   8. command.demoOnly       == true (parsed from detail JSON)    |
//|   9. command.lot            <= MaxDemoLot (hard 0.01 default)    |
//|  10. command.side           in {"BUY","SELL"}                    |
//|  11. command.symbol         non-empty and selectable             |
//|                                                                  |
//| Defaults: DemoExecutionMode=false, AllowDemoOrderExecution=false |
//| → out-of-the-box this EA refuses execution. Two manual flips     |
//| inside the MT5 chart inputs are required to arm it. No auth /    |
//| token changes vs v1.21.                                          |
//|                                                                  |
//| No martingale. No retry-on-fail. No order pyramiding. ONE        |
//| OrderSend per command, then ack the result and move on.          |
//|                                                                  |
//| BridgeToken is NEVER printed to the log (same as v1.21).         |
//+------------------------------------------------------------------+
#property copyright "Replit ARX AI Trading Bridge"
#property version   "1.30"
#property strict
#property description "DEMO-ONLY execution EA. Refuses real accounts. Max 0.01 lot. Two manual arming flips required."

#include <Trade/Trade.mqh>

//--- Inputs --------------------------------------------------------
input string  ServerBaseUrl              = "https://your-replit-app.replit.app";
input string  BridgeToken                = "";       // = MT5_BRIDGE_TOKEN secret. NEVER printed.
input string  Environment                = "demo";   // MUST be "demo" to arm execution.
input string  AccountId                  = "";       // Optional override; defaults to ACCOUNT_LOGIN.
input bool    ReadOnlyMode               = false;    // v1.30: default FALSE (heartbeat-only EAs should use v1.21).
input bool    DemoExecutionMode          = false;    // ARM #1: must be true to consider executing.
input bool    AllowDemoOrderExecution    = false;    // ARM #2: must be true to actually call OrderSend.
input bool    RequireDemoAccount         = true;     // Defence-in-depth: also re-checks ACCOUNT_TRADE_MODE.
input double  MaxDemoLot                 = 0.01;     // Hard cap; commands above this are refused.
input int     PollIntervalSeconds        = 2;
input bool    SendHeartbeat              = true;
input bool    SendAccountSnapshot        = true;
input bool    SendPositionsSnapshot      = true;
input int     RequestTimeoutMs           = 5000;
input int     OrderDeviationPoints       = 20;
input int     OrderMagicNumber           = 13037;    // ARX demo-exec magic
input bool    VerboseDiagnostics         = true;

//--- Constants -----------------------------------------------------
#define HDR_TOKEN_NAME "X-MT5-Bridge-Token"
#define PLACEHOLDER_URL "https://your-replit-app.replit.app"

//--- State ---------------------------------------------------------
datetime g_lastHeartbeatAt   = 0;
datetime g_lastAccountSyncAt = 0;
datetime g_lastPositionSyncAt= 0;
datetime g_lastPollAt        = 0;
int      g_heartbeatPeriodS  = 5;
int      g_snapshotPeriodS   = 5;
long     g_heartbeatAttempts = 0;
long     g_heartbeatSuccess  = 0;
long     g_heartbeatFailure  = 0;
long     g_demoOrdersSent    = 0;
long     g_demoOrdersRefused = 0;

CTrade g_trade;

//+------------------------------------------------------------------+
//| Helpers (mirror v1.21)                                           |
//+------------------------------------------------------------------+
string IsoNow()
{
   datetime t = TimeGMT();
   MqlDateTime mdt;
   TimeToStruct(t, mdt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
      mdt.year, mdt.mon, mdt.day, mdt.hour, mdt.min, mdt.sec);
}

string EffectiveAccountId()
{
   if(StringLen(AccountId) > 0) return AccountId;
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   return IntegerToString(login);
}

string SideFromPosType(long ptype)
{
   if(ptype == POSITION_TYPE_BUY)  return "BUY";
   if(ptype == POSITION_TYPE_SELL) return "SELL";
   return "UNKNOWN";
}

string NormalizedBaseUrl()
{
   string u = ServerBaseUrl;
   while(StringLen(u) > 0 && StringGetCharacter(u, StringLen(u) - 1) == '/')
      u = StringSubstr(u, 0, StringLen(u) - 1);
   return u;
}

string ValidateServerBaseUrl()
{
   string u = ServerBaseUrl;
   if(StringLen(u) == 0)                     return "ServerBaseUrl is BLANK.";
   if(u == PLACEHOLDER_URL)                  return "ServerBaseUrl is the placeholder.";
   if(StringFind(u, "your-replit-app") >= 0) return "ServerBaseUrl still placeholder.";
   if(StringFind(u, "http") != 0)            return "ServerBaseUrl must start with http(s)://.";
   if(StringFind(u, " ") >= 0)               return "ServerBaseUrl contains whitespace.";
   return "";
}

string BuildHeaders()
{
   return StringFormat("%s: %s\r\nContent-Type: application/json\r\n",
                       HDR_TOKEN_NAME, BridgeToken);
}

string ExplainWebRequestError(int err)
{
   if(err == 4014) return "ERR_FUNCTION_NOT_ALLOWED — Tools→Options→Expert Advisors→Allow WebRequest.";
   if(err == 4060) return "ERR_FUNCTION_NOT_CONFIRMED — add the URL in WebRequest allowlist.";
   if(err == 5200) return "ERR_WEBREQUEST_INVALID_ADDRESS.";
   if(err == 5201) return "ERR_WEBREQUEST_CONNECT_FAILED.";
   if(err == 5202) return "ERR_WEBREQUEST_TIMEOUT.";
   if(err == 5203) return "ERR_WEBREQUEST_REQUEST_FAILED.";
   return StringFormat("WebRequest err=%d", err);
}

//+------------------------------------------------------------------+
//| Minimal JSON helpers                                             |
//+------------------------------------------------------------------+
string JString(string v)
{
   string out = "\"";
   for(int i = 0; i < StringLen(v); i++)
   {
      ushort c = StringGetCharacter(v, i);
      if(c == '\\' || c == '"') { out += "\\"; out += ShortToString(c); }
      else if(c == '\n')        { out += "\\n"; }
      else if(c == '\r')        { out += "\\r"; }
      else if(c == '\t')        { out += "\\t"; }
      else                      { out += ShortToString(c); }
   }
   out += "\"";
   return out;
}
string JNumber(double v, int digits) { if(!MathIsValidNumber(v)) v = 0.0; return DoubleToString(v, digits); }
string JBool(bool v)                  { return v ? "true" : "false"; }
string JLong(long v)                  { return IntegerToString(v); }
string JULong(ulong v)                { return IntegerToString((long)v); }

string SafeBodyPreview(string body)
{
   string s = body;
   if(StringLen(s) > 200) s = StringSubstr(s, 0, 200) + "…";
   return s;
}

long JsonReadInt(string json, string key)
{
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return 0;
   pos += StringLen(needle);
   while(pos < StringLen(json) && StringGetCharacter(json, pos) == ' ') pos++;
   string acc = "";
   while(pos < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, pos);
      if((ch < '0' || ch > '9') && ch != '-') break;
      acc += ShortToString(ch); pos++;
   }
   return (long)StringToInteger(acc);
}

double JsonReadDouble(string json, string key)
{
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return 0.0;
   pos += StringLen(needle);
   while(pos < StringLen(json) && StringGetCharacter(json, pos) == ' ') pos++;
   string acc = "";
   while(pos < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, pos);
      if((ch < '0' || ch > '9') && ch != '-' && ch != '.') break;
      acc += ShortToString(ch); pos++;
   }
   return StringToDouble(acc);
}

string JsonReadString(string json, string key)
{
   string needle = "\"" + key + "\":\"";
   int pos = StringFind(json, needle);
   if(pos < 0) return "";
   pos += StringLen(needle);
   string acc = "";
   while(pos < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, pos);
      if(ch == '"') break;
      if(ch == '\\' && pos + 1 < StringLen(json)) { pos++; acc += ShortToString(StringGetCharacter(json, pos)); pos++; continue; }
      acc += ShortToString(ch); pos++;
   }
   return acc;
}

bool JsonContainsLiteralTrue(string json, string key)
{
   // Match `"key":true` allowing one space.
   string n1 = "\"" + key + "\":true";
   string n2 = "\"" + key + "\": true";
   return (StringFind(json, n1) >= 0) || (StringFind(json, n2) >= 0);
}

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
bool HttpPost(string path, string body, string &resp, string tag)
{
   string url = NormalizedBaseUrl() + path;
   string headers = BuildHeaders();
   char data[]; StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   if(ArraySize(data) > 0 && data[ArraySize(data)-1] == 0) ArrayResize(data, ArraySize(data) - 1);
   char result[]; string respHeaders;
   ResetLastError();
   int code = WebRequest("POST", url, headers, RequestTimeoutMs, data, result, respHeaders);
   int err  = GetLastError();
   resp = (ArraySize(result) > 0) ? CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8) : "";
   if(VerboseDiagnostics)
      PrintFormat("[ARX-DEMO][%s] POST %s -> code=%d err=%d body[:200]=%s",
                  tag, path, code, err, SafeBodyPreview(resp));
   if(code == 200 || code == 201) return true;
   if(code == -1 && VerboseDiagnostics)
      PrintFormat("[ARX-DEMO][%s] WebRequest reason: %s", tag, ExplainWebRequestError(err));
   return false;
}

bool HttpGet(string path, string &resp, string tag)
{
   string url = NormalizedBaseUrl() + path;
   string headers = BuildHeaders();
   char data[]; char result[]; string respHeaders;
   ResetLastError();
   int code = WebRequest("GET", url, headers, RequestTimeoutMs, data, result, respHeaders);
   int err  = GetLastError();
   resp = (ArraySize(result) > 0) ? CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8) : "";
   if(VerboseDiagnostics)
      PrintFormat("[ARX-DEMO][%s] GET %s -> code=%d err=%d body[:200]=%s",
                  tag, path, code, err, SafeBodyPreview(resp));
   if(code == 200) return true;
   if(code == -1 && VerboseDiagnostics)
      PrintFormat("[ARX-DEMO][%s] WebRequest reason: %s", tag, ExplainWebRequestError(err));
   return false;
}

//+------------------------------------------------------------------+
//| Heartbeat / account / positions (parity with v1.21)              |
//+------------------------------------------------------------------+
void SendHeartbeatNow()
{
   if(!SendHeartbeat) return;
   g_heartbeatAttempts++;
   if(StringLen(BridgeToken) == 0) { g_heartbeatFailure++; return; }
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string server = AccountInfoString(ACCOUNT_SERVER);
   bool live = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL);
   string body = "{";
   body += "\"account\":"     + JString(EffectiveAccountId()) + ",";
   body += "\"broker\":"      + JString(broker)               + ",";
   body += "\"server\":"      + JString(server)               + ",";
   body += "\"balance\":"     + JNumber(bal, 2)               + ",";
   body += "\"equity\":"      + JNumber(eq, 2)                + ",";
   body += "\"liveAllowed\":" + JBool(live)                   + ",";
   body += "\"timestamp\":"   + JString(IsoNow());
   body += "}";
   string resp;
   if(HttpPost("/api/mt5/heartbeat", body, resp, "HB")) { g_heartbeatSuccess++; g_lastHeartbeatAt = TimeCurrent(); }
   else g_heartbeatFailure++;
}

void SendAccountSnapshotNow()
{
   if(!SendAccountSnapshot) return;
   double bal=AccountInfoDouble(ACCOUNT_BALANCE), eq=AccountInfoDouble(ACCOUNT_EQUITY);
   double mar=AccountInfoDouble(ACCOUNT_MARGIN), fmar=AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double mlev=AccountInfoDouble(ACCOUNT_MARGIN_LEVEL); string ccy=AccountInfoString(ACCOUNT_CURRENCY);
   string body = "{";
   body += "\"account\":"     + JString(EffectiveAccountId()) + ",";
   body += "\"balance\":"     + JNumber(bal,  2)              + ",";
   body += "\"equity\":"      + JNumber(eq,   2)              + ",";
   body += "\"margin\":"      + JNumber(mar,  2)              + ",";
   body += "\"freeMargin\":"  + JNumber(fmar, 2)              + ",";
   body += "\"marginLevel\":" + JNumber(mlev, 2)              + ",";
   body += "\"currency\":"    + JString(ccy)                  + ",";
   body += "\"timestamp\":"   + JString(IsoNow());
   body += "}";
   string resp;
   if(HttpPost("/api/mt5/sync-account", body, resp, "ACCT")) g_lastAccountSyncAt = TimeCurrent();
}

void SendPositionsSnapshotNow()
{
   if(!SendPositionsSnapshot) return;
   string items = ""; int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      string sym  = PositionGetString(POSITION_SYMBOL);
      long   ptyp = PositionGetInteger(POSITION_TYPE);
      double lot  = PositionGetDouble(POSITION_VOLUME);
      double ent  = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl   = PositionGetDouble(POSITION_SL);
      double tp   = PositionGetDouble(POSITION_TP);
      double prof = PositionGetDouble(POSITION_PROFIT);
      string row = "{";
      row += "\"ticket\":" + JULong(ticket)                + ",";
      row += "\"symbol\":" + JString(sym)                  + ",";
      row += "\"side\":"   + JString(SideFromPosType(ptyp)) + ",";
      row += "\"lot\":"    + JNumber(lot,  2)              + ",";
      row += "\"entry\":"  + JNumber(ent,  5)              + ",";
      row += "\"sl\":"     + JNumber(sl,   5)              + ",";
      row += "\"tp\":"     + JNumber(tp,   5)              + ",";
      row += "\"profit\":" + JNumber(prof, 2);
      row += "}";
      if(StringLen(items) > 0) items += ",";
      items += row;
   }
   string body = "{\"positions\":[" + items + "],\"timestamp\":" + JString(IsoNow()) + "}";
   string resp;
   if(HttpPost("/api/mt5/sync-positions", body, resp, "POS")) g_lastPositionSyncAt = TimeCurrent();
}

//+------------------------------------------------------------------+
//| Acknowledge a command                                            |
//+------------------------------------------------------------------+
void AckCommand(long cmdId, string status, string detail)
{
   string body = "{";
   body += "\"commandId\":" + JLong(cmdId)    + ",";
   body += "\"status\":"    + JString(status) + ",";
   body += "\"detail\":"    + JString(detail) + ",";
   body += "\"timestamp\":" + JString(IsoNow());
   body += "}";
   string resp;
   HttpPost("/api/mt5/command-result", body, resp, "ACK");
   PrintFormat("[ARX-DEMO][POLL] Acked cmd=#%I64d status=%s detail=%s", cmdId, status, detail);
}

//+------------------------------------------------------------------+
//| Execute a single DEMO_MARKET_ORDER                               |
//|   Returns (status,detail) — no retries, no second OrderSend.     |
//+------------------------------------------------------------------+
void ExecuteDemoMarketOrder(long cmdId, string slice)
{
   //--- Re-validate the global arming matrix on every command ------
   bool acctIsDemo = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
   bool envIsDemo  = (StringCompare(Environment, "demo", false) == 0);

   if(ReadOnlyMode)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_READ_ONLY_MODE_ACTIVE",
                 "EA refused: ReadOnlyMode=true. Demo execution requires ReadOnlyMode=false.");
      return;
   }
   if(RequireDemoAccount && !acctIsDemo)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_NON_DEMO_ACCOUNT",
                 "EA refused: ACCOUNT_TRADE_MODE != ACCOUNT_TRADE_MODE_DEMO. Live/real accounts are blocked.");
      return;
   }
   if(!envIsDemo)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_ENVIRONMENT_NOT_DEMO",
                 "EA refused: Environment input must equal \"demo\".");
      return;
   }
   if(!DemoExecutionMode || !AllowDemoOrderExecution)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_DEMO_EXECUTION_NOT_ARMED",
                 StringFormat("EA refused: DemoExecutionMode=%s AllowDemoOrderExecution=%s — both must be true.",
                              JBool(DemoExecutionMode), JBool(AllowDemoOrderExecution)));
      return;
   }

   //--- Parse the per-command payload -------------------------------
   string symbol = JsonReadString(slice, "symbol");
   string side   = JsonReadString(slice, "side");
   double lot    = JsonReadDouble(slice, "lot");
   double sl     = JsonReadDouble(slice, "sl");
   double tp     = JsonReadDouble(slice, "tp");
   string detail = JsonReadString(slice, "detail");
   bool   demoOnly = JsonContainsLiteralTrue(detail, "demoOnly");

   if(!demoOnly)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_DEMO_ONLY_FLAG_MISSING",
                 "EA refused: command.detail.demoOnly must be literally true.");
      return;
   }
   if(StringLen(symbol) == 0)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_INVALID_SYMBOL", "EA refused: symbol missing.");
      return;
   }
   if(side != "BUY" && side != "SELL")
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_INVALID_SIDE",
                 StringFormat("EA refused: side must be BUY or SELL (got '%s').", side));
      return;
   }
   if(lot <= 0.0 || lot > MaxDemoLot)
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_LOT_OUT_OF_RANGE",
                 StringFormat("EA refused: lot=%.4f outside (0, %.4f].", lot, MaxDemoLot));
      return;
   }
   if(!SymbolSelect(symbol, true))
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "EA_REFUSED_SYMBOL_NOT_AVAILABLE",
                 StringFormat("EA refused: SymbolSelect failed for '%s'.", symbol));
      return;
   }

   //--- Single OrderSend. NO retries on failure. -------------------
   g_trade.SetExpertMagicNumber(OrderMagicNumber);
   g_trade.SetDeviationInPoints(OrderDeviationPoints);
   g_trade.SetTypeFillingBySymbol(symbol);

   double price = (side == "BUY")
      ? SymbolInfoDouble(symbol, SYMBOL_ASK)
      : SymbolInfoDouble(symbol, SYMBOL_BID);

   bool ok = false;
   if(side == "BUY")  ok = g_trade.Buy(lot,  symbol, price, sl, tp, "ARX-DEMO");
   else               ok = g_trade.Sell(lot, symbol, price, sl, tp, "ARX-DEMO");

   uint   retcode = g_trade.ResultRetcode();
   string retdesc = g_trade.ResultRetcodeDescription();
   ulong  resTicket = g_trade.ResultOrder();

   if(ok && (retcode == TRADE_RETCODE_DONE || retcode == TRADE_RETCODE_PLACED || retcode == TRADE_RETCODE_DONE_PARTIAL))
   {
      g_demoOrdersSent++;
      AckCommand(cmdId, "DEMO_ORDER_PLACED",
                 StringFormat("ticket=%I64u retcode=%u (%s) symbol=%s side=%s lot=%.4f price=%.5f magic=%d",
                              resTicket, retcode, retdesc, symbol, side, lot, price, OrderMagicNumber));
   }
   else
   {
      g_demoOrdersRefused++;
      AckCommand(cmdId, "DEMO_ORDER_FAILED",
                 StringFormat("OrderSend failed retcode=%u (%s) symbol=%s side=%s lot=%.4f",
                              retcode, retdesc, symbol, side, lot));
   }
}

//+------------------------------------------------------------------+
//| Poll commands                                                    |
//+------------------------------------------------------------------+
void PollAndExecuteCommands()
{
   string resp;
   if(!HttpGet("/api/mt5/commands", resp, "POLL")) return;

   int cursor = 0;
   while(true)
   {
      int idPos = StringFind(resp, "\"id\":", cursor);
      if(idPos < 0) break;
      int nextIdPos = StringFind(resp, "\"id\":", idPos + 5);
      string slice = (nextIdPos < 0) ? StringSubstr(resp, idPos)
                                     : StringSubstr(resp, idPos, nextIdPos - idPos);
      long cmdId    = JsonReadInt(slice, "id");
      string action = JsonReadString(slice, "action");
      cursor        = (nextIdPos < 0) ? StringLen(resp) : nextIdPos;
      if(cmdId <= 0) continue;

      if(action == "DEMO_MARKET_ORDER")
      {
         ExecuteDemoMarketOrder(cmdId, slice);
      }
      else
      {
         // Anything else (OPEN/CLOSE/MODIFY/CLOSE_ALL/etc.) is refused outright.
         g_demoOrdersRefused++;
         AckCommand(cmdId, "EA_REFUSED_NON_DEMO_ACTION",
                    StringFormat("EA v1.30 only executes DEMO_MARKET_ORDER. Refused action='%s'.", action));
      }
   }
   g_lastPollAt = TimeCurrent();
}

//+------------------------------------------------------------------+
//| Lifecycle                                                        |
//+------------------------------------------------------------------+
void PrintInitDiagnostics()
{
   bool acctIsDemo = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
   Print("[ARX-DEMO] ──────────────────────────────────────────────────────────────");
   Print("[ARX-DEMO] EA initialized: ReplitMT5BridgeEA_DemoExec v1.30 (DEMO-ONLY EXECUTION)");
   PrintFormat("[ARX-DEMO] ServerBaseUrl          : %s", NormalizedBaseUrl());
   PrintFormat("[ARX-DEMO] BridgeToken present    : %s (length=%d; value NEVER printed)",
               (StringLen(BridgeToken) > 0 ? "yes" : "NO"), StringLen(BridgeToken));
   PrintFormat("[ARX-DEMO] Environment            : %s", Environment);
   PrintFormat("[ARX-DEMO] AccountId (effective)  : %s", EffectiveAccountId());
   PrintFormat("[ARX-DEMO] ACCOUNT_TRADE_MODE     : %s", (acctIsDemo ? "DEMO ✅" : "NOT DEMO ❌ (execution will be refused)"));
   PrintFormat("[ARX-DEMO] ReadOnlyMode           : %s", JBool(ReadOnlyMode));
   PrintFormat("[ARX-DEMO] DemoExecutionMode      : %s (ARM #1)", JBool(DemoExecutionMode));
   PrintFormat("[ARX-DEMO] AllowDemoOrderExecution: %s (ARM #2)", JBool(AllowDemoOrderExecution));
   PrintFormat("[ARX-DEMO] RequireDemoAccount     : %s", JBool(RequireDemoAccount));
   PrintFormat("[ARX-DEMO] MaxDemoLot             : %.4f", MaxDemoLot);
   PrintFormat("[ARX-DEMO] PollIntervalSeconds    : %d", PollIntervalSeconds);

   bool armed = (!ReadOnlyMode && DemoExecutionMode && AllowDemoOrderExecution &&
                 (StringCompare(Environment,"demo",false)==0) &&
                 (acctIsDemo || !RequireDemoAccount));
   if(armed) Print("[ARX-DEMO] ARMED for demo execution. Max 0.01 lot. No live trades possible.");
   else      Print("[ARX-DEMO] NOT armed. EA will refuse every DEMO_MARKET_ORDER until all flags are set on a DEMO account.");
   Print("[ARX-DEMO] ──────────────────────────────────────────────────────────────");
}

int OnInit()
{
   PrintInitDiagnostics();
   if(StringLen(BridgeToken) < 8)
   {
      Alert("[ARX-DEMO] BridgeToken empty or too short. EA will not run.");
      return INIT_PARAMETERS_INCORRECT;
   }
   string urlIssue = ValidateServerBaseUrl();
   if(StringLen(urlIssue) > 0)
   {
      Alert(StringFormat("[ARX-DEMO] ServerBaseUrl invalid: %s EA will not run.", urlIssue));
      return INIT_PARAMETERS_INCORRECT;
   }
   if(MaxDemoLot > 0.01)
   {
      Alert("[ARX-DEMO] MaxDemoLot > 0.01 not allowed in this build. EA will not run.");
      return INIT_PARAMETERS_INCORRECT;
   }

   EventSetTimer(MathMax(1, PollIntervalSeconds));
   SendHeartbeatNow();
   SendAccountSnapshotNow();
   SendPositionsSnapshotNow();
   PollAndExecuteCommands();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   PrintFormat("[ARX-DEMO] Deinitialized. reason=%d hb=ok%I64d/fail%I64d demo_orders sent=%I64d refused=%I64d",
               reason, g_heartbeatSuccess, g_heartbeatFailure, g_demoOrdersSent, g_demoOrdersRefused);
}

void OnTimer()
{
   datetime now = TimeCurrent();
   if(now - g_lastHeartbeatAt    >= g_heartbeatPeriodS) SendHeartbeatNow();
   if(now - g_lastAccountSyncAt  >= g_snapshotPeriodS)  SendAccountSnapshotNow();
   if(now - g_lastPositionSyncAt >= g_snapshotPeriodS)  SendPositionsSnapshotNow();
   if(now - g_lastPollAt         >= MathMax(1, PollIntervalSeconds)) PollAndExecuteCommands();
}

void OnTick() { /* timer-driven only */ }
//+------------------------------------------------------------------+
