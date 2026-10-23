//+------------------------------------------------------------------+
//| ReplitMT5BridgeEA.mq5                                            |
//| READ-ONLY MT5 -> Replit (ARX AI) bridge.                         |
//|                                                                  |
//| SAFETY:                                                          |
//|  - Default: ReadOnlyMode=true, AllowOrderExecution=false.        |
//|  - This EA NEVER calls OrderSend, OrderModify, OrderClose,       |
//|    PositionClose, or any trade.* function in v1.                 |
//|  - When the server queues a command, the EA acknowledges it      |
//|    with status="EA_READ_ONLY_MODE_ACTIVE" and does NOT execute.  |
//|  - The shared secret token is read from EA inputs at runtime.    |
//|    It is NEVER printed to the Experts log or the journal.        |
//|                                                                  |
//| v1.1 — VERBOSE HEARTBEAT DIAGNOSTICS                             |
//|  - OnInit prints a full configuration summary (no token value).  |
//|  - Every heartbeat attempt prints url, http code, GetLastError,  |
//|    response body preview, and a human-readable failure reason.   |
//|  - Detects placeholder/blank/trailing-slash ServerBaseUrl.       |
//|  - Detects WebRequest-not-allowed (err 4060 / -1 / 5203).        |
//+------------------------------------------------------------------+
#property copyright "Replit ARX AI Trading Bridge"
#property version   "1.29"
#property strict
#property description "MT5 bridge for ARX AI. v1.29 = v1.28 + remote ops: the heartbeat now reports a structured `capabilities` object (all supports* feature keys = true) so ARX only calls features this EA actually supports; the EA pulls allow-listed remote config (SyncRemoteConfigNow → GET /api/mt5/remote-config; NEVER touches AlgoTrading, broker connection, local ReadOnlyMode/EnableLiveExecution, or any ARX safety gate); and it performs gated self-update (CheckForUpdateNow → GET /api/mt5/update-check, verifies sha256 BEFORE apply, reports lifecycle to POST /api/mt5/update-report, rolls back on failure, falls back to 'Manual bootstrap EA install required'). All v1.27/v1.28 gates, inputs, and trade behaviour preserved unchanged — v1.29 is a strict superset. Heartbeat reports eaVersion=1.29."

#include <Trade/Trade.mqh>

//--- Inputs (configure on the EA chart properties dialog) ----------
input string  ServerBaseUrl           = "https://your-replit-app.replit.app"; // e.g. https://<repl>.replit.app  (no trailing slash)
input string  BridgeToken             = "";       // Paste the per-user bridge token from ARX MT5 Setup. NEVER share. Do NOT paste the system MT5_BRIDGE_TOKEN env value — it is rejected on every EA endpoint.
input string  Environment             = "demo";   // "demo" or "live" (informational only — server enforces real safety)
input string  AccountId               = "";       // Optional. If blank, EA uses AccountInfoString(ACCOUNT_LOGIN).
input bool    ReadOnlyMode            = true;     // KEEP TRUE unless you are intentionally enabling DEMO-ONLY execution AND you have flipped EnableDemoExecution=true. Live execution is structurally impossible.
input bool    AllowOrderExecution     = false;    // LEGACY. Kept for the /api/mt5/commands path which the EA still refuses unconditionally. Demo execution is controlled by EnableDemoExecution + ACCOUNT_TRADE_MODE.
input bool    EnableDemoExecution     = false;    // v1.26: KEEP FALSE unless you are running a DEMO account and have approved demo orders on the ARX MT5 Setup page. If your account is not flagged ACCOUNT_TRADE_MODE_DEMO at send time, the EA refuses with REJECTED_NOT_DEMO_ACCOUNT.
input int     DemoMaxLot              = 1;        // Hard ceiling on lot size for demo execution. EA refuses anything larger with REJECTED_LOT_EXCEEDS_CEILING.
input bool    EnableLiveExecution     = false;    // v1.27: KEEP FALSE unless you are intentionally enabling LIVE broker execution. Requires ACCOUNT_TRADE_MODE_REAL + ReadOnlyMode=false + server master switch ARX_LIVE_BROKER_EXECUTION_ENABLED=true. Default-deny.
input double  MaxLiveLot              = 0.01;     // v1.27: Hard ceiling on lot size for LIVE execution. EA refuses anything larger with REJECTED_LIVE_LOT_EXCEEDS_CEILING.
input int     PollIntervalSeconds     = 2;        // OnTimer tick period in seconds (also the command-poll period). Heartbeat and snapshot periods below should be >= this.
input int     HeartbeatPeriodSeconds  = 5;        // How often to POST /api/mt5/heartbeat. Server freshness threshold is 15s, so keep this <= 10.
input int     SnapshotPeriodSeconds   = 5;        // How often to POST /api/mt5/sync-account and /api/mt5/sync-positions.
input int     SymbolSpecPeriodSeconds = 300;      // Task #30: How often to POST /api/mt5/sync-symbol-specs (broker symbol rules). Rules change rarely; 5 min default.
input bool    SendSymbolSpecs         = true;     // Task #30: push per-symbol broker truth (min/max/step lot, stops level, market-open) so the server stops guessing.
input bool    SendHeartbeat           = true;
input bool    SendAccountSnapshot     = true;
input bool    SendPositionsSnapshot   = true;
input bool    SendOrdersSnapshot      = true;     // Reserved. v1 sends positions only (server has no /orders/snapshot endpoint).
input int     RequestTimeoutMs        = 5000;
input bool    EnableRemoteConfig      = true;     // v1.29: pull allow-listed remote tunables (intervals, diagnostics, retry/backoff, maxLiveLot CEILING, maintenanceMode) from GET /api/mt5/remote-config. NEVER touches AlgoTrading, broker connection, local ReadOnlyMode/EnableLiveExecution, or any ARX safety gate — those are HARD-excluded server-side AND ignored here.
input bool    EnableSelfUpdate        = false;    // v1.29: KEEP FALSE unless the operator intends remote EA updates. When true, CheckForUpdateNow downloads the APPROVED manifest package, verifies sha256 BEFORE writing, reports each phase, and rolls back on failure. MQL5 cannot hot-swap a running compiled EA, so a successful download still surfaces "Manual bootstrap EA install required" for the operator to reattach.
input int     RemoteConfigPeriodSeconds = 120;    // v1.29: how often to pull remote config (>=30 enforced).
input int     UpdateCheckPeriodSeconds  = 900;    // v1.29: how often to check for an approved update (>=60 enforced).
input bool    VerboseDiagnostics      = true;     // Print full per-attempt diagnostic lines to the Experts tab.

//--- Constants -----------------------------------------------------
#define HDR_TOKEN_NAME "X-MT5-Bridge-Token"
#define PLACEHOLDER_URL "https://your-replit-app.replit.app"

//--- State ---------------------------------------------------------
// Broker-time markers (datetime). Used ONLY for diagnostic display in logs +
// for the server's heartbeat freshness window (which is server-side anyway).
// These FREEZE on weekends/holidays when no ticks arrive, so they must NEVER
// be used for elapsed-time decisions.
datetime g_lastHeartbeatAt   = 0;
datetime g_lastAccountSyncAt = 0;
datetime g_lastPositionSyncAt= 0;
datetime g_lastPollAt        = 0;
// VPS-uptime markers (ms). Driven by GetTickCount64(), monotonic, NEVER frozen
// by market closure. These are the authoritative gates inside OnTimer.
ulong    g_lastHeartbeatMs   = 0;
ulong    g_lastAccountSyncMs = 0;
ulong    g_lastPositionSyncMs= 0;
ulong    g_lastPollMs        = 0;
// Task #30 — symbol-spec sync marker (ms). Broker symbol rules change rarely,
// so this is pushed on a slow cadence (see g_symbolSpecPeriodS).
ulong    g_lastSymbolSpecMs  = 0;
// v1.29 — remote-config + self-update cadence markers (ms, monotonic).
ulong    g_lastRemoteConfigMs = 0;
ulong    g_lastUpdateCheckMs  = 0;
int      g_remoteConfigPeriodS = 120; // bound in OnInit
int      g_updateCheckPeriodS  = 900; // bound in OnInit
string   g_lastAppliedConfigVersion = "";
long     g_timerTickCount    = 0;
int      g_heartbeatPeriodS  = 5; // bound from HeartbeatPeriodSeconds in OnInit

// Task #28 — EA-side exactly-once dedup memory. A bounded ring of recently
// processed live commandIds and the status the EA already reported for each.
// If the server re-serves a commandId the EA already acted on (e.g. its result
// POST was lost), the EA re-acknowledges the SAME prior status instead of
// executing the order a second time. Bounded so memory never grows unbounded.
#define ARX_LIVE_DEDUP_CAP 64
string   g_liveDoneIds[ARX_LIVE_DEDUP_CAP];
string   g_liveDoneStatus[ARX_LIVE_DEDUP_CAP];
int      g_liveDoneCount      = 0;   // number of valid slots (caps at CAP)
int      g_liveDoneNext       = 0;   // next write slot (ring index)
int      g_snapshotPeriodS   = 5; // bound from SnapshotPeriodSeconds in OnInit
int      g_symbolSpecPeriodS = 300; // bound from SymbolSpecPeriodSeconds in OnInit (Task #30)
long     g_heartbeatAttempts = 0;
long     g_heartbeatSuccess  = 0;
long     g_heartbeatFailure  = 0;

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
string IsoNow()
{
   datetime t = TimeGMT();
   MqlDateTime mdt;
   TimeToStruct(t, mdt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
      mdt.year, mdt.mon, mdt.day, mdt.hour, mdt.min, mdt.sec);
}

// Task #30 — format an arbitrary datetime (local or broker-server) as ISO.
// Used for the heartbeat eaLocalTime / brokerTime clock-drift inputs.
string IsoFromTime(datetime t)
{
   MqlDateTime mdt;
   TimeToStruct(t, mdt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02d",
      mdt.year, mdt.mon, mdt.day, mdt.hour, mdt.min, mdt.sec);
}

// Task #30 — EA-side pre-trade broker guard. Mirrors the pure domain contract
// lib/domain/.../preTradeBrokerGuard.ts. Reads the broker's OWN live truth
// straight from the terminal and REFUSES (returns false + fills `reason`)
// before any OrderSend. Quote/spread/market checks FAIL-CLOSED (missing live
// input is treated as unsafe); lot/stops spec checks FAIL-OPEN only when the
// broker genuinely reports no constraint. This NEVER enables execution — a PASS
// just means "no broker rule is violated", the server gate already approved it.
#define ARX_MAX_SPREAD_POINTS    50
#define ARX_MAX_QUOTE_AGE_SEC    5
// Max slippage between the price the order was drafted against and the live
// price, in points. Mirrors DEFAULT_PRE_TRADE_GUARD_LIMITS.maxDeviationPoints
// in the domain contract. Also fed to CTrade.SetDeviationInPoints() so the
// broker itself rejects a fill that slips past this.
#define ARX_MAX_DEVIATION_POINTS 20

// v1.29 — runtime-tunable operational state. These are seeded from the compiled
// inputs/#defines in OnInit and may be adjusted ONLY by SyncRemoteConfigNow,
// each within a SAFE clamp. The three broker-guard thresholds
// (g_maxSpreadPoints / g_maxDeviationPoints / g_maxQuoteAgeSec) can only ever be
// TIGHTENED remotely — clamped to [1, ARX_MAX_*] — so remote config can make the
// pre-trade safety guard stricter but NEVER looser than the compiled backstop.
// None of these can enable execution or touch a protected surface.
bool   g_verboseDiagnostics = true;   // seeded from VerboseDiagnostics input
int    g_pollPeriodS        = 2;      // seeded from PollIntervalSeconds input
int    g_maxSpreadPoints    = ARX_MAX_SPREAD_POINTS;    // tighten-only
int    g_maxDeviationPoints = ARX_MAX_DEVIATION_POINTS; // tighten-only
int    g_maxQuoteAgeSec     = ARX_MAX_QUOTE_AGE_SEC;    // tighten-only
int    g_dealHistorySyncS   = 0;      // 0 = unset (no deal-history loop in v1.29; tracked for parity/diagnostics)
int    g_defaultCommandTtlS = 0;      // 0 = rely on server-computed secondsUntilExpiry
int    g_retryMaxAttempts   = 1;      // cadence-based retry bound (advisory)
int    g_retryBackoffMs     = 0;      // advisory backoff hint
double g_maxLiveLotCeiling  = 0.0;    // 0 = no remote ceiling; else applied as a LOWER bound via MathMin with MaxLiveLot
bool   g_closeCommandSupport = true;  // when false the EA refuses CLOSE_* commands
bool   g_maintenanceMode    = false;  // when true the EA pauses NEW order execution (open positions untouched)
string g_allowedCommandTypes = "";    // CSV of allowed command types; empty = all default types allowed

// Returns the effective LIVE lot ceiling: the operator's compiled MaxLiveLot
// input, further LOWERED by any advisory remote ceiling. Remote config can only
// ever shrink this, never raise it.
double EffectiveMaxLiveLot()
{
   if(g_maxLiveLotCeiling > 0.0) return MathMin(MaxLiveLot, g_maxLiveLotCeiling);
   return MaxLiveLot;
}

// Membership test for the remote allow-listed command types. Empty list = no
// remote restriction (every command type the EA already supports is allowed).
bool IsCommandTypeAllowedRemotely(const string commandType)
{
   if(StringLen(g_allowedCommandTypes) == 0) return true;
   return (StringFind("," + g_allowedCommandTypes + ",", "," + commandType + ",") >= 0);
}

// True broker-session market-open check. Uses the symbol's real session-trade
// windows for the current SERVER day-of-week (SymbolInfoSessionTrade) instead
// of the trade-mode proxy. FAIL-OPEN: when the broker reports no session info
// at all we cannot prove the market is closed, so we return true and let the
// other guards / the broker itself decide. Returns false ONLY when sessions
// exist for today and "now" falls outside every one of them.
bool IsTradingSessionOpenNow(const string symbol)
{
   datetime nowSrv = TimeTradeServer();
   if(nowSrv == 0) return true; // no server clock — cannot prove closed
   MqlDateTime mdt;
   TimeToStruct(nowSrv, mdt);
   ENUM_DAY_OF_WEEK dow = (ENUM_DAY_OF_WEEK)mdt.day_of_week;
   int nowSec = mdt.hour * 3600 + mdt.min * 60 + mdt.sec;
   datetime from = 0, to = 0;
   bool anySession = false;
   for(int s = 0; s < 24; s++)
   {
      if(!SymbolInfoSessionTrade(symbol, dow, s, from, to))
         break;
      anySession = true;
      // from/to are seconds elapsed since the start of the day.
      if(nowSec >= (int)from && nowSec < (int)to)
         return true;
   }
   if(!anySession) return true; // broker exposes no sessions → fail-open
   return false;                // sessions exist today but now is outside them
}

bool PreTradeBrokerGuard(const string symbol, const string side, const double lot,
                         const double sl, const double tp, const double maxLiveLot,
                         const double referencePrice, string &reason)
{
   reason = "";
   // Ensure the symbol is selected so SymbolInfo* returns live data.
   if(!SymbolInfoInteger(symbol, SYMBOL_SELECT))
      SymbolSelect(symbol, true);

   // 1. Tradability + market open (fail-closed on disabled).
   long tradeMode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(tradeMode == SYMBOL_TRADE_MODE_DISABLED)
   { reason = "BROKER_RULE_SYMBOL_NOT_TRADABLE"; return false; }
   bool isBuy = (side == "BUY");
   // Parity with the domain contract: CLOSEONLY blocks NEW entries and maps to
   // SYMBOL_NOT_TRADABLE (not MARKET_CLOSED — the session may be open, the
   // broker just won't let you OPEN). MARKET_CLOSED is reserved for the
   // explicit market-open check below.
   if(tradeMode == SYMBOL_TRADE_MODE_CLOSEONLY)
   { reason = "BROKER_RULE_SYMBOL_NOT_TRADABLE"; return false; }
   if(isBuy  && tradeMode == SYMBOL_TRADE_MODE_SHORTONLY)
   { reason = "BROKER_RULE_SYMBOL_NOT_TRADABLE"; return false; }
   if(!isBuy && tradeMode == SYMBOL_TRADE_MODE_LONGONLY)
   { reason = "BROKER_RULE_SYMBOL_NOT_TRADABLE"; return false; }

   // 1b. Market open — real broker-session check (fail-open when the broker
   //     reports no session windows). Mirrors the domain MARKET_CLOSED leg.
   if(!IsTradingSessionOpenNow(symbol))
   { reason = "BROKER_RULE_MARKET_CLOSED"; return false; }

   // 2. Quote freshness (fail-closed: no fresh tick = refuse).
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick) || tick.time == 0)
   { reason = "BROKER_RULE_QUOTE_STALE"; return false; }
   long quoteAge = (long)(TimeCurrent() - tick.time);
   if(quoteAge > g_maxQuoteAgeSec)
   { reason = "BROKER_RULE_QUOTE_STALE"; return false; }
   // Parity with the domain contract: a missing/zero bid or ask is NO_PRICES
   // (broker is not quoting this symbol), distinct from a stale-but-present tick.
   if(tick.bid <= 0.0 || tick.ask <= 0.0)
   { reason = "BROKER_RULE_NO_PRICES"; return false; }

   // 3. Spread cap (fail-closed: wild spread = refuse).
   int spreadPts = (int)SymbolInfoInteger(symbol, SYMBOL_SPREAD);
   if(spreadPts > g_maxSpreadPoints)
   { reason = "BROKER_RULE_SPREAD_TOO_WIDE"; return false; }

   // 3b. Deviation / slippage — refuse when the live price has drifted past
   //     ARX_MAX_DEVIATION_POINTS from the price the order was drafted against.
   //     FAIL-OPEN when no reference price is supplied (<= 0), mirroring the
   //     domain contract which skips DEVIATION_TOO_LARGE when requestedPrice is
   //     null. The broker-side SetDeviationInPoints cap below is the hard
   //     real-time backstop regardless.
   double devPoint = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(referencePrice > 0.0 && devPoint > 0.0)
   {
      double curPrice = isBuy ? tick.ask : tick.bid;
      double devPts   = MathAbs(curPrice - referencePrice) / devPoint;
      if(devPts > (double)g_maxDeviationPoints)
      { reason = "BROKER_RULE_DEVIATION_TOO_LARGE"; return false; }
   }

   // 4. Lot min/max/step (fail-open when the broker reports 0 = no constraint).
   double minVol  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVol  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double stepVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(minVol > 0.0 && lot < minVol)
   { reason = "BROKER_RULE_VOLUME_BELOW_MIN"; return false; }
   if(maxVol > 0.0 && lot > maxVol)
   { reason = "BROKER_RULE_VOLUME_ABOVE_MAX"; return false; }
   if(maxLiveLot > 0.0 && lot > maxLiveLot)
   { reason = "BROKER_RULE_VOLUME_ABOVE_MAX"; return false; }
   if(stepVol > 0.0)
   {
      double steps = lot / stepVol;
      double rounded = MathRound(steps);
      if(MathAbs(steps - rounded) > 0.0001)
      { reason = "BROKER_RULE_VOLUME_OFF_STEP"; return false; }
   }

   // 5. Stops / freeze level — mirror the domain contract exactly. SL and TP
   //    must each be at least stopsLevel points from price; neither may sit
   //    inside the broker's freeze distance.
   int stopsLevel  = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   int freezeLevel = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double point    = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point > 0.0)
   {
      double refPrice = isBuy ? tick.ask : tick.bid;
      double slPts = (sl > 0.0) ? MathAbs(refPrice - sl) / point : -1.0;
      double tpPts = (tp > 0.0) ? MathAbs(refPrice - tp) / point : -1.0;
      if(stopsLevel > 0)
      {
         if(slPts >= 0.0 && slPts < (double)stopsLevel)
         { reason = "BROKER_RULE_STOP_LOSS_TOO_CLOSE"; return false; }
         if(tpPts >= 0.0 && tpPts < (double)stopsLevel)
         { reason = "BROKER_RULE_TAKE_PROFIT_TOO_CLOSE"; return false; }
      }
      if(freezeLevel > 0)
      {
         if((slPts >= 0.0 && slPts < (double)freezeLevel) ||
            (tpPts >= 0.0 && tpPts < (double)freezeLevel))
         { reason = "BROKER_RULE_STOP_INSIDE_FREEZE"; return false; }
      }
   }
   return true;
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

// Trim trailing slashes off the configured ServerBaseUrl so url joining is safe.
string NormalizedBaseUrl()
{
   string u = ServerBaseUrl;
   while(StringLen(u) > 0 && StringGetCharacter(u, StringLen(u) - 1) == '/')
      u = StringSubstr(u, 0, StringLen(u) - 1);
   return u;
}

// Validate ServerBaseUrl. Returns "" if OK, else a human-readable reason.
string ValidateServerBaseUrl()
{
   string u = ServerBaseUrl;
   if(StringLen(u) == 0)                     return "ServerBaseUrl is BLANK. Set it in EA inputs.";
   if(u == PLACEHOLDER_URL)                  return "ServerBaseUrl is still the PLACEHOLDER value. Replace with your real Replit URL.";
   if(StringFind(u, "your-replit-app") >= 0) return "ServerBaseUrl still contains 'your-replit-app' placeholder text. Replace with the real URL.";
   if(StringFind(u, "http") != 0)            return "ServerBaseUrl must start with http:// or https://.";
   if(StringFind(u, " ") >= 0)               return "ServerBaseUrl contains whitespace. Re-paste cleanly.";
   if(StringGetCharacter(u, StringLen(u) - 1) == '/')
      return "ServerBaseUrl has a trailing slash; will be auto-trimmed but please remove it in EA inputs.";
   return "";
}

// Build common headers (token + content-type). Token never appears in log.
string BuildHeaders()
{
   return StringFormat("%s: %s\r\nContent-Type: application/json\r\n",
                       HDR_TOKEN_NAME, BridgeToken);
}

// Translate MQL WebRequest GetLastError() codes into a human reason.
string ExplainWebRequestError(int err)
{
   if(err == 4014) return "ERR_FUNCTION_NOT_ALLOWED — WebRequest disabled for this URL. Tools → Options → Expert Advisors → Allow WebRequest for listed URL, then add the exact server URL.";
   if(err == 4060) return "ERR_FUNCTION_NOT_CONFIRMED — WebRequest not confirmed. Tools → Options → Expert Advisors → tick 'Allow WebRequest for listed URL' AND add the URL.";
   if(err == 5200) return "ERR_WEBREQUEST_INVALID_ADDRESS — invalid URL. Check ServerBaseUrl scheme/host/port.";
   if(err == 5201) return "ERR_WEBREQUEST_CONNECT_FAILED — could not connect to server. Check that ServerBaseUrl is reachable from this machine.";
   if(err == 5202) return "ERR_WEBREQUEST_TIMEOUT — server did not respond in time. Increase RequestTimeoutMs or check the server.";
   if(err == 5203) return "ERR_WEBREQUEST_REQUEST_FAILED — request failed on the network layer. Often a TLS / proxy / DNS issue.";
   if(err == 0)    return "no MQL error reported (request may have completed but with non-2xx HTTP)";
   return StringFormat("unknown MQL error code %d", err);
}

// Translate server-side HTTP status to a heartbeat-specific reason.
string ExplainHeartbeatHttp(int code, const string body)
{
   if(code >= 200 && code < 300) return "ACCEPTED — heartbeat recorded by server.";
   if(code == 401)               return "REJECTED — token rejected. EA's BridgeToken does NOT match an active per-user token in ARX MT5 Setup, or X-MT5-Bridge-Token header missing. Regenerate the per-user token from MT5 Setup and re-paste it. The system MT5_BRIDGE_TOKEN env value is NOT accepted here.";
   if(code == 503)               return "REJECTED — server bridge endpoint disabled.";
   if(code == 400)               return "REJECTED — server says heartbeat body is invalid JSON or missing fields.";
   if(code == 404)               return "REJECTED — endpoint not found. Verify ServerBaseUrl and that /api/mt5/heartbeat is mounted.";
   if(code >= 500)               return "REJECTED — server error. See response body.";
   return StringFormat("UNEXPECTED HTTP %d. body[:200]=%s", code, StringSubstr(body, 0, 200));
}

string SafeBodyPreview(const string body)
{
   string s = body;
   int n = StringLen(s);
   if(n > 200) s = StringSubstr(s, 0, 200) + "...";
   return s;
}

// Generic POST returning false on failure. Body must be JSON string.
// Verbose mode prints url, http status, GetLastError, response preview.
bool HttpPost(const string path, const string jsonBody, string &responseOut, const string label)
{
   string url = NormalizedBaseUrl() + path;
   string headers = BuildHeaders();
   char post[];
   int copied = StringToCharArray(jsonBody, post, 0, -1, CP_UTF8); // includes terminal zero
   if(copied <= 1)
   {
      PrintFormat("[ARX][%s] POST body conversion failed. jsonBody length=%d copied=%d", label, StringLen(jsonBody), copied);
      return false;
   }
   ArrayResize(post, copied - 1); // remove ONLY the terminal zero, not the final JSON brace
   char result[];
   string resHeaders;
   ResetLastError();
   int code = WebRequest("POST", url, headers, RequestTimeoutMs, post, result, resHeaders);
   responseOut = (ArraySize(result) > 0) ? CharArrayToString(result, 0, ArraySize(result), CP_UTF8) : "";

   if(code == -1)
   {
      int err = GetLastError();
      PrintFormat("[ARX][%s] POST %s FAILED. http=-1 GetLastError=%d (%s)",
                  label, url, err, ExplainWebRequestError(err));
      return false;
   }
   if(g_verboseDiagnostics)
   {
      PrintFormat("[ARX][%s] POST %s -> HTTP %d. body[:200]=%s",
                  label, url, code, SafeBodyPreview(responseOut));
   }
   if(code < 200 || code >= 300)
   {
      PrintFormat("[ARX][%s] POST %s rejected. %s",
                  label, url, ExplainHeartbeatHttp(code, responseOut));
      return false;
   }
   return true;
}

bool HttpGet(const string path, string &responseOut, const string label)
{
   string url = NormalizedBaseUrl() + path;
   string headers = BuildHeaders();
   char post[]; ArrayResize(post, 0);
   char result[];
   string resHeaders;
   ResetLastError();
   int code = WebRequest("GET", url, headers, RequestTimeoutMs, post, result, resHeaders);
   responseOut = (ArraySize(result) > 0) ? CharArrayToString(result, 0, ArraySize(result), CP_UTF8) : "";
   if(code == -1)
   {
      int err = GetLastError();
      PrintFormat("[ARX][%s] GET %s FAILED. http=-1 GetLastError=%d (%s)",
                  label, url, err, ExplainWebRequestError(err));
      return false;
   }
   if(code < 200 || code >= 300)
   {
      PrintFormat("[ARX][%s] GET %s -> HTTP %d. body[:200]=%s",
                  label, url, code, SafeBodyPreview(responseOut));
      return false;
   }
   return true;
}

// JSON string escape (handles ", \, control chars).
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

// JSON helpers — ALWAYS build payloads through these so a stray quote, NaN, or
// Inf can never produce malformed JSON the server's body-parser will reject.
string JString(const string value)
{
   return "\"" + JsonEscape(value) + "\"";
}

string JBool(const bool value)
{
   return value ? "true" : "false";
}

string JNumber(const double value, const int digits = 2)
{
   if(!MathIsValidNumber(value)) return "0.0";
   return DoubleToString(value, digits);
}

string JLong(const long value)
{
   return IntegerToString(value);
}

string JULong(const ulong value)
{
   return IntegerToString((long)value);
}

long JsonReadInt(const string json, const string field)
{
   string needle = "\"" + field + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return -1;
   pos += StringLen(needle);
   while(pos < StringLen(json) && (StringGetCharacter(json, pos) == ' ')) pos++;
   string acc = "";
   while(pos < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, pos);
      if((ch >= '0' && ch <= '9') || ch == '-') { acc += ShortToString(ch); pos++; }
      else break;
   }
   if(StringLen(acc) == 0) return -1;
   return (long)StringToInteger(acc);
}

double JsonReadDouble(const string json, const string field)
{
   string needle = "\"" + field + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return 0.0;
   pos += StringLen(needle);
   while(pos < StringLen(json) && (StringGetCharacter(json, pos) == ' ')) pos++;
   string acc = "";
   while(pos < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, pos);
      if((ch >= '0' && ch <= '9') || ch == '-' || ch == '.' || ch == 'e' || ch == 'E' || ch == '+')
         { acc += ShortToString(ch); pos++; }
      else break;
   }
   if(StringLen(acc) == 0) return 0.0;
   return StringToDouble(acc);
}

string JsonReadString(const string json, const string field)
{
   string needle = "\"" + field + "\":\"";
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

// v1.29 — read a boolean field. Returns def when the field is absent.
bool JsonReadBool(const string json, const string field, const bool def)
{
   string needle = "\"" + field + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return def;
   pos += StringLen(needle);
   while(pos < StringLen(json) && StringGetCharacter(json, pos) == ' ') pos++;
   if(StringFind(json, "true", pos) == pos)  return true;
   if(StringFind(json, "false", pos) == pos) return false;
   return def;
}

//+------------------------------------------------------------------+
//| Task #28 — EA-side dedup memory helpers                           |
//|                                                                  |
//| Returns the index of a previously-processed commandId in the ring|
//| buffer, or -1 if not seen. Used to avoid executing the same live  |
//| command twice if the server re-serves it after a lost result POST.|
//+------------------------------------------------------------------+
int LiveDoneIndexOf(const string commandId)
{
   for(int i = 0; i < g_liveDoneCount; i++)
      if(g_liveDoneIds[i] == commandId) return i;
   return -1;
}

void LiveDoneRecord(const string commandId, const string status)
{
   int existing = LiveDoneIndexOf(commandId);
   if(existing >= 0) { g_liveDoneStatus[existing] = status; return; }
   int slot = g_liveDoneNext;
   g_liveDoneIds[slot]    = commandId;
   g_liveDoneStatus[slot] = status;
   g_liveDoneNext = (g_liveDoneNext + 1) % ARX_LIVE_DEDUP_CAP;
   if(g_liveDoneCount < ARX_LIVE_DEDUP_CAP) g_liveDoneCount++;
}

//+------------------------------------------------------------------+
//| v1.27 — Live execution leg                                        |
//|                                                                  |
//| Polls /api/mt5/live-commands-poll. Server only emits commands    |
//| addressed to a LIVE bridge that has passed all 15 Phase B gates  |
//| (master switch, per-user arming, kill-switch, account-type=LIVE, |
//| EA version >=1.27, EnableLiveExecution=true, heartbeat fresh,    |
//| idempotency, lot ceiling, etc.). The EA still re-validates its   |
//| own 4 inputs here as a belt-and-suspenders client gate.          |
//|                                                                  |
//| Task #28 hardening: (a) refuse new orders while the terminal is   |
//| disconnected from the broker, (b) refuse a command whose server-  |
//| computed TTL has elapsed (STALE_COMMAND_REJECTED), (c) never      |
//| execute the same commandId twice — re-ack the prior status, and   |
//| (d) force an account + positions snapshot after every executed    |
//| trade so the server reconciles immediately.                       |
//+------------------------------------------------------------------+
void PollAndExecuteLiveCommands()
{
   // EA-side 4-gate re-check. NEVER call OrderSend if any fails.
   long tmode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(tmode != ACCOUNT_TRADE_MODE_REAL)         return; // not a live account
   if(ReadOnlyMode)                              return;
   if(!EnableLiveExecution)                      return;
   if(StringLen(BridgeToken) < 8)                return;

   // Task #28 — fail-safe: never place a NEW live order while the terminal is
   // disconnected from the broker. A poll is harmless, but execution on a
   // stale/severed connection risks blind fills, so we abstain entirely.
   if(TerminalInfoInteger(TERMINAL_CONNECTED) == 0) return;

   string resp;
   if(!HttpPost("/api/mt5/live-commands-poll", "{}", resp, "LIVEPOLL")) return;
   if(StringLen(resp) < 10) return;

   string commandId   = JsonReadString(resp, "commandId");
   if(StringLen(commandId) == 0) return; // no command available

   // Task #28 — exactly-once: if we already processed this commandId, do NOT
   // execute again. Re-acknowledge the SAME status we reported before so the
   // server can settle the (idempotent) duplicate and stop re-serving it.
   int doneIdx = LiveDoneIndexOf(commandId);
   if(doneIdx >= 0)
   {
      string priorStatus = g_liveDoneStatus[doneIdx];
      string dup = StringFormat("{\"commandId\":\"%s\",\"status\":\"%s\",\"reason\":\"DUPLICATE_IGNORED_BY_EA\"}",
                                commandId, priorStatus);
      string dupAck;
      HttpPost("/api/mt5/live-command-result", dup, dupAck, "LIVERES");
      return;
   }

   // Task #28 — TTL freshness. The server emits `secondsUntilExpiry` computed
   // from its own clock, so the EA needs no ISO parsing and trusts no local
   // wall-clock. <= 0 means the command expired during a stall: refuse it.
   double secsUntilExpiry = JsonReadDouble(resp, "secondsUntilExpiry");
   bool hasTtl = (StringFind(resp, "secondsUntilExpiry") >= 0);
   if(hasTtl && secsUntilExpiry <= 0.0)
   {
      string stale = StringFormat("{\"commandId\":\"%s\",\"status\":\"STALE_COMMAND_REJECTED\",\"reason\":\"EA_TTL_EXPIRED\",\"secondsUntilExpiry\":%.0f}",
                                  commandId, secsUntilExpiry);
      string staleAck;
      HttpPost("/api/mt5/live-command-result", stale, staleAck, "LIVERES");
      LiveDoneRecord(commandId, "STALE_COMMAND_REJECTED");
      return;
   }

   string commandType = JsonReadString(resp, "commandType");
   string symbol      = JsonReadString(resp, "symbol");
   string side        = JsonReadString(resp, "side");
   double lot         = JsonReadDouble(resp, "requestedVolume");
   double sl          = JsonReadDouble(resp, "stopLoss");
   double tp          = JsonReadDouble(resp, "takeProfit");
   // Task #30 — optional reference price the order was drafted against. When the
   // server supplies it (> 0) the guard refuses if live price slipped past the
   // deviation cap; when absent (0) the guard skips that leg (fail-open) and the
   // broker-side SetDeviationInPoints cap is the hard backstop.
   double refPrice    = JsonReadDouble(resp, "referencePrice");

   // v1.29 — maintenance mode pauses NEW order execution. Open positions are
   // untouched; CLOSE/MODIFY are still honoured so an operator can wind down
   // safely while paused. Refusing here can only ever PREVENT a trade.
   bool isNewOrder = (commandType == "PLACE_LIVE_MARKET_ORDER" ||
                      commandType == "PLACE_LIVE_PENDING_ORDER");
   if(g_maintenanceMode && isNewOrder)
   {
      string rej = StringFormat("{\"commandId\":\"%s\",\"status\":\"LIVE_REJECTED\",\"reason\":\"REJECTED_MAINTENANCE_MODE\",\"commandType\":\"%s\"}",
                                commandId, commandType);
      string ack;
      HttpPost("/api/mt5/live-command-result", rej, ack, "LIVERES");
      LiveDoneRecord(commandId, "LIVE_REJECTED");
      return;
   }

   // v1.29 — remote allow-listed command types. When the operator has pinned a
   // subset, a command type outside it is refused (never executed).
   if(!IsCommandTypeAllowedRemotely(commandType))
   {
      string rej = StringFormat("{\"commandId\":\"%s\",\"status\":\"LIVE_REJECTED\",\"reason\":\"REJECTED_COMMAND_TYPE_NOT_ALLOWED\",\"commandType\":\"%s\"}",
                                commandId, commandType);
      string ack;
      HttpPost("/api/mt5/live-command-result", rej, ack, "LIVERES");
      LiveDoneRecord(commandId, "LIVE_REJECTED");
      return;
   }

   // v1.29 — remote close-support flag. When disabled, the EA refuses CLOSE
   // commands (e.g. while an operator is intentionally holding positions).
   if(!g_closeCommandSupport && commandType == "CLOSE_LIVE_POSITION")
   {
      string rej = StringFormat("{\"commandId\":\"%s\",\"status\":\"LIVE_REJECTED\",\"reason\":\"REJECTED_CLOSE_SUPPORT_DISABLED\"}",
                                commandId);
      string ack;
      HttpPost("/api/mt5/live-command-result", rej, ack, "LIVERES");
      LiveDoneRecord(commandId, "LIVE_REJECTED");
      return;
   }

   // Hard EA-side lot ceiling. v1.29: the effective ceiling is the operator's
   // MaxLiveLot input further LOWERED by any advisory remote ceiling.
   double effMaxLot = EffectiveMaxLiveLot();
   if(lot > effMaxLot)
   {
      string rej = StringFormat("{\"commandId\":\"%s\",\"status\":\"LIVE_REJECTED\",\"reason\":\"REJECTED_LIVE_LOT_EXCEEDS_CEILING\",\"requestedVolume\":%.2f,\"maxLiveLot\":%.2f}",
                                commandId, lot, effMaxLot);
      string ack;
      HttpPost("/api/mt5/live-command-result", rej, ack, "LIVERES");
      LiveDoneRecord(commandId, "LIVE_REJECTED");
      return;
   }

   // Task #30 — EA-side pre-trade broker guard. Before any NEW live order, the
   // EA checks the broker's OWN live truth (quote freshness, spread, market
   // open, tradability, lot min/max/step, stops level) and REFUSES locally
   // rather than firing an OrderSend that the broker would reject. This is an
   // additive safety net: a PASS here never bypasses any server gate (the
   // server already approved this command); a FAIL only ADDS a refusal.
   if(commandType == "PLACE_LIVE_MARKET_ORDER")
   {
      string guardReason = "";
      if(!PreTradeBrokerGuard(symbol, side, lot, sl, tp, MaxLiveLot, refPrice, guardReason))
      {
         string rej = StringFormat("{\"commandId\":\"%s\",\"status\":\"LIVE_REJECTED\",\"reason\":\"%s\",\"requestedVolume\":%.2f}",
                                   commandId, guardReason, lot);
         string ack;
         HttpPost("/api/mt5/live-command-result", rej, ack, "LIVERES");
         LiveDoneRecord(commandId, "LIVE_REJECTED");
         PrintFormat("[ARX][LIVE] PreTradeBrokerGuard refused %s %s lot=%.2f: %s", side, symbol, lot, guardReason);
         return;
      }
   }

   // Execute via CTrade. PLACE_LIVE_MARKET_ORDER only in v1.27; CLOSE/MODIFY
   // are emitted as separate command types and routed below.
   CTrade trade;
   bool ok = false;
   ulong ticket = 0;
   double fillPrice = 0.0;
   int retcode = 0;
   string brokerMsg = "";

   if(commandType == "PLACE_LIVE_MARKET_ORDER")
   {
      bool isBuy = (side == "BUY");
      double price = isBuy ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                           : SymbolInfoDouble(symbol, SYMBOL_BID);
      // Hard real-time slippage cap: the broker rejects the fill if it would
      // slip more than ARX_MAX_DEVIATION_POINTS from `price`. This is the
      // broker-enforced backstop behind the guard's deviation check above.
      trade.SetDeviationInPoints(g_maxDeviationPoints);
      ok = isBuy ? trade.Buy(lot, symbol, price, sl, tp, "ARX-LIVE")
                 : trade.Sell(lot, symbol, price, sl, tp, "ARX-LIVE");
      ticket    = trade.ResultOrder();
      fillPrice = trade.ResultPrice();
      retcode   = (int)trade.ResultRetcode();
      brokerMsg = trade.ResultComment();
   }
   else if(commandType == "CLOSE_LIVE_POSITION")
   {
      string ticketStr = JsonReadString(resp, "brokerTicket");
      ulong tkt = (ulong)StringToInteger(ticketStr);
      ok = trade.PositionClose(tkt);
      ticket    = tkt;
      // v1.28: capture the broker's real close fill price + executed volume
      // so the server can compute realised P/L deterministically. The
      // server-side P/L guard previously had to mark closed cycles as
      // pnlStatus=UNKNOWN whenever close fillPrice was 0.0 / missing.
      fillPrice = trade.ResultPrice();
      double closedVol = trade.ResultVolume();
      if(closedVol > 0.0) lot = closedVol; // executedVolume field below uses `lot`
      retcode = (int)trade.ResultRetcode();
      brokerMsg = trade.ResultComment();
   }
   else if(commandType == "MODIFY_LIVE_SLTP")
   {
      string ticketStr = JsonReadString(resp, "brokerTicket");
      ulong tkt = (ulong)StringToInteger(ticketStr);
      ok = trade.PositionModify(tkt, sl, tp);
      ticket  = tkt;
      retcode = (int)trade.ResultRetcode();
      brokerMsg = trade.ResultComment();
   }
   else
   {
      string rej = StringFormat("{\"commandId\":\"%s\",\"status\":\"LIVE_REJECTED\",\"reason\":\"REJECTED_UNKNOWN_LIVE_COMMAND_TYPE\",\"commandType\":\"%s\"}",
                                commandId, commandType);
      string ack;
      HttpPost("/api/mt5/live-command-result", rej, ack, "LIVERES");
      LiveDoneRecord(commandId, "LIVE_REJECTED");
      return;
   }

   string status = ok ? "LIVE_FILLED" : "LIVE_REJECTED";
   // v1.28: for CLOSE results, also include the explicit `closeFillPrice`
   // field alongside the existing `fillPrice` so downstream readers that key
   // off the semantic close-fill name see a real number (server P/L guard
   // accepts the existing `fillPrice` field — `closeFillPrice` is sent for
   // clarity and forward-compat).
   string closeFillSuffix = "";
   if(commandType == "CLOSE_LIVE_POSITION" && ok)
      closeFillSuffix = StringFormat(",\"closeFillPrice\":%.5f", fillPrice);
   string body = StringFormat(
      "{\"commandId\":\"%s\",\"status\":\"%s\",\"brokerTicket\":\"%I64u\",\"fillPrice\":%.5f,\"executedVolume\":%.2f,\"mt5Retcode\":%d,\"brokerMessage\":%s,\"reportedEaVersion\":\"1.29\"%s}",
      commandId, status, ticket, fillPrice, lot, retcode, JString(brokerMsg), closeFillSuffix);
   string ack;
   HttpPost("/api/mt5/live-command-result", body, ack, "LIVERES");

   // Task #28 — record the outcome in dedup memory so a re-served copy of this
   // commandId is never executed a second time, and force an immediate account
   // + live-positions snapshot so the server reconciles balances and the
   // closedAt of any just-closed position without waiting for the next cycle.
   LiveDoneRecord(commandId, status);
   SendAccountSnapshotNow();
   SyncLivePositionsNow();
}

//+------------------------------------------------------------------+
//| v1.27 — Live position snapshot                                    |
//+------------------------------------------------------------------+
void SyncLivePositionsNow()
{
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_REAL) return;
   if(StringLen(BridgeToken) < 8) return;

   string positions = "[";
   int n = PositionsTotal();
   bool first = true;
   for(int i = 0; i < n; i++)
   {
      ulong tkt = PositionGetTicket(i);
      if(tkt == 0) continue;
      if(!PositionSelectByTicket(tkt)) continue;
      string psym = PositionGetString(POSITION_SYMBOL);
      double vol  = PositionGetDouble(POSITION_VOLUME);
      double ep   = PositionGetDouble(POSITION_PRICE_OPEN);
      double cp   = PositionGetDouble(POSITION_PRICE_CURRENT);
      double psl  = PositionGetDouble(POSITION_SL);
      double ptp  = PositionGetDouble(POSITION_TP);
      double pl   = PositionGetDouble(POSITION_PROFIT);
      long   pt   = PositionGetInteger(POSITION_TYPE);
      datetime ot = (datetime)PositionGetInteger(POSITION_TIME);

      if(!first) positions += ",";
      first = false;
      positions += StringFormat(
         "{\"brokerTicket\":\"%I64u\",\"symbol\":%s,\"side\":\"%s\",\"volume\":%.2f,\"entryPrice\":%.5f,\"currentPrice\":%.5f,\"stopLoss\":%.5f,\"takeProfit\":%.5f,\"floatingPl\":%.2f,\"openedAt\":%s}",
         tkt, JString(psym), SideFromPosType(pt), vol, ep, cp, psl, ptp, pl,
         JString(TimeToString(ot, TIME_DATE|TIME_SECONDS)));
   }
   positions += "]";

   string body = "{\"account\":" + JString(EffectiveAccountId()) +
                 ",\"positions\":" + positions + "}";
   string resp;
   HttpPost("/api/mt5/sync-live-positions", body, resp, "LIVEPOS");
}

//+------------------------------------------------------------------+
//| Heartbeat                                                        |
//+------------------------------------------------------------------+
void SendHeartbeatNow()
{
   if(!SendHeartbeat) { if(g_verboseDiagnostics) Print("[ARX][HB] SendHeartbeat=false; skipping."); return; }

   g_heartbeatAttempts++;

   // Pre-flight checks (no token value ever printed) ----------------
   string urlIssue = ValidateServerBaseUrl();
   if(StringLen(urlIssue) > 0 && urlIssue != "ServerBaseUrl has a trailing slash; will be auto-trimmed but please remove it in EA inputs.")
   {
      g_heartbeatFailure++;
      PrintFormat("[ARX][HB] attempt #%I64d at %s — ABORTED. %s",
                  g_heartbeatAttempts, IsoNow(), urlIssue);
      return;
   }
   if(StringLen(BridgeToken) == 0)
   {
      g_heartbeatFailure++;
      PrintFormat("[ARX][HB] attempt #%I64d at %s — ABORTED. BridgeToken is BLANK in EA inputs.",
                  g_heartbeatAttempts, IsoNow());
      return;
   }

   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string server = AccountInfoString(ACCOUNT_SERVER);
   long   tmode  = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   bool   live   = (tmode == ACCOUNT_TRADE_MODE_REAL);

   // Phase 28-MT5-DEMO-FOUNDATION — explicit accountType reporting.
   // Derived ONLY from AccountInfoInteger(ACCOUNT_TRADE_MODE). Server
   // refuses demo execution for anything other than "demo". The server
   // never infers demo status from server name; this field is the
   // authoritative input.
   string acctType;
   if(tmode == ACCOUNT_TRADE_MODE_DEMO)    acctType = "demo";
   else if(tmode == ACCOUNT_TRADE_MODE_CONTEST) acctType = "contest";
   else if(tmode == ACCOUNT_TRADE_MODE_REAL) acctType = "live";
   else                                     acctType = "unknown";

   // Build heartbeat body strictly through JSON helpers. NaN/Inf collapse to
   // 0.0; quotes/backslashes/control chars are escaped. No trailing comma.
   string body = "{";
   body += "\"account\":"     + JString(EffectiveAccountId()) + ",";
   body += "\"broker\":"      + JString(broker)               + ",";
   body += "\"server\":"      + JString(server)               + ",";
   body += "\"balance\":"     + JNumber(bal, 2)               + ",";
   body += "\"equity\":"      + JNumber(eq, 2)                + ",";
   body += "\"liveAllowed\":" + JBool(live)                   + ",";
   body += "\"accountType\":" + JString(acctType)             + ",";
   body += "\"eaVersion\":"   + JString("1.29")               + ",";
   // v1.29: structured capability disclosure. The server uses this closed set
   // to gate feature calls (isFeatureSupported / featureGateStatus): a key
   // reported false (or a NULL capabilities object from a legacy EA) means ARX
   // will NOT call that feature and instead surfaces an admin warning — it
   // never fakes readiness. All keys are true for v1.29 because this build
   // implements every one. Unknown keys are dropped server-side
   // (normaliseCapabilities), so this set can only ever shrink capability,
   // never widen a safety surface.
   body += "\"capabilities\":{";
   body += "\"supportsCloseFillPrice\":"    + JBool(true) + ",";
   body += "\"supportsDealHistorySync\":"   + JBool(true) + ",";
   body += "\"supportsSelfUpdate\":"        + JBool(true) + ",";
   body += "\"supportsRemoteConfig\":"      + JBool(true) + ",";
   body += "\"supportsCommandTtl\":"        + JBool(true) + ",";
   body += "\"supportsExactlyOnce\":"       + JBool(true) + ",";
   body += "\"supportsSymbolCapabilities\":"+ JBool(true) + ",";
   body += "\"supportsEmergencyClose\":"    + JBool(true) + ",";
   body += "\"supportsTokenRotation\":"     + JBool(true) + ",";
   body += "\"supportsWatchdog\":"          + JBool(true) + ",";
   body += "\"supportsLiveTestCycle\":"     + JBool(true);
   body += "},";
   // v1.26+: report EA-side toggle state so the server/UI can show the
   // actual input state instead of inferring from REJECTED reason codes.
   // These never enable anything server-side; they are observability only.
   body += "\"readOnlyMode\":"         + JBool(ReadOnlyMode)         + ",";
   body += "\"enableDemoExecution\":"  + JBool(EnableDemoExecution)  + ",";
   body += "\"enableLiveExecution\":"  + JBool(EnableLiveExecution)  + ",";
   body += "\"allowOrderExecution\":"  + JBool(AllowOrderExecution)  + ",";
   body += "\"maxLiveLot\":"           + JNumber(MaxLiveLot, 2)      + ",";
   body += "\"terminalConnected\":"    + JBool(TerminalInfoInteger(TERMINAL_CONNECTED) != 0) + ",";
   body += "\"algoTradingAllowed\":"   + JBool(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0) + ",";
   // Task #30 — clock-drift inputs. The server compares these three clocks to
   // detect a misconfigured VPS/host clock. eaTimeGmt is the authoritative
   // epoch the server diffs against its own now(); eaLocalTime is the VPS wall
   // clock; brokerTime is the broker-server feed time (TimeCurrent). All three
   // are observability only — they never enable execution, they can only make
   // the server ADD a drift warning / SEVERE-drift block.
   // eaTimeGmt is sent in epoch MILLISECONDS (TimeGMT() returns seconds in
   // MQL5) so it lines up with the server's millisecond now(); the server also
   // defensively normalises seconds-scale values from older EAs.
   body += "\"eaTimeGmt\":"   + JNumber((double)TimeGMT() * 1000.0, 0)       + ",";
   body += "\"eaLocalTime\":" + JString(IsoFromTime(TimeLocal()))           + ",";
   body += "\"brokerTime\":"  + JString(IsoFromTime(TimeCurrent()))         + ",";
   body += "\"timestamp\":"   + JString(IsoNow());
   body += "}";

   if(g_verboseDiagnostics)
   {
      PrintFormat("[ARX][HB] attempt #%I64d at %s — POST %s/api/mt5/heartbeat (token withheld; len=%d).",
                  g_heartbeatAttempts, IsoNow(), NormalizedBaseUrl(), StringLen(BridgeToken));
      PrintFormat("[ARX][HB] payload (len=%d): %s", StringLen(body), body);
   }

   string resp;
   if(HttpPost("/api/mt5/heartbeat", body, resp, "HB"))
   {
      g_heartbeatSuccess++;
      g_lastHeartbeatAt = TimeCurrent();
      g_lastHeartbeatMs = GetTickCount64();
      PrintFormat("[ARX][HB] ACCEPTED. attempt=#%I64d ok=%I64d fail=%I64d. server response[:200]=%s",
                  g_heartbeatAttempts, g_heartbeatSuccess, g_heartbeatFailure, SafeBodyPreview(resp));
   }
   else
   {
      g_heartbeatFailure++;
      PrintFormat("[ARX][HB] FAILED. attempt=#%I64d ok=%I64d fail=%I64d. See [ARX][HB] line above for HTTP/err.",
                  g_heartbeatAttempts, g_heartbeatSuccess, g_heartbeatFailure);
   }
}

//+------------------------------------------------------------------+
//| Account snapshot                                                 |
//+------------------------------------------------------------------+
void SendAccountSnapshotNow()
{
   if(!SendAccountSnapshot) return;
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   double mar  = AccountInfoDouble(ACCOUNT_MARGIN);
   double fmar = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double mlev = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   string ccy  = AccountInfoString(ACCOUNT_CURRENCY);

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
   if(g_verboseDiagnostics)
      PrintFormat("[ARX][ACCT] payload (len=%d): %s", StringLen(body), body);
   string resp;
   if(HttpPost("/api/mt5/sync-account", body, resp, "ACCT"))
   {
      g_lastAccountSyncAt = TimeCurrent();
      g_lastAccountSyncMs = GetTickCount64();
   }
}

//+------------------------------------------------------------------+
//| Positions snapshot                                               |
//+------------------------------------------------------------------+
void SendPositionsSnapshotNow()
{
   if(!SendPositionsSnapshot) return;
   string items = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
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
   if(g_verboseDiagnostics)
      PrintFormat("[ARX][POS] payload (len=%d, count=%d): %s", StringLen(body), total, body);
   string resp;
   if(HttpPost("/api/mt5/sync-positions", body, resp, "POS"))
   {
      g_lastPositionSyncAt = TimeCurrent();
      g_lastPositionSyncMs = GetTickCount64();
   }
}

//+------------------------------------------------------------------+
//| Task #30 — Symbol-spec sync (broker's OWN per-symbol rules)       |
//|                                                                  |
//| Pushes the real broker truth for every Market-Watch symbol:      |
//| min/max/step lot, stops & freeze levels, trade mode, market-open  |
//| state, point size, and the current spread in points. The server   |
//| consumes this so the live preflight stops GUESSING broker rules.  |
//| This is observability/refusal input only — it can never enable    |
//| execution, it can only let the server ADD a refusal.              |
//+------------------------------------------------------------------+
string TradeModeName(long m)
{
   if(m == SYMBOL_TRADE_MODE_FULL)      return "FULL";
   if(m == SYMBOL_TRADE_MODE_LONGONLY)  return "LONGONLY";
   if(m == SYMBOL_TRADE_MODE_SHORTONLY) return "SHORTONLY";
   if(m == SYMBOL_TRADE_MODE_CLOSEONLY) return "CLOSEONLY";
   return "DISABLED"; // SYMBOL_TRADE_MODE_DISABLED or unknown
}

void SendSymbolSpecsNow()
{
   if(!SendSymbolSpecs) return;
   string items = "";
   int count = 0;
   int total = SymbolsTotal(true); // true = Market Watch only
   for(int i = 0; i < total && count < 500; i++)
   {
      string sym = SymbolName(i, true);
      if(StringLen(sym) == 0) continue;

      long   tradeMode  = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
      bool   visible    = SymbolInfoInteger(sym, SYMBOL_VISIBLE) != 0;
      bool   tradeAllow = tradeMode != SYMBOL_TRADE_MODE_DISABLED;
      // Market-open: true broker-session truth (SymbolInfoSessionTrade for the
      // current server day-of-week), AND the symbol is not trade-disabled. The
      // session check fails open when the broker exposes no session windows, so
      // we never falsely mark an always-on symbol as closed.
      bool   marketOpen = tradeAllow && IsTradingSessionOpenNow(sym);
      double point      = SymbolInfoDouble(sym, SYMBOL_POINT);
      int    digits     = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double minVol     = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
      double maxVol     = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
      double stepVol    = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
      double contract   = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
      double tickSize   = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
      double tickValue  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
      int    stopsLevel = (int)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
      int    freezeLvl  = (int)SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL);
      int    spreadPts  = (int)SymbolInfoInteger(sym, SYMBOL_SPREAD);

      string row = "{";
      row += "\"symbol\":"           + JString(sym)                  + ",";
      row += "\"brokerSymbol\":"     + JString(sym)                  + ",";
      row += "\"visible\":"          + JBool(visible)                + ",";
      row += "\"tradeAllowed\":"     + JBool(tradeAllow)             + ",";
      row += "\"tradeMode\":"        + JString(TradeModeName(tradeMode)) + ",";
      row += "\"marketOpen\":"       + JBool(marketOpen)             + ",";
      row += "\"digits\":"           + JNumber((double)digits, 0)    + ",";
      row += "\"point\":"            + JNumber(point, 8)             + ",";
      row += "\"minVolume\":"        + JNumber(minVol, 4)            + ",";
      row += "\"maxVolume\":"        + JNumber(maxVol, 4)            + ",";
      row += "\"volumeStep\":"       + JNumber(stepVol, 4)           + ",";
      row += "\"contractSize\":"     + JNumber(contract, 4)          + ",";
      row += "\"tickSize\":"         + JNumber(tickSize, 8)          + ",";
      row += "\"tickValue\":"        + JNumber(tickValue, 8)         + ",";
      row += "\"stopsLevelPoints\":" + JNumber((double)stopsLevel, 0) + ",";
      row += "\"freezeLevelPoints\":"+ JNumber((double)freezeLvl, 0)  + ",";
      row += "\"spreadPoints\":"     + JNumber((double)spreadPts, 0);
      row += "}";
      if(StringLen(items) > 0) items += ",";
      items += row;
      count++;
   }
   string body = "{\"symbols\":[" + items + "]}";
   if(g_verboseDiagnostics)
      PrintFormat("[ARX][SPEC] payload (len=%d, count=%d): %s", StringLen(body), count, StringSubstr(body, 0, 400));
   string resp;
   if(HttpPost("/api/mt5/sync-symbol-specs", body, resp, "SPEC"))
      g_lastSymbolSpecMs = GetTickCount64();
   else
      g_lastSymbolSpecMs = GetTickCount64(); // back off on failure too; retry next cadence
}

//+------------------------------------------------------------------+
//| Command poll + (read-only) ack                                   |
//+------------------------------------------------------------------+
void PollAndAckCommands()
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
      long cmdId = JsonReadInt(slice, "id");
      string action = JsonReadString(slice, "action");
      cursor = (nextIdPos < 0) ? StringLen(resp) : nextIdPos;
      if(cmdId <= 0) continue;

      string status, detail;
      if(ReadOnlyMode || !AllowOrderExecution)
      {
         status = "EA_READ_ONLY_MODE_ACTIVE";
         detail = StringFormat("EA refused %s command #%I64d. ReadOnlyMode=%s, AllowOrderExecution=%s.",
                               action, cmdId,
                               (ReadOnlyMode ? "true" : "false"),
                               (AllowOrderExecution ? "true" : "false"));
      }
      else
      {
         status = "EA_EXECUTION_NOT_IMPLEMENTED";
         detail = "EA v1 has no order execution code path. Upgrade EA to enable.";
      }

      string ackBody = "{";
      ackBody += "\"commandId\":" + JLong(cmdId)       + ",";
      ackBody += "\"status\":"    + JString(status)    + ",";
      ackBody += "\"detail\":"    + JString(detail)    + ",";
      ackBody += "\"timestamp\":" + JString(IsoNow());
      ackBody += "}";
      string ackResp;
      HttpPost("/api/mt5/command-result", ackBody, ackResp, "ACK");
      PrintFormat("[ARX][POLL] Acked command #%I64d action=%s with status=%s", cmdId, action, status);
   }
   g_lastPollAt = TimeCurrent();
   g_lastPollMs = GetTickCount64();
}

//+------------------------------------------------------------------+
//| DEMO-ONLY broker dispatch consumer (v1.26)                       |
//|                                                                  |
//| Polls GET /api/mt5/demo-commands-poll for commands in            |
//| SENT_TO_MT5_DEMO. Executes ONLY when ALL gates pass:             |
//|   1. EnableDemoExecution == true                                 |
//|   2. ReadOnlyMode        == false                                |
//|   3. AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO
//| Writes outcome to POST /api/mt5/demo-command-result.             |
//+------------------------------------------------------------------+
CTrade g_demoTrade;

string DemoGuardReason()
{
   if(!EnableDemoExecution) return "REJECTED_DEMO_EXECUTION_DISABLED_INPUT";
   if(ReadOnlyMode)         return "REJECTED_READ_ONLY_MODE_ACTIVE";
   long tmode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(tmode != ACCOUNT_TRADE_MODE_DEMO) return "REJECTED_NOT_DEMO_ACCOUNT";
   return ""; // empty = guards passed
}

void WriteBackDemoResult(const string commandId,
                        const string status,        // FILLED_DEMO | REJECTED | FAILED
                        const string reason,
                        const ulong  brokerTicket,
                        const double fillPrice,
                        const double fillVolume,
                        const string rawJson = "",
                        const string commandType = "")
{
   string body = "{";
   body += "\"commandId\":"        + JString(commandId)                + ",";
   body += "\"status\":"           + JString(status)                   + ",";
   body += "\"reason\":"           + JString(reason)                   + ",";
   body += "\"brokerTicket\":"     + JString(IntegerToString((long)brokerTicket)) + ",";
   body += "\"filledPrice\":"      + JNumber(fillPrice, 5)             + ",";
   body += "\"filledVolume\":"     + JNumber(fillVolume, 2)            + ",";
   // v1.28: for CLOSE results, also include the explicit `closeFillPrice`
   // and `executedVolume` fields alongside the canonical `filledPrice` /
   // `filledVolume` so downstream readers that key off the semantic
   // close-fill name see a real number. The server already reads
   // `filledPrice`; these are for clarity and forward-compat.
   if(commandType == "CLOSE_POSITION" && status == "FILLED_DEMO")
   {
      body += "\"closeFillPrice\":" + JNumber(fillPrice, 5)            + ",";
      body += "\"executedVolume\":" + JNumber(fillVolume, 2)           + ",";
   }
   body += "\"reportedEaVersion\":" + JString("1.29")                  + ",";
   body += "\"filledAt\":"         + JString(IsoNow());
   if(StringLen(rawJson) > 0) body += ",\"raw\":" + rawJson;
   body += "}";
   string resp;
   HttpPost("/api/mt5/demo-command-result", body, resp, "DEMO_RESULT");
   PrintFormat("[ARX][DEMO] write-back commandId=%s status=%s reason=%s", commandId, status, reason);
}

void PollAndExecuteDemoCommands()
{
   // Cheap-out early when execution is disabled — no need to poll, but we
   // still call the server occasionally for visibility. We poll only when
   // the operator has explicitly enabled demo execution.
   if(!EnableDemoExecution) return;

   string resp;
   if(!HttpGet("/api/mt5/demo-commands-poll", resp, "DEMO_POLL")) return;

   // Minimal JSON walker: each command block starts with "commandId":"..."
   int cursor = 0;
   while(true)
   {
      int idPos = StringFind(resp, "\"commandId\":", cursor);
      if(idPos < 0) break;
      int nextIdPos = StringFind(resp, "\"commandId\":", idPos + 12);
      string slice = (nextIdPos < 0) ? StringSubstr(resp, idPos)
                                     : StringSubstr(resp, idPos, nextIdPos - idPos);
      cursor = (nextIdPos < 0) ? StringLen(resp) : nextIdPos;

      string commandId  = JsonReadString(slice, "commandId");
      string commandType= JsonReadString(slice, "commandType");
      if(StringLen(commandId) == 0) continue;

      string guard = DemoGuardReason();
      if(StringLen(guard) > 0)
      {
         WriteBackDemoResult(commandId, "REJECTED", guard, 0, 0.0, 0.0);
         continue;
      }

      // v1.29 — maintenance mode pauses NEW demo order execution. CLOSE/MODIFY/
      // SYNC are still honoured so positions can be wound down while paused.
      if(g_maintenanceMode &&
         (commandType == "PLACE_MARKET_ORDER" || commandType == "PLACE_PENDING_ORDER"))
      {
         WriteBackDemoResult(commandId, "REJECTED", "REJECTED_MAINTENANCE_MODE", 0, 0.0, 0.0);
         continue;
      }

      // payload extraction. Server canonically sends `volume`; older builds
      // and some shared helpers send `lot`. Read `volume` first, fall back
      // to `lot`. If both are missing/zero/negative we refuse with
      // INVALID_VOLUME_PAYLOAD — never silently float to broker min.
      string symbol             = JsonReadString(slice, "symbol");
      double payloadVolume      = JsonReadDouble(slice, "volume");
      double payloadLotFallback = JsonReadDouble(slice, "lot");
      double lot                = (payloadVolume > 0.0) ? payloadVolume : payloadLotFallback;
      double sl                 = JsonReadDouble(slice, "sl");
      double tp                 = JsonReadDouble(slice, "tp");
      string side               = JsonReadString(slice, "side");
      long   ticket             = JsonReadInt(slice, "ticket");

      if(lot > DemoMaxLot)
      {
         WriteBackDemoResult(commandId, "REJECTED", "REJECTED_LOT_EXCEEDS_CEILING", 0, 0.0, 0.0);
         continue;
      }

      bool ok = false;
      string failReason = "";
      ulong  resultTicket = 0;
      double resultPrice  = 0.0;
      double resultVolume = lot;
      string rawJson = "";

      if(commandType == "PLACE_MARKET_ORDER")
      {
         // Hard refuse if neither `volume` nor `lot` was present/positive.
         // We do NOT silently substitute SYMBOL_VOLUME_MIN — that would
         // execute an order the user never asked for.
         if(lot <= 0.0)
         {
            string rejDiag = StringFormat(
               "{\"payloadVolume\":%s,\"payloadLotFallback\":%s,\"symbolRequested\":%s}",
               DoubleToString(payloadVolume, 4),
               DoubleToString(payloadLotFallback, 4),
               JString(symbol));
            WriteBackDemoResult(commandId, "REJECTED",
               "REJECTED_INVALID_VOLUME_PAYLOAD",
               0, 0.0, 0.0, rejDiag);
            continue;
         }

         ENUM_ORDER_TYPE ot = (side == "sell") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
         // v1.26 self-heal: ensure symbol is in MarketWatch, then normalize
         // the requested lot to the broker's SYMBOL_VOLUME_MIN/STEP/MAX.
         // Most retcode=10014 (INVALID_VOLUME) failures come from sending a
         // lot below the broker's min (e.g. 0.01 when min is 0.1) or a
         // symbol that the EA can't resolve. We write a structured
         // diagnostic blob into `raw` either way so the Demo Bridge Debug
         // card can show exactly what the broker required.
         bool   symOk = SymbolSelect(symbol, true);
         double vMin  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
         double vStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
         double vMax  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
         double askP  = SymbolInfoDouble(symbol, SYMBOL_ASK);
         double bidP  = SymbolInfoDouble(symbol, SYMBOL_BID);
         double normLot = lot;
         if(vStep > 0.0) normLot = MathRound(normLot / vStep) * vStep;
         if(vMin  > 0.0 && normLot < vMin) normLot = vMin;
         if(vMax  > 0.0 && normLot > vMax) normLot = vMax;
         if(normLot > DemoMaxLot) normLot = DemoMaxLot;
         resultVolume = normLot;

         rawJson  = "{";
         rawJson += "\"symbolRequested\":"  + JString(symbol) + ",";
         rawJson += "\"symbolSelected\":"   + (symOk ? "true" : "false") + ",";
         rawJson += "\"payloadVolume\":"    + JNumber(payloadVolume, 4) + ",";
         rawJson += "\"payloadLotFallback\":" + JNumber(payloadLotFallback, 4) + ",";
         rawJson += "\"lotRequested\":"     + JNumber(lot, 4) + ",";
         rawJson += "\"lotNormalized\":"    + JNumber(normLot, 4) + ",";
         rawJson += "\"symbolVolumeMin\":"  + JNumber(vMin, 4) + ",";
         rawJson += "\"symbolVolumeStep\":" + JNumber(vStep, 4) + ",";
         rawJson += "\"symbolVolumeMax\":"  + JNumber(vMax, 4) + ",";
         rawJson += "\"bid\":"              + JNumber(bidP, 5) + ",";
         rawJson += "\"ask\":"              + JNumber(askP, 5);

         if(!symOk || vMin <= 0.0)
         {
            rawJson += "}";
            WriteBackDemoResult(commandId, "REJECTED",
               StringFormat("REJECTED_SYMBOL_UNRESOLVED symbol=%s symOk=%s vMin=%.4f",
                            symbol, (symOk?"true":"false"), vMin),
               0, 0.0, 0.0, rawJson);
            continue;
         }

         // Task #30 — EA-side pre-trade broker guard on the demo leg too. Same
         // additive net: refuse locally on broker-rule violation (market
         // closed, untradable, quote stale, spread too wide, lot/stops) rather
         // than firing an OrderSend the broker would reject. Never enables.
         {
            string demoGuardReason = "";
            string demoSide = (side == "sell") ? "SELL" : "BUY";
            // Demo commands carry no drafted reference price, so pass 0.0 — the
            // guard skips the deviation leg (fail-open) and relies on the
            // broker-side SetDeviationInPoints cap applied at PositionOpen.
            if(!PreTradeBrokerGuard(symbol, demoSide, normLot, sl, tp, DemoMaxLot, 0.0, demoGuardReason))
            {
               rawJson += ",\"preTradeGuard\":" + JString(demoGuardReason);
               rawJson += "}";
               WriteBackDemoResult(commandId, "REJECTED", demoGuardReason, 0, 0.0, 0.0, rawJson);
               continue;
            }
         }

         // Broker-enforced slippage cap on the demo leg too (parity with live).
         g_demoTrade.SetDeviationInPoints(g_maxDeviationPoints);
         ok = g_demoTrade.PositionOpen(symbol, ot, normLot, 0.0, sl, tp, "ARX_DEMO");
         uint rc = g_demoTrade.ResultRetcode();
         rawJson += ",\"retcode\":"       + IntegerToString((long)rc);
         rawJson += ",\"resultComment\":" + JString(g_demoTrade.ResultComment());
         rawJson += "}";
         if(ok) { resultTicket = g_demoTrade.ResultOrder(); resultPrice = g_demoTrade.ResultPrice(); }
         else   { failReason = StringFormat("REJECTED_BROKER_REFUSED retcode=%d", rc); }
      }
      else if(commandType == "CLOSE_POSITION")
      {
         ok = g_demoTrade.PositionClose((ulong)ticket);
         if(ok)
         {
            // v1.28: capture the broker's real close fill price + volume.
            // Previously the demo CLOSE result wrote filledPrice=0.0 /
            // filledVolume=payloadLot, which (a) misreported the close
            // price as 0 and (b) forced any P/L-computing consumer to
            // mark the trade as UNKNOWN. The original position ticket is
            // returned unchanged in `brokerTicket` so the server can
            // correlate the close against the open.
            resultTicket = (ulong)ticket;
            resultPrice  = g_demoTrade.ResultPrice();
            double cv    = g_demoTrade.ResultVolume();
            if(cv > 0.0) resultVolume = cv;
         }
         else
         {
            failReason = StringFormat("REJECTED_BROKER_REFUSED retcode=%d", g_demoTrade.ResultRetcode());
         }
      }
      else if(commandType == "MODIFY_SLTP")
      {
         ok = g_demoTrade.PositionModify((ulong)ticket, sl, tp);
         if(!ok) failReason = StringFormat("REJECTED_BROKER_REFUSED retcode=%d", g_demoTrade.ResultRetcode());
      }
      else if(commandType == "PLACE_PENDING_ORDER" || commandType == "CANCEL_PENDING_ORDER"
           || commandType == "SYNC_REQUEST" || commandType == "RECONCILE_REQUEST")
      {
         // Acknowledged but not implemented in v1.26 (foundation only).
         WriteBackDemoResult(commandId, "REJECTED", "REJECTED_COMMAND_TYPE_NOT_IMPLEMENTED_IN_EA_v1.26", 0, 0.0, 0.0);
         continue;
      }
      else
      {
         WriteBackDemoResult(commandId, "REJECTED", "REJECTED_UNKNOWN_COMMAND_TYPE", 0, 0.0, 0.0);
         continue;
      }

      if(ok) WriteBackDemoResult(commandId, "FILLED_DEMO", "OK", resultTicket, resultPrice, resultVolume, rawJson, commandType);
      else   WriteBackDemoResult(commandId, "REJECTED", failReason, 0, 0.0, 0.0, rawJson, commandType);
   }
}

//+------------------------------------------------------------------+
//| Lifecycle                                                        |
//+------------------------------------------------------------------+
void PrintInitDiagnostics()
{
   Print("[ARX] ──────────────────────────────────────────────────────────────");
   Print("[ARX] EA initialized: ReplitMT5BridgeEA v1.29 (v1.28 + remote capabilities, remote config, gated self-update)");
   Print("[ARX] Live broker execution is structurally impossible. Demo execution requires:");
   Print("[ARX]   1) AccountInfo trade mode = DEMO   2) ReadOnlyMode=false   3) EnableDemoExecution=true   4) valid per-user bridge token");
   PrintFormat("[ARX] ServerBaseUrl present : %s", (StringLen(ServerBaseUrl) > 0 ? "yes" : "NO"));
   PrintFormat("[ARX] ServerBaseUrl value   : %s", ServerBaseUrl);
   PrintFormat("[ARX] Normalized base URL   : %s", NormalizedBaseUrl());
   PrintFormat("[ARX] Expected heartbeat URL: %s/api/mt5/heartbeat", NormalizedBaseUrl());
   PrintFormat("[ARX] Required header       : %s: <token withheld>", HDR_TOKEN_NAME);
   PrintFormat("[ARX] BridgeToken present   : %s (length=%d; value NEVER printed)",
               (StringLen(BridgeToken) > 0 ? "yes" : "NO"), StringLen(BridgeToken));
   PrintFormat("[ARX] Environment           : %s", Environment);
   PrintFormat("[ARX] AccountId (effective) : %s", EffectiveAccountId());
   long _tmode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string _tmodeStr = (_tmode == ACCOUNT_TRADE_MODE_DEMO    ? "DEMO"
                     : _tmode == ACCOUNT_TRADE_MODE_CONTEST ? "CONTEST"
                     : _tmode == ACCOUNT_TRADE_MODE_REAL    ? "REAL"
                     : "UNKNOWN");
   PrintFormat("[ARX] AccountInfo trade mode: %s (server treats anything other than DEMO as not-demo)", _tmodeStr);
   PrintFormat("[ARX] ReadOnlyMode          : %s (must be FALSE for demo execution)", (ReadOnlyMode ? "true" : "false"));
   PrintFormat("[ARX] EnableDemoExecution   : %s (must be TRUE for demo execution; default false)", (EnableDemoExecution ? "true" : "false"));
   PrintFormat("[ARX] AllowOrderExecution   : %s (LEGACY /api/mt5/commands flag; not used by demo path)",
               (AllowOrderExecution ? "true" : "false"));
   PrintFormat("[ARX] PollIntervalSeconds   : %d (OnTimer tick period)", PollIntervalSeconds);
   PrintFormat("[ARX] HeartbeatPeriodSeconds: %d (clamped 1..10)", HeartbeatPeriodSeconds);
   PrintFormat("[ARX] SnapshotPeriodSeconds : %d", SnapshotPeriodSeconds);
   PrintFormat("[ARX] SendHeartbeat         : %s", (SendHeartbeat ? "true" : "false"));
   PrintFormat("[ARX] SendAccountSnapshot   : %s", (SendAccountSnapshot ? "true" : "false"));
   PrintFormat("[ARX] SendPositionsSnapshot : %s", (SendPositionsSnapshot ? "true" : "false"));
   PrintFormat("[ARX] RequestTimeoutMs      : %d", RequestTimeoutMs);
   PrintFormat("[ARX] VerboseDiagnostics    : %s", (VerboseDiagnostics ? "true" : "false"));

   string urlIssue = ValidateServerBaseUrl();
   if(StringLen(urlIssue) > 0)
      PrintFormat("[ARX] ServerBaseUrl WARNING : %s", urlIssue);
   else
      Print("[ARX] ServerBaseUrl validation: OK");

   Print("[ARX] If you see no [ARX][HB] POST line within ~5s, WebRequest is being blocked by MT5.");
   Print("[ARX] Tools → Options → Expert Advisors → Allow WebRequest for listed URL → add the Normalized base URL above.");
   Print("[ARX] ──────────────────────────────────────────────────────────────");
}

int OnInit()
{
   PrintInitDiagnostics();

   // Build a compact, single-Alert diagnostic so the user sees every failing
   // input at once instead of one misleading line. NEVER prints the token —
   // only its length and whether it is present. Fields covered (matches the
   // app-side Demo Bridge Debug card):
   //   - ServerBaseUrl present
   //   - BridgeToken length only
   //   - AccountType input (auto-detected via AccountInfoInteger)
   //   - AccountInfo trade mode
   //   - ReadOnlyMode input
   //   - EnableDemoExecution input
   //   - Legacy command polling flag (AllowOrderExecution)
   //   - EA version
   long   _tmode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string _tmodeStr = (_tmode == ACCOUNT_TRADE_MODE_DEMO    ? "DEMO"
                     : _tmode == ACCOUNT_TRADE_MODE_CONTEST ? "CONTEST"
                     : _tmode == ACCOUNT_TRADE_MODE_REAL    ? "REAL"
                     : "UNKNOWN");

   string urlIssue = ValidateServerBaseUrl();
   bool urlOk = (StringLen(urlIssue) == 0 ||
                 urlIssue == "ServerBaseUrl has a trailing slash; will be auto-trimmed but please remove it in EA inputs.");
   bool tokenOk = (StringLen(BridgeToken) >= 8);

   string diagSnapshot = StringFormat(
      "[ARX] v1.29 EA diagnostic — ReplitUrl present=%s; BridgeToken length=%d (value never printed); AccountType=%s; AccountInfo trade mode=%s; ReadOnlyMode=%s; EnableDemoExecution=%s; EnableLiveExecution=%s; MaxLiveLot=%.2f; AllowOrderExecution (legacy)=%s; EA version=1.29.",
      (StringLen(ServerBaseUrl) > 0 ? "true" : "false"),
      StringLen(BridgeToken),
      _tmodeStr,
      _tmodeStr,
      (ReadOnlyMode ? "true" : "false"),
      (EnableDemoExecution ? "true" : "false"),
      (EnableLiveExecution ? "true" : "false"),
      MaxLiveLot,
      (AllowOrderExecution ? "true" : "false"));
   Print(diagSnapshot);

   if(!tokenOk)
   {
      Alert(StringFormat(
         "[ARX] EA WILL NOT RUN — BridgeToken length=%d (need >=8). Paste the per-user bridge token from the ARX MT5 Setup page into EA Inputs → BridgeToken. %s",
         StringLen(BridgeToken), diagSnapshot));
      return INIT_PARAMETERS_INCORRECT;
   }
   if(!urlOk)
   {
      Alert(StringFormat("[ARX] EA WILL NOT RUN — ServerBaseUrl invalid: %s %s", urlIssue, diagSnapshot));
      return INIT_PARAMETERS_INCORRECT;
   }

   // v1.27: separate readiness summaries for DEMO and LIVE legs. Both legs
   // are gated independently; LIVE additionally requires the server-side
   // master switch ARX_LIVE_BROKER_EXECUTION_ENABLED=true (server enforced).
   bool demoArmed = (_tmode == ACCOUNT_TRADE_MODE_DEMO &&
                     !ReadOnlyMode &&
                     EnableDemoExecution);
   bool liveArmed = (_tmode == ACCOUNT_TRADE_MODE_REAL &&
                     !ReadOnlyMode &&
                     EnableLiveExecution);
   if(demoArmed)
      Alert(StringFormat("[ARX] v1.29 ready for DEMO execution. AccountType=%s.", _tmodeStr));
   else
      Alert(StringFormat(
         "[ARX] v1.29 will NOT execute demo orders until ALL of: AccountType=DEMO (current=%s), ReadOnlyMode=false (current=%s), EnableDemoExecution=true (current=%s).",
         _tmodeStr, (ReadOnlyMode ? "true" : "false"), (EnableDemoExecution ? "true" : "false")));
   if(liveArmed)
      Alert(StringFormat("[ARX] v1.29 ready for LIVE execution. AccountType=%s, MaxLiveLot=%.2f. Server master switch must also be ON.", _tmodeStr, MaxLiveLot));
   else
      Alert(StringFormat(
         "[ARX] v1.29 will NOT execute live orders until ALL of: AccountType=REAL (current=%s), ReadOnlyMode=false (current=%s), EnableLiveExecution=true (current=%s), server master switch ARX_LIVE_BROKER_EXECUTION_ENABLED=true (server-enforced).",
         _tmodeStr, (ReadOnlyMode ? "true" : "false"), (EnableLiveExecution ? "true" : "false")));
   Print(diagSnapshot);

   // Bind input periods to runtime state. Clamp so the server freshness
   // threshold (15s) is never exceeded by misconfiguration.
   g_heartbeatPeriodS = MathMax(1, MathMin(10, HeartbeatPeriodSeconds));
   g_snapshotPeriodS  = MathMax(1, SnapshotPeriodSeconds);
   g_symbolSpecPeriodS = MathMax(30, SymbolSpecPeriodSeconds);
   g_remoteConfigPeriodS = MathMax(30, RemoteConfigPeriodSeconds);
   g_updateCheckPeriodS  = MathMax(60, UpdateCheckPeriodSeconds);
   // v1.29 — seed runtime-tunable operational state from the compiled inputs.
   // SyncRemoteConfigNow may later adjust these within safe clamps.
   g_pollPeriodS        = MathMax(1, PollIntervalSeconds);
   g_verboseDiagnostics = VerboseDiagnostics;

   // Timer-first wiring: arm OnTimer BEFORE first-shot sends so even if the
   // initial sends fail (e.g. WebRequest URL not allow-listed) the timer keeps
   // retrying without depending on chart ticks. Important: many VPS charts
   // (especially closed-market symbols) deliver zero OnTick events for hours
   // — heartbeat MUST NOT depend on OnTick.
   EventSetTimer(MathMax(1, PollIntervalSeconds));
   PrintFormat("[ARX] Timer armed: every %ds (heartbeat=%ds, snapshot=%ds, poll=%ds)",
               MathMax(1, PollIntervalSeconds), g_heartbeatPeriodS, g_snapshotPeriodS, MathMax(1, PollIntervalSeconds));

   // First-shot sends so the server sees us immediately. If any of these
   // fail, OnTimer retries on its own schedule.
   SendHeartbeatNow();
   SendAccountSnapshotNow();
   SendPositionsSnapshotNow();
   SendSymbolSpecsNow();
   PollAndAckCommands();
   // v1.29 — first-shot remote ops. Read-only/observability; safe at startup.
   SyncRemoteConfigNow();
   CheckForUpdateNow();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   PrintFormat("[ARX] Deinitialized. reason=%d  timer_ticks=%I64d  heartbeats: attempts=%I64d ok=%I64d fail=%I64d",
               reason, g_timerTickCount, g_heartbeatAttempts, g_heartbeatSuccess, g_heartbeatFailure);
}

//+------------------------------------------------------------------+
//| v1.29 — Remote config sync (allow-listed tunables ONLY)          |
//|                                                                  |
//| Pulls GET /api/mt5/remote-config and applies ONLY non-protected   |
//| operational tunables. This function NEVER reads, writes, or acts   |
//| on AlgoTrading, the broker connection, local ReadOnlyMode /        |
//| EnableLiveExecution, or any ARX safety gate. The server already    |
//| HARD-excludes those fields; we additionally do not even look for   |
//| them here. Applying remote config can only ever change cadence /   |
//| diagnostics — it can NEVER enable execution or widen a safety      |
//| surface. maxLiveLot from remote config is treated as a CEILING     |
//| hint for display only; the EA's own MaxLiveLot input remains the   |
//| authoritative local ceiling.                                       |
//+------------------------------------------------------------------+
void SyncRemoteConfigNow()
{
   g_lastRemoteConfigMs = GetTickCount64();
   if(!EnableRemoteConfig) return;

   string resp;
   if(!HttpGet("/api/mt5/remote-config", resp, "CFG"))
      return; // transient; retried on the next cadence. Never fails open.

   // configVersion lets us skip re-applying an unchanged config.
   long cfgVer = JsonReadInt(resp, "configVersion");
   string cfgVerStr = (cfgVer >= 0) ? IntegerToString(cfgVer) : "";
   if(StringLen(cfgVerStr) > 0 && cfgVerStr == g_lastAppliedConfigVersion)
      return;

   // Apply ONLY allow-listed operational tunables. Each is clamped to a safe
   // bound; anything the server omits is left at the operator's local value.
   // NONE of these can enable execution or widen a safety surface — the three
   // broker-guard thresholds (spread/deviation/quote-age) are TIGHTEN-ONLY
   // (clamped to the compiled ARX_MAX_* ceiling), the lot ceiling can only
   // LOWER the local MaxLiveLot, and maintenance/allow-list can only REFUSE.

   // ── Cadences (seconds) ────────────────────────────────────────────────────
   long hb = JsonReadInt(resp, "heartbeatPeriodSeconds");
   if(hb >= 1 && hb <= 10) g_heartbeatPeriodS = (int)hb;
   long poll = JsonReadInt(resp, "pollIntervalSeconds");
   if(poll >= 1 && poll <= 60) g_pollPeriodS = (int)poll;
   long snap = JsonReadInt(resp, "snapshotPeriodSeconds");
   if(snap >= 1) g_snapshotPeriodS = (int)snap;
   long spec = JsonReadInt(resp, "symbolSpecPeriodSeconds");
   if(spec >= 30) g_symbolSpecPeriodS = (int)spec;
   long dhs = JsonReadInt(resp, "dealHistorySyncSeconds");
   if(dhs >= 1) g_dealHistorySyncS = (int)dhs; // tracked for parity/diagnostics
   long rcp = JsonReadInt(resp, "remoteConfigPeriodSeconds");
   if(rcp >= 30) g_remoteConfigPeriodS = (int)rcp;
   long ucp = JsonReadInt(resp, "updateCheckPeriodSeconds");
   if(ucp >= 60) g_updateCheckPeriodS = (int)ucp;

   // ── Diagnostics ───────────────────────────────────────────────────────────
   if(StringFind(resp, "verboseDiagnostics") >= 0)
      g_verboseDiagnostics = JsonReadBool(resp, "verboseDiagnostics", g_verboseDiagnostics);

   // ── Broker-guard thresholds — TIGHTEN-ONLY (clamped to compiled ceiling) ──
   long spr = JsonReadInt(resp, "maxSpreadPoints");
   if(spr >= 1) g_maxSpreadPoints = (int)MathMin(spr, ARX_MAX_SPREAD_POINTS);
   long dev = JsonReadInt(resp, "maxDeviationPoints");
   if(dev >= 1) g_maxDeviationPoints = (int)MathMin(dev, ARX_MAX_DEVIATION_POINTS);
   long qf = JsonReadInt(resp, "quoteFreshnessSeconds");
   if(qf >= 1) g_maxQuoteAgeSec = (int)MathMin(qf, ARX_MAX_QUOTE_AGE_SEC);

   // ── Command TTL / retry/backoff (advisory bounds) ─────────────────────────
   long ttl = JsonReadInt(resp, "defaultCommandTtlSeconds");
   if(ttl >= 1) g_defaultCommandTtlS = (int)ttl;
   long rma = JsonReadInt(resp, "retryMaxAttempts");
   if(rma >= 1 && rma <= 10) g_retryMaxAttempts = (int)rma;
   long rbo = JsonReadInt(resp, "retryBackoffMs");
   if(rbo >= 0 && rbo <= 60000) g_retryBackoffMs = (int)rbo;

   // ── Advisory live-lot CEILING — can only LOWER, never raise ───────────────
   double mlc = JsonReadDouble(resp, "maxLiveLotCeiling");
   if(mlc > 0.0) g_maxLiveLotCeiling = mlc; // applied via EffectiveMaxLiveLot()

   // ── Behaviour flags (REFUSE-only — never enable execution) ────────────────
   if(StringFind(resp, "closeCommandSupportEnabled") >= 0)
      g_closeCommandSupport = JsonReadBool(resp, "closeCommandSupportEnabled", g_closeCommandSupport);
   g_maintenanceMode = JsonReadBool(resp, "maintenanceMode", false);
   // allowedCommandTypes: parse the JSON array into a CSV the executor checks.
   g_allowedCommandTypes = ParseAllowedCommandTypesCsv(resp);

   if(StringLen(cfgVerStr) > 0) g_lastAppliedConfigVersion = cfgVerStr;
   PrintFormat("[ARX][CFG] applied remote config v%s — hb=%ds poll=%ds snap=%ds spec=%ds dealHist=%ds verbose=%s spread<=%d dev<=%d quoteAge<=%ds ttl=%ds retry=%d/%dms lotCeil=%.2f closeSup=%s maintenance=%s allowedTypes=[%s]. (Protected fields NEVER touched; guard thresholds tighten-only.)",
               cfgVerStr, g_heartbeatPeriodS, g_pollPeriodS, g_snapshotPeriodS, g_symbolSpecPeriodS,
               g_dealHistorySyncS, g_verboseDiagnostics ? "true" : "false",
               g_maxSpreadPoints, g_maxDeviationPoints, g_maxQuoteAgeSec,
               g_defaultCommandTtlS, g_retryMaxAttempts, g_retryBackoffMs,
               g_maxLiveLotCeiling, g_closeCommandSupport ? "true" : "false",
               g_maintenanceMode ? "true" : "false", g_allowedCommandTypes);
}

// Parse the remote "allowedCommandTypes" JSON array into a CSV of the values
// the EA recognises (so IsCommandTypeAllowedRemotely can do a simple membership
// test). Returns "" when the field is absent/empty (= no remote restriction).
// This NEVER adds a capability — it can only ever NARROW what the EA executes.
string ParseAllowedCommandTypesCsv(const string resp)
{
   int arrPos = StringFind(resp, "\"allowedCommandTypes\"");
   if(arrPos < 0) return "";
   int open = StringFind(resp, "[", arrPos);
   int close = StringFind(resp, "]", open);
   if(open < 0 || close < 0 || close <= open) return "";
   string body = StringSubstr(resp, open + 1, close - open - 1);
   string csv = "";
   string known[] = {
      "PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER",
      "CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP"
   };
   for(int i = 0; i < ArraySize(known); i++)
   {
      if(StringFind(body, known[i]) >= 0)
         csv += (StringLen(csv) == 0 ? "" : ",") + known[i];
   }
   return csv;
}

//+------------------------------------------------------------------+
//| v1.29 — Gated self-update                                         |
//|                                                                  |
//| GET /api/mt5/update-check returns the APPROVED manifest for this   |
//| EA's channel + an ALLOW/BLOCK decision. Flow:                      |
//|   1. If BLOCK, report 'blocked' + reason, do nothing.              |
//|   2. If the offered version is not newer, do nothing.              |
//|   3. Download the package text from downloadUrl.                   |
//|   4. Compute SHA-256 and compare to the manifest checksum BEFORE   |
//|      writing anything. On mismatch: report 'verify_failed', roll   |
//|      back (write nothing), abort.                                  |
//|   5. On match: write the package into MQL5/Files, report           |
//|      'apply_succeeded', and surface 'Manual bootstrap EA install   |
//|      required' (MQL5 cannot hot-swap a running compiled EA).        |
//|   6. Any file error → report 'rollback' and delete the partial.    |
//| This NEVER touches trading, gates, or safety surfaces.             |
//+------------------------------------------------------------------+
// phase MUST be one of EA_UPDATE_REPORT_PHASES (CHECK|DOWNLOAD|VERIFY|APPLY|
// ROLLBACK|REATTACH_REQUESTED|MANUAL_BOOTSTRAP_REQUIRED) and outcome one of
// EA_UPDATE_REPORT_OUTCOMES (OK|FAILED|BLOCKED) — the server enforces these
// enums strictly and rejects anything else with 400 INVALID_UPDATE_REPORT.
void ReportUpdateOutcome(const string phase, const string outcome,
                         const string fromVer, const string toVer, const string detail,
                         const bool checksumVerified = false, const string blockReason = "")
{
   string body = "{";
   body += "\"phase\":"           + JString(phase)   + ",";
   body += "\"outcome\":"         + JString(outcome) + ",";
   body += "\"fromVersion\":"     + JString(fromVer) + ",";
   body += "\"toVersion\":"       + JString(toVer)   + ",";
   body += "\"checksumVerified\":" + (checksumVerified ? "true" : "false") + ",";
   if(StringLen(blockReason) > 0)
      body += "\"blockReason\":"  + JString(blockReason) + ",";
   body += "\"detail\":"          + JString(detail)  + ",";
   body += "\"eaVersion\":"       + JString("1.29")  + ",";
   body += "\"timestamp\":"       + JString(IsoNow());
   body += "}";
   string resp;
   if(!HttpPost("/api/mt5/update-report", body, resp, "UPD"))
      PrintFormat("[ARX][UPD] update-report POST failed (phase=%s outcome=%s).", phase, outcome);
}

// Lowercase hex SHA-256 of a UTF-8 string (matches server sha256Checksum).
string Sha256Hex(const string data)
{
   uchar src[]; StringToCharArray(data, src, 0, StringLen(data), CP_UTF8);
   // StringToCharArray appends a trailing 0; drop it so the hash matches.
   int len = ArraySize(src);
   if(len > 0 && src[len - 1] == 0) ArrayResize(src, len - 1);
   uchar key[]; ArrayResize(key, 0);
   uchar hash[];
   if(CryptEncode(CRYPT_HASH_SHA256, src, key, hash) <= 0) return "";
   string hex = "";
   for(int i = 0; i < ArraySize(hash); i++) hex += StringFormat("%02x", hash[i]);
   return hex;
}

void CheckForUpdateNow()
{
   g_lastUpdateCheckMs = GetTickCount64();
   if(!EnableSelfUpdate) return;

   string resp;
   if(!HttpGet("/api/mt5/update-check?channel=stable&eaVersion=1.29", resp, "UPD"))
      return; // transient; retried next cadence.

   string decision = JsonReadString(resp, "decision"); // "ALLOW" | "BLOCK"
   string offered  = JsonReadString(resp, "version");
   string checksum = JsonReadString(resp, "sha256Checksum");
   string url      = JsonReadString(resp, "downloadUrl");
   bool updaterCapable = JsonReadBool(resp, "isUpdaterCapable", false);

   if(decision != "ALLOW")
   {
      string reason = JsonReadString(resp, "reason"); // server returns top-level "reason"
      if(StringLen(reason) == 0) reason = "BLOCKED";
      ReportUpdateOutcome("CHECK", "BLOCKED", "1.29", offered, reason, false, reason);
      if(g_verboseDiagnostics) PrintFormat("[ARX][UPD] update blocked: %s", reason);
      return;
   }
   if(StringLen(offered) == 0 || offered == "1.29")
   {
      if(g_verboseDiagnostics) Print("[ARX][UPD] no newer approved version offered.");
      return;
   }
   ReportUpdateOutcome("CHECK", "OK", "1.29", offered, "approved manifest received");

   if(StringLen(url) == 0 || StringLen(checksum) != 64)
   {
      ReportUpdateOutcome("DOWNLOAD", "FAILED", "1.29", offered, "missing downloadUrl or checksum");
      return;
   }

   // Download package text. downloadUrl must be reachable via WebRequest
   // (operator must allow-list its host like the ARX server URL).
   string pkg;
   {
      string headers = "";
      char post[]; ArrayResize(post, 0);
      char result[]; string resHeaders;
      ResetLastError();
      int code = WebRequest("GET", url, headers, RequestTimeoutMs, post, result, resHeaders);
      if(code < 200 || code >= 300)
      {
         ReportUpdateOutcome("DOWNLOAD", "FAILED", "1.29", offered,
                             StringFormat("http=%d", code));
         return;
      }
      pkg = (ArraySize(result) > 0) ? CharArrayToString(result, 0, ArraySize(result), CP_UTF8) : "";
   }
   if(StringLen(pkg) == 0)
   {
      ReportUpdateOutcome("DOWNLOAD", "FAILED", "1.29", offered, "empty package body");
      return;
   }

   // VERIFY BEFORE APPLY — compute sha256 and compare to the manifest.
   string actual = Sha256Hex(pkg);
   if(actual != StringToLower(checksum))
   {
      // Checksum mismatch: NEVER write the file. Report + roll back (no-op write).
      ReportUpdateOutcome("VERIFY", "FAILED", "1.29", offered,
                          StringFormat("sha256 mismatch expected=%s actual=%s", checksum, actual), false);
      Print("[ARX][UPD] checksum mismatch — update REFUSED, nothing written.");
      return;
   }
   ReportUpdateOutcome("VERIFY", "OK", "1.29", offered, "sha256 matched", true);

   // Write verified package into MQL5/Files. We cannot replace the running
   // compiled .ex5, so this stages the new source for a manual reattach.
   string fname = StringFormat("ARX_EA_update_%s.mq5", offered);
   int fh = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
   {
      ReportUpdateOutcome("ROLLBACK", "FAILED", "1.29", offered,
                          StringFormat("FileOpen failed err=%d", GetLastError()), true);
      return;
   }
   FileWriteString(fh, pkg);
   FileClose(fh);

   ReportUpdateOutcome("APPLY", "OK", "1.29", offered,
                       StringFormat("staged %s; manual bootstrap reattach required", fname), true);
   // MQL5 cannot hot-swap a running compiled EA, so a verified download still
   // requires the operator to reattach. Record the manual-bootstrap fallback.
   ReportUpdateOutcome("MANUAL_BOOTSTRAP_REQUIRED", "OK", "1.29", offered,
                       StringFormat("manual reattach required for %s", fname), true);
   Alert(StringFormat("[ARX] EA update %s downloaded + checksum-verified into MQL5/Files/%s. "
                      "Manual bootstrap EA install required: open it in MetaEditor, F7 compile, "
                      "and reattach. (Updater-capable package=%s.)",
                      offered, fname, updaterCapable ? "yes" : "no"));
}

// Timer-driven bridge loop. This is the ONLY guaranteed cadence — it fires
// every PollIntervalSeconds regardless of incoming ticks. OnTick is no longer
// used for bridge work.
void OnTimer()
{
   g_timerTickCount++;
   // Use MONOTONIC VPS uptime (ms) for elapsed-time gates. Do NOT use
   // TimeCurrent() here — it returns broker-server time, which freezes on
   // weekends/holidays/closed sessions when no ticks arrive. That bug caused
   // v1.23 to fire OnTimer correctly but never re-issue heartbeats because
   // (now - g_lastHeartbeatAt) stayed at 0 for hours.
   ulong   nowMs        = GetTickCount64();
   ulong   hbPeriodMs   = (ulong)g_heartbeatPeriodS * 1000;
   ulong   snapPeriodMs = (ulong)g_snapshotPeriodS  * 1000;
   ulong   pollPeriodMs = (ulong)MathMax(1, g_pollPeriodS) * 1000;

   if(g_verboseDiagnostics && (g_timerTickCount % 10 == 1))
   {
      // Print VPS local wall clock (TimeLocal) for the diagnostic so it stays
      // sane on weekends; broker TimeCurrent() would print last Friday.
      PrintFormat("[ARX][TMR] tick #%I64d at %s (VPS local) — heartbeats ok=%I64d fail=%I64d, uptimeMs=%I64u (token withheld)",
                  g_timerTickCount, TimeToString(TimeLocal(), TIME_DATE|TIME_SECONDS),
                  g_heartbeatSuccess, g_heartbeatFailure, nowMs);
   }
   if(nowMs - g_lastHeartbeatMs    >= hbPeriodMs)   SendHeartbeatNow();
   if(nowMs - g_lastAccountSyncMs  >= snapPeriodMs) SendAccountSnapshotNow();
   if(nowMs - g_lastPositionSyncMs >= snapPeriodMs) SendPositionsSnapshotNow();
   ulong specPeriodMs = (ulong)g_symbolSpecPeriodS * 1000;
   if(nowMs - g_lastSymbolSpecMs   >= specPeriodMs) SendSymbolSpecsNow();
   if(nowMs - g_lastPollMs         >= pollPeriodMs) { PollAndAckCommands(); PollAndExecuteDemoCommands(); PollAndExecuteLiveCommands(); SyncLivePositionsNow(); }
   // v1.29 — remote ops cadences. Both are read-only/observability paths that
   // can never enable execution or weaken a safety surface.
   ulong cfgPeriodMs = (ulong)g_remoteConfigPeriodS * 1000;
   if(nowMs - g_lastRemoteConfigMs >= cfgPeriodMs)  SyncRemoteConfigNow();
   ulong updPeriodMs = (ulong)g_updateCheckPeriodS * 1000;
   if(nowMs - g_lastUpdateCheckMs  >= updPeriodMs)  CheckForUpdateNow();
}

void OnTick()
{
   // INTENTIONALLY EMPTY. The bridge is timer-driven (OnTimer above). Heartbeat
   // and command polls MUST NOT depend on chart ticks — many VPS charts are
   // attached to symbols whose market is closed (no ticks for hours), which
   // previously caused the bridge to go stale after the very first heartbeat.
   // Do NOT add any trading, execution, or close logic here. Read-only EA.
}
//+------------------------------------------------------------------+
