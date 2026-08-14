//+------------------------------------------------------------------+
//| ARXWebRequestTest.mq5                                            |
//| One-shot script: POST a single test heartbeat to ARX AI and      |
//| print the result to the Experts tab.                             |
//|                                                                  |
//| SAFETY:                                                          |
//|  - This script does NOT place, modify, or close any orders.      |
//|  - It only POSTs once to /api/mt5/heartbeat with a tiny JSON.    |
//|  - The token is read from inputs and is NEVER printed.           |
//|                                                                  |
//| USAGE:                                                           |
//|  1. Compile in MetaEditor → drag from Navigator → Scripts.       |
//|  2. Set ServerBaseUrl + BridgeToken inputs.                      |
//|  3. Drop on any chart. It runs once and prints the result.       |
//+------------------------------------------------------------------+
#property copyright "Replit ARX AI Trading Bridge"
#property version   "1.10"
#property strict
#property description "One-shot WebRequest test for the ARX AI MT5 bridge. POSTs once to /api/mt5/heartbeat and prints HTTP status + GetLastError + response body. Never prints the token value."
#property script_show_inputs

input string ServerBaseUrl   = "https://your-replit-app.replit.app"; // e.g. https://<repl>.replit.app  (no trailing slash)
input string BridgeToken     = "";       // Same value as MT5_BRIDGE_TOKEN Replit Secret. NEVER printed.
input int    RequestTimeoutMs = 5000;

#define HDR_TOKEN_NAME "X-MT5-Bridge-Token"
#define PLACEHOLDER_URL "https://your-replit-app.replit.app"

string NormalizedBaseUrl()
{
   string u = ServerBaseUrl;
   while(StringLen(u) > 0 && StringGetCharacter(u, StringLen(u) - 1) == '/')
      u = StringSubstr(u, 0, StringLen(u) - 1);
   return u;
}

string ExplainWebRequestError(int err)
{
   if(err == 4014) return "ERR_FUNCTION_NOT_ALLOWED — WebRequest disabled for this URL.";
   if(err == 4060) return "ERR_FUNCTION_NOT_CONFIRMED — WebRequest not confirmed in MT5 Options.";
   if(err == 5200) return "ERR_WEBREQUEST_INVALID_ADDRESS — invalid URL.";
   if(err == 5201) return "ERR_WEBREQUEST_CONNECT_FAILED — could not connect.";
   if(err == 5202) return "ERR_WEBREQUEST_TIMEOUT — server did not respond in time.";
   if(err == 5203) return "ERR_WEBREQUEST_REQUEST_FAILED — request failed (TLS / proxy / DNS).";
   if(err == 0)    return "no MQL error reported";
   return StringFormat("unknown MQL error code %d", err);
}

string ExplainHeartbeatHttp(int code)
{
   if(code >= 200 && code < 300) return "ACCEPTED — server recorded the heartbeat.";
   if(code == 401)               return "REJECTED — token mismatch or missing X-MT5-Bridge-Token header.";
   if(code == 503)               return "REJECTED — server says MT5_BRIDGE_TOKEN not configured in Replit Secrets.";
   if(code == 400)               return "REJECTED — invalid heartbeat body.";
   if(code == 404)               return "REJECTED — endpoint not found at this URL.";
   if(code >= 500)               return "REJECTED — server error.";
   return StringFormat("UNEXPECTED HTTP %d.", code);
}

string IsoNow()
{
   datetime t = TimeGMT();
   MqlDateTime mdt;
   TimeToStruct(t, mdt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
      mdt.year, mdt.mon, mdt.day, mdt.hour, mdt.min, mdt.sec);
}

// ---- Safe JSON helpers (mirror ReplitMT5BridgeEA.mq5) -------------
string JsonEscape(const string s)
{
   string out = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
   {
      ushort ch = StringGetCharacter(s, i);
      if(ch == '"')       out += "\\\"";
      else if(ch == '\\') out += "\\\\";
      else if(ch == '\n') out += "\\n";
      else if(ch == '\r') out += "\\r";
      else if(ch == '\t') out += "\\t";
      else if(ch < 0x20)  out += StringFormat("\\u%04x", ch);
      else                out += ShortToString(ch);
   }
   return out;
}
string JString(const string v) { return "\"" + JsonEscape(v) + "\""; }
string JBool(const bool v)     { return v ? "true" : "false"; }
string JNumber(const double v, const int digits = 2)
{
   if(!MathIsValidNumber(v)) return "0.0";
   return DoubleToString(v, digits);
}
string JLong(const long v) { return IntegerToString(v); }

void OnStart()
{
   Print("[ARX-TEST] ──────────────────────────────────────────────────────");
   Print("[ARX-TEST] One-shot WebRequest test starting.");
   PrintFormat("[ARX-TEST] ServerBaseUrl present: %s", (StringLen(ServerBaseUrl) > 0 ? "yes" : "NO"));
   PrintFormat("[ARX-TEST] ServerBaseUrl value  : %s", ServerBaseUrl);
   PrintFormat("[ARX-TEST] Normalized base URL  : %s", NormalizedBaseUrl());
   PrintFormat("[ARX-TEST] BridgeToken present  : %s (length=%d; value NEVER printed)",
               (StringLen(BridgeToken) > 0 ? "yes" : "NO"), StringLen(BridgeToken));

   // Pre-flight ----------------------------------------------------
   if(StringLen(ServerBaseUrl) == 0)
   { Print("[ARX-TEST] ABORT — ServerBaseUrl is BLANK."); return; }
   if(ServerBaseUrl == PLACEHOLDER_URL || StringFind(ServerBaseUrl, "your-replit-app") >= 0)
   { Print("[ARX-TEST] ABORT — ServerBaseUrl still contains placeholder text. Replace with your real Replit URL."); return; }
   if(StringFind(ServerBaseUrl, "http") != 0)
   { Print("[ARX-TEST] ABORT — ServerBaseUrl must start with http:// or https://."); return; }
   if(StringLen(BridgeToken) < 8)
   { Print("[ARX-TEST] ABORT — BridgeToken is blank or too short. Set it in script inputs."); return; }

   string url = NormalizedBaseUrl() + "/api/mt5/heartbeat";
   string headers = StringFormat("%s: %s\r\nContent-Type: application/json\r\n",
                                 HDR_TOKEN_NAME, BridgeToken);

   long acct = AccountInfoInteger(ACCOUNT_LOGIN);
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);

   // Build through helpers — NaN/Inf become 0.0; strings are escaped.
   string body = "{";
   body += "\"account\":"     + JString(IntegerToString(acct)) + ",";
   body += "\"broker\":"      + JString("webreq-test")         + ",";
   body += "\"server\":"      + JString("webreq-test")         + ",";
   body += "\"balance\":"     + JNumber(bal, 2)                + ",";
   body += "\"equity\":"      + JNumber(eq,  2)                + ",";
   body += "\"liveAllowed\":" + JBool(false)                   + ",";
   body += "\"timestamp\":"   + JString(IsoNow());
   body += "}";
   PrintFormat("[ARX-TEST] payload (len=%d): %s", StringLen(body), body);

   char post[];
   StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   ArrayResize(post, ArraySize(post) - 1);

   char result[];
   string resHeaders;
   PrintFormat("[ARX-TEST] POST %s  (token withheld)", url);

   ResetLastError();
   int code = WebRequest("POST", url, headers, RequestTimeoutMs, post, result, resHeaders);
   string respBody = (ArraySize(result) > 0) ? CharArrayToString(result, 0, ArraySize(result), CP_UTF8) : "";

   if(code == -1)
   {
      int err = GetLastError();
      PrintFormat("[ARX-TEST] RESULT: WebRequest FAILED. http=-1 GetLastError=%d (%s)",
                  err, ExplainWebRequestError(err));
      Print("[ARX-TEST] FIX: MT5 → Tools → Options → Expert Advisors → tick 'Allow WebRequest for listed URL' and add: " + NormalizedBaseUrl());
      Print("[ARX-TEST] ──────────────────────────────────────────────────────");
      return;
   }

   string preview = (StringLen(respBody) > 400) ? StringSubstr(respBody, 0, 400) + "..." : respBody;
   PrintFormat("[ARX-TEST] RESULT: HTTP %d. %s", code, ExplainHeartbeatHttp(code));
   PrintFormat("[ARX-TEST] response body[:400]: %s", preview);

   if(code >= 200 && code < 300)
      Print("[ARX-TEST] SUCCESS. Server now has a fresh heartbeat. Check ARX AI /mt5-setup page; it should flip to 'EA HEARTBEAT FRESH' within 5s.");
   else
      Print("[ARX-TEST] FAIL. Use the reason above to fix EA inputs (token / URL / WebRequest allowlist).");

   Print("[ARX-TEST] ──────────────────────────────────────────────────────");
}
//+------------------------------------------------------------------+
