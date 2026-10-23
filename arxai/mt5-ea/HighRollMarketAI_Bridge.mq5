//+------------------------------------------------------------------+
//|                              HighRollMarketAI_Bridge.mq5         |
//|                   High Roll Trading AI - MT5 Bridge EA           |
//|                                                                  |
//|  Purpose:                                                        |
//|    Connects MetaTrader 5 to the Replit-hosted High Roll          |
//|    Trading AI backend. The AI brain stays on the server.         |
//|    This EA only executes commands and reports state back.        |
//|                                                                  |
//|  Setup (REQUIRED):                                               |
//|    1. Open MetaTrader 5                                          |
//|    2. Tools > Options > Expert Advisors                          |
//|    3. Tick "Allow WebRequest for listed URL"                     |
//|    4. Add the Replit base URL exactly as configured below        |
//|       e.g.  https://your-app.replit.app                          |
//|    5. Compile this EA in MetaEditor (F7)                         |
//|    6. Drag onto any chart, set inputs, allow algo trading        |
//|                                                                  |
//|  Endpoints used (relative to ApiBaseUrl):                        |
//|    POST /api/mt5/heartbeat                                       |
//|    GET  /api/mt5/commands                                        |
//|    POST /api/mt5/command-result                                  |
//|    POST /api/mt5/sync-account                                    |
//|    POST /api/mt5/sync-positions                                  |
//+------------------------------------------------------------------+
#property copyright "High Roll Trading AI"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input string ApiBaseUrl        = "https://YOUR-REPLIT-URL.replit.app";
input string ApiKey            = "PASTE_API_KEY_HERE";
input int    MagicNumber       = 777001;
input bool   AllowLiveTrading  = false;
input int    HeartbeatSeconds  = 5;
input int    WebRequestTimeout = 5000;

//--- globals
CTrade   trade;
datetime lastHeartbeat = 0;
datetime lastSync      = 0;

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
void LogAction(string msg)
{
   PrintFormat("[HighRollAI] %s", msg);
}

string JsonEscape(string s)
{
   string out = "";
   int len = StringLen(s);
   for(int i = 0; i < len; i++)
   {
      ushort ch = StringGetCharacter(s, i);
      if(ch == '"')      out += "\\\"";
      else if(ch == '\\') out += "\\\\";
      else if(ch == '\n') out += "\\n";
      else if(ch == '\r') out += "\\r";
      else if(ch == '\t') out += "\\t";
      else                out += ShortToString(ch);
   }
   return out;
}

// Very small JSON value extractor (string or number) by key.
// Looks for "key": value pattern. Sufficient for the simple
// command payloads we produce on the server.
string JsonGetString(string json, string key)
{
   string needle = "\"" + key + "\"";
   int pos = StringFind(json, needle);
   if(pos < 0) return "";
   pos = StringFind(json, ":", pos);
   if(pos < 0) return "";
   pos++;
   while(pos < StringLen(json) && (StringGetCharacter(json, pos) == ' ' || StringGetCharacter(json, pos) == '\t'))
      pos++;
   if(pos >= StringLen(json)) return "";
   ushort first = StringGetCharacter(json, pos);
   if(first == '"')
   {
      pos++;
      int end = StringFind(json, "\"", pos);
      if(end < 0) return "";
      return StringSubstr(json, pos, end - pos);
   }
   // numeric / bool / null
   int end = pos;
   while(end < StringLen(json))
   {
      ushort c = StringGetCharacter(json, end);
      if(c == ',' || c == '}' || c == ']' || c == ' ' || c == '\n' || c == '\r' || c == '\t') break;
      end++;
   }
   return StringSubstr(json, pos, end - pos);
}

double JsonGetNumber(string json, string key)
{
   string s = JsonGetString(json, key);
   if(s == "" || s == "null") return 0.0;
   return StringToDouble(s);
}

long JsonGetInt(string json, string key)
{
   string s = JsonGetString(json, key);
   if(s == "" || s == "null") return 0;
   return (long)StringToInteger(s);
}

//+------------------------------------------------------------------+
//| HTTP wrappers                                                    |
//+------------------------------------------------------------------+
bool PostJson(string path, string body, string &response)
{
   string url = ApiBaseUrl + path;
   string headers = "Content-Type: application/json\r\nX-Api-Key: " + ApiKey + "\r\n";
   char post[];
   StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   ArrayResize(post, ArraySize(post) - 1); // strip null terminator

   char result[];
   string resHeaders;
   ResetLastError();
   int code = WebRequest("POST", url, headers, WebRequestTimeout, post, result, resHeaders);
   if(code == -1)
   {
      LogAction(StringFormat("POST %s failed (err=%d). Did you whitelist %s in Tools>Options>EA?", path, GetLastError(), ApiBaseUrl));
      response = "";
      return false;
   }
   response = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   return (code >= 200 && code < 300);
}

bool GetJson(string path, string &response)
{
   string url = ApiBaseUrl + path;
   string headers = "Content-Type: application/json\r\nX-Api-Key: " + ApiKey + "\r\n";
   char empty[]; ArrayResize(empty, 0);
   char result[];
   string resHeaders;
   ResetLastError();
   int code = WebRequest("GET", url, headers, WebRequestTimeout, empty, result, resHeaders);
   if(code == -1)
   {
      LogAction(StringFormat("GET %s failed (err=%d). Did you whitelist %s in Tools>Options>EA?", path, GetLastError(), ApiBaseUrl));
      response = "";
      return false;
   }
   response = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   return (code >= 200 && code < 300);
}

//+------------------------------------------------------------------+
//| Lifecycle                                                        |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetTypeFilling(ORDER_FILLING_FOK);
   EventSetTimer(MathMax(1, HeartbeatSeconds));
   LogAction(StringFormat("EA initialised. Magic=%d  Live=%s  Url=%s", MagicNumber, (AllowLiveTrading ? "true" : "false"), ApiBaseUrl));
   if(!AllowLiveTrading)
      LogAction("AllowLiveTrading is FALSE — EA will NOT place real trades. OPEN commands return blocked_demo_mode.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   LogAction(StringFormat("EA stopped (reason=%d).", reason));
}

void OnTimer()
{
   SendHeartbeat();
   FetchCommands();
   if(TimeCurrent() - lastSync >= 10)
   {
      SyncAccount();
      SyncPositions();
      lastSync = TimeCurrent();
   }
}

//+------------------------------------------------------------------+
//| Heartbeat                                                        |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   string body = StringFormat(
      "{\"account\":%I64d,\"broker\":\"%s\",\"server\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"liveAllowed\":%s,\"timestamp\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      JsonEscape(AccountInfoString(ACCOUNT_COMPANY)),
      JsonEscape(AccountInfoString(ACCOUNT_SERVER)),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      (AllowLiveTrading ? "true" : "false"),
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS)
   );
   string resp;
   PostJson("/api/mt5/heartbeat", body, resp);
   lastHeartbeat = TimeCurrent();
}

//+------------------------------------------------------------------+
//| Pull and execute pending commands                                |
//+------------------------------------------------------------------+
void FetchCommands()
{
   string resp;
   if(!GetJson("/api/mt5/commands", resp)) return;
   if(StringLen(resp) < 5) return;

   // Server returns: { "commands": [ { ... }, { ... } ] }
   // We naively split on objects between brackets.
   int start = 0;
   while(true)
   {
      int objStart = StringFind(resp, "{\"id\"", start);
      if(objStart < 0) break;
      int depth = 0;
      int end = objStart;
      for(; end < StringLen(resp); end++)
      {
         ushort c = StringGetCharacter(resp, end);
         if(c == '{') depth++;
         else if(c == '}') { depth--; if(depth == 0) { end++; break; } }
      }
      string cmd = StringSubstr(resp, objStart, end - objStart);
      ExecuteCommand(cmd);
      start = end;
   }
}

//+------------------------------------------------------------------+
//| Command dispatcher                                               |
//+------------------------------------------------------------------+
void ExecuteCommand(string cmd)
{
   long   id      = JsonGetInt(cmd, "id");
   string action  = JsonGetString(cmd, "action");
   string symbol  = JsonGetString(cmd, "symbol");
   string side    = JsonGetString(cmd, "side");
   double lot     = JsonGetNumber(cmd, "lot");
   double sl      = JsonGetNumber(cmd, "sl");
   double tp      = JsonGetNumber(cmd, "tp");
   long   ticket  = JsonGetInt(cmd, "ticket");

   LogAction(StringFormat("Command #%I64d action=%s symbol=%s side=%s lot=%.2f", id, action, symbol, side, lot));

   string status = "ok";
   string detail = "";

   if(action == "OPEN")
   {
      if(!AllowLiveTrading) { status = "blocked_demo_mode"; detail = "AllowLiveTrading=false"; }
      else if(symbol == "")  { status = "rejected"; detail = "missing symbol"; }
      else if(lot <= 0)      { status = "rejected"; detail = "lot must be > 0"; }
      else if(sl <= 0)       { status = "rejected"; detail = "missing stop loss"; }
      else if(tp <= 0)       { status = "rejected"; detail = "missing take profit"; }
      else
      {
         bool ok = OpenTrade(symbol, side, lot, sl, tp);
         status = ok ? "executed" : "failed";
         if(!ok) detail = trade.ResultRetcodeDescription();
      }
   }
   else if(action == "CLOSE")
   {
      if(!AllowLiveTrading) { status = "blocked_demo_mode"; }
      else if(ticket <= 0)  { status = "rejected"; detail = "missing ticket"; }
      else                  { status = CloseTrade((ulong)ticket) ? "executed" : "failed"; }
   }
   else if(action == "MODIFY")
   {
      if(!AllowLiveTrading) { status = "blocked_demo_mode"; }
      else if(ticket <= 0)  { status = "rejected"; detail = "missing ticket"; }
      else                  { status = ModifyTrade((ulong)ticket, sl, tp) ? "executed" : "failed"; }
   }
   else if(action == "CLOSE_ALL")
   {
      if(!AllowLiveTrading) { status = "blocked_demo_mode"; }
      else                  { int n = CloseAllTrades(); status = "executed"; detail = StringFormat("closed=%d", n); }
   }
   else
   {
      status = "rejected";
      detail = "unknown action";
   }

   LogAction(StringFormat("Result #%I64d status=%s detail=%s", id, status, detail));

   string body = StringFormat(
      "{\"commandId\":%I64d,\"status\":\"%s\",\"detail\":\"%s\",\"timestamp\":\"%s\"}",
      id, JsonEscape(status), JsonEscape(detail),
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS)
   );
   string resp;
   PostJson("/api/mt5/command-result", body, resp);
}

//+------------------------------------------------------------------+
//| Trade actions                                                    |
//+------------------------------------------------------------------+
bool OpenTrade(string symbol, string side, double lot, double sl, double tp)
{
   if(!SymbolSelect(symbol, true)) { LogAction("Cannot select " + symbol); return false; }
   double price = (side == "BUY")
      ? SymbolInfoDouble(symbol, SYMBOL_ASK)
      : SymbolInfoDouble(symbol, SYMBOL_BID);
   bool ok = (side == "BUY")
      ? trade.Buy(lot, symbol, price, sl, tp, "HighRollAI")
      : trade.Sell(lot, symbol, price, sl, tp, "HighRollAI");
   return ok;
}

bool CloseTrade(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return false;
   if((long)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
   {
      LogAction(StringFormat("Refuse close: ticket %I64u not owned by magic %d", ticket, MagicNumber));
      return false;
   }
   return trade.PositionClose(ticket);
}

bool ModifyTrade(ulong ticket, double sl, double tp)
{
   if(!PositionSelectByTicket(ticket)) return false;
   if((long)PositionGetInteger(POSITION_MAGIC) != MagicNumber) return false;
   return trade.PositionModify(ticket, sl, tp);
}

int CloseAllTrades()
{
   int closed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      if(trade.PositionClose(ticket)) closed++;
   }
   LogAction(StringFormat("CLOSE_ALL closed %d positions (magic=%d only)", closed, MagicNumber));
   return closed;
}

//+------------------------------------------------------------------+
//| Sync                                                             |
//+------------------------------------------------------------------+
void SyncAccount()
{
   string body = StringFormat(
      "{\"account\":%I64d,\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"freeMargin\":%.2f,\"marginLevel\":%.2f,\"currency\":\"%s\",\"timestamp\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),
      JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS)
   );
   string resp;
   PostJson("/api/mt5/sync-account", body, resp);
}

void SyncPositions()
{
   string positions = "[";
   bool first = true;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      string side = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "BUY" : "SELL";
      double lot = PositionGetDouble(POSITION_VOLUME);
      double entry = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double profit = PositionGetDouble(POSITION_PROFIT);
      if(!first) positions += ",";
      positions += StringFormat(
         "{\"ticket\":%I64u,\"symbol\":\"%s\",\"side\":\"%s\",\"lot\":%.2f,\"entry\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f}",
         ticket, JsonEscape(sym), side, lot, entry, sl, tp, profit);
      first = false;
   }
   positions += "]";
   string body = StringFormat("{\"positions\":%s,\"timestamp\":\"%s\"}", positions, TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
   string resp;
   PostJson("/api/mt5/sync-positions", body, resp);
}
//+------------------------------------------------------------------+
