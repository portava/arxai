// v1.35: DEMO execution-cost receipt and broker-bound tick feed (wire only).
//
// Pure formatting: no terminal, file or network call happens here. The EA
// gathers the facts (deal history, the submission tick, the account) and this
// file turns them into the two wires the server already validates:
//   * the demo-command-result `raw` object with `atiExecutionCostV1`
//     (atiCostEvidence.ts: atiCostReceiptFromResult), and
//   * a bridge v2 TICK envelope that carries the terminal's own account claim
//     (bridgeV2/ingest.ts: verifiedAtiAccount, recordMt5Tick).
// Shared with the offline C++ harness (tests/cost_receipt_test.cpp).
#ifndef ARX_DEMO_COST_RECEIPT_MQH
#define ARX_DEMO_COST_RECEIPT_MQH

struct ArxDemoCostFacts
{
   bool   ready;          // all facts below were read from the broker
   string leg;            // ENTRY | EXIT
   uint   retcode;        // 10009 DONE | 10010 DONE_PARTIAL
   ulong  order;
   ulong  deal;
   string symbol;         // broker symbol the command traded
   string side;           // BUY | SELL: the deal's own direction
   double volume;         // the deal's volume (equals the CTrade result)
   double price;          // the deal's price (equals the CTrade result)
   ulong  positionTicket; // EXIT: the closed position; ENTRY: resolved position
   ulong  positionId;     // DEAL_POSITION_ID
   long   filledAtMs;     // DEAL_TIME_MSC, broker server clock
   bool   hasQuote;       // submission tick read just before the send
   double bid;
   double ask;
   long   quoteTickMs;    // MqlTick.time_msc, same broker server clock
   string currency;       // account currency of the charges
   double commission;
   double fee;
   double swap;
   double tickSize;
   double tickValueProfit;
   double tickValueLoss;
   long   login;
   string server;
};

void ArxDemoCostReset(ArxDemoCostFacts &f)
{
   f.ready = false; f.leg = ""; f.retcode = 0; f.order = 0; f.deal = 0;
   f.symbol = ""; f.side = ""; f.volume = 0; f.price = 0;
   f.positionTicket = 0; f.positionId = 0; f.filledAtMs = 0;
   f.hasQuote = false; f.bid = 0; f.ask = 0; f.quoteTickMs = 0;
   f.currency = ""; f.commission = 0; f.fee = 0; f.swap = 0;
   f.tickSize = 0; f.tickValueProfit = 0; f.tickValueLoss = 0;
   f.login = 0; f.server = "";
}

// Round-trip number text: the server compares receipt and result values exactly.
string ArxCostNum(const double n)
{
   if(!MathIsValidNumber(n)) return "null";
   return StringFormat("%.17g", n);
}

string ArxCostTicket(const ulong t) { return IntegerToString((long)t); }

// Text is copied into JSON unescaped, so anything that would need escaping
// (quote, backslash, control character) refuses the whole receipt instead.
bool ArxCostTextOk(const string s, const int maxLen)
{
   int n = StringLen(s);
   if(n < 1 || n > maxLen) return false;
   for(int i = 0; i < n; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c < 32 || c == 127 || c == '"' || c == '\\') return false;
   }
   return true;
}

bool ArxCostCurrencyOk(const string s)
{
   if(StringLen(s) != 3) return false;
   for(int i = 0; i < 3; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c < 'A' || c > 'Z') return false;
   }
   return true;
}

bool ArxCostPositive(const double n) { return MathIsValidNumber(n) && n > 0; }

bool ArxDemoCostFactsValid(const ArxDemoCostFacts &f)
{
   if(!f.ready) return false;
   if(f.leg != "ENTRY" && f.leg != "EXIT") return false;
   if(f.retcode != 10009 && f.retcode != 10010) return false;
   if(f.order == 0 || f.deal == 0 || f.login <= 0 || f.filledAtMs <= 0) return false;
   if(f.side != "BUY" && f.side != "SELL") return false;
   if(!ArxCostPositive(f.volume) || !ArxCostPositive(f.price)) return false;
   if(f.leg == "EXIT" && (f.positionTicket == 0 || f.positionId == 0)) return false;
   return ArxCostTextOk(f.symbol, 128) && ArxCostTextOk(f.server, 128);
}

// The demo-command-result `raw` object. Without a complete broker deal it is
// the legacy {"retcode":N}, so the server records the fill with no cost claim.
string ArxDemoResultRaw(const ArxDemoCostFacts &f, const uint retcode)
{
   string base = "{\"retcode\":" + IntegerToString((long)retcode);
   if(!ArxDemoCostFactsValid(f) || f.retcode != retcode) return base + "}";
   string order = ArxCostTicket(f.order), deal = ArxCostTicket(f.deal);
   string volume = ArxCostNum(f.volume), price = ArxCostNum(f.price);
   string raw = base;
   raw += ",\"resultEvidenceVersion\":1";
   string kind = "ENTRY";
   if(f.leg == "EXIT") kind = "CLOSE";
   raw += ",\"resultKind\":\"" + kind + "\"";
   raw += ",\"tradeCallSucceeded\":true";
   raw += ",\"mt5Retcode\":" + IntegerToString((long)f.retcode);
   raw += ",\"resultOrder\":\"" + order + "\",\"resultDeal\":\"" + deal + "\"";
   raw += ",\"resultVolume\":" + volume + ",\"resultPrice\":" + price;
   if(f.leg == "EXIT") raw += ",\"positionTicket\":\"" + ArxCostTicket(f.positionTicket) + "\"";

   string c = "{\"version\":1,\"mode\":\"DEMO\"";
   c += ",\"accountLogin\":\"" + IntegerToString(f.login) + "\"";
   c += ",\"serverName\":\"" + f.server + "\"";
   c += ",\"order\":\"" + order + "\",\"deal\":\"" + deal + "\"";
   c += ",\"symbol\":\"" + f.symbol + "\",\"side\":\"" + f.side + "\"";
   c += ",\"volume\":" + volume + ",\"price\":" + price;
   c += ",\"leg\":\"" + f.leg + "\"";
   if(f.positionTicket > 0) c += ",\"positionTicket\":\"" + ArxCostTicket(f.positionTicket) + "\"";
   if(f.positionId > 0) c += ",\"positionId\":\"" + ArxCostTicket(f.positionId) + "\"";
   c += ",\"brokerFilledAtMs\":" + IntegerToString(f.filledAtMs);
   // The server judges the quote's age against the fill; it is sent as read.
   if(f.hasQuote && ArxCostPositive(f.bid) && ArxCostPositive(f.ask) && f.ask >= f.bid && f.quoteTickMs > 0)
      c += ",\"submissionQuote\":{\"bid\":" + ArxCostNum(f.bid) + ",\"ask\":" + ArxCostNum(f.ask) +
           ",\"brokerTickAtMs\":" + IntegerToString(f.quoteTickMs) + "}";
   else
      c += ",\"submissionQuote\":null";
   string currency = "null";
   if(ArxCostCurrencyOk(f.currency)) currency = "\"" + f.currency + "\"";
   c += ",\"currency\":" + currency;
   c += ",\"commission\":" + ArxCostNum(f.commission);
   c += ",\"fee\":" + ArxCostNum(f.fee);
   c += ",\"swap\":" + ArxCostNum(f.swap);
   if(ArxCostPositive(f.tickSize) && ArxCostPositive(f.tickValueProfit) && ArxCostPositive(f.tickValueLoss))
      c += ",\"tickValuation\":{\"tickSize\":" + ArxCostNum(f.tickSize) +
           ",\"profitTickValue\":" + ArxCostNum(f.tickValueProfit) +
           ",\"lossTickValue\":" + ArxCostNum(f.tickValueLoss) + "}";
   c += "}";
   return raw + ",\"atiExecutionCostV1\":" + c + "}";
}

// One bridge v2 TICK envelope that claims the terminal's DEMO account. The
// server binds the quote only when this claim matches the account registered
// to the authenticated bridge. Returns "" when anything is unusable.
string ArxBoundTickEnvelope(const long sequence, const string idempotencyKey,
                            const long eaCreatedAtMs, const string eaVersion,
                            const long login, const string server,
                            const string symbol, const double bid, const double ask,
                            const long tickTimeMs)
{
   if(sequence < 0 || eaCreatedAtMs <= 0 || tickTimeMs <= 0 || login <= 0) return "";
   if(!ArxCostPositive(bid) || !ArxCostPositive(ask) || ask < bid) return "";
   if(!ArxCostTextOk(symbol, 32) || !ArxCostTextOk(server, 128) || !ArxCostTextOk(eaVersion, 32)) return "";
   int keyLen = StringLen(idempotencyKey);
   if(keyLen < 8 || keyLen > 128 || !ArxCostTextOk(idempotencyKey, 128)) return "";
   string p = "{\"atiAccount\":{\"login\":\"" + IntegerToString(login) + "\",\"server\":\"" + server +
              "\",\"mode\":\"DEMO\"}";
   p += ",\"brokerSymbol\":\"" + symbol + "\",\"symbol\":\"" + symbol + "\"";
   p += ",\"bid\":" + ArxCostNum(bid) + ",\"ask\":" + ArxCostNum(ask);
   p += ",\"brokerTimeEpochMs\":" + IntegerToString(tickTimeMs) + "}";
   string e = "{\"protocolVersion\":2,\"messageType\":\"TICK\"";
   e += ",\"streamKey\":\"" + symbol + "\"";
   e += ",\"sequence\":" + IntegerToString(sequence);
   e += ",\"idempotencyKey\":\"" + idempotencyKey + "\"";
   e += ",\"eaCreatedAtEpochMs\":" + IntegerToString(eaCreatedAtMs);
   e += ",\"eaVersion\":\"" + eaVersion + "\"";
   e += ",\"payload\":" + p + "}";
   return e;
}
#endif
