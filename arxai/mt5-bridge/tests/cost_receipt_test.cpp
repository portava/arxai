// Offline checks for ArxDemoCostReceipt.mqh (EA v1.35). No terminal, broker or
// network. Prints the three canonical wires on stdout; run_cost_receipt.py
// compares them with tests/fixtures/ati_demo_cost_wire.json, which the server
// test (atiDemoCostWire.test.ts) feeds through the real server validators.
#include <cmath>
#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>
using string = std::string;
using ushort = unsigned short;
using uint = unsigned int;
using ulong = unsigned long;
int StringLen(const string &s) { return (int)s.size(); }
ushort StringGetCharacter(const string &s, int i) { return (unsigned char)s.at(i); }
string IntegerToString(long n) { return std::to_string(n); }
bool MathIsValidNumber(double n) { return std::isfinite(n); }
string StringFormat(const char *format, double n) { char b[64]; std::snprintf(b, sizeof b, format, n); return b; }
#include "ArxDemoCostReceipt.mqh"

int checks = 0;
void check(bool ok, const string &name) { ++checks; if(!ok) throw std::runtime_error("FAILED: " + name); }

ArxDemoCostFacts entry()
{
   ArxDemoCostFacts f; ArxDemoCostReset(f);
   f.ready = true; f.leg = "ENTRY"; f.retcode = 10009; f.order = 4798698209; f.deal = 4767566447;
   f.symbol = "Volatility 75 Index"; f.side = "BUY"; f.volume = 0.01; f.price = 45656.93;
   f.positionTicket = 4798698209; f.positionId = 4798698209; f.filledAtMs = 1795612865120;
   f.hasQuote = true; f.bid = 45641.15; f.ask = 45656.93; f.quoteTickMs = 1795612864702;
   f.currency = "USD"; f.commission = 0; f.fee = 0; f.swap = 0;
   f.tickSize = 0.01; f.tickValueProfit = 0.01; f.tickValueLoss = 0.01;
   f.login = 41339260; f.server = "Deriv-Demo";
   return f;
}
ArxDemoCostFacts exitLeg()
{
   ArxDemoCostFacts f = entry();
   f.leg = "EXIT"; f.order = 4798698530; f.deal = 4767566768; f.side = "SELL"; f.price = 45627.00;
   f.filledAtMs = 1795612883004; f.bid = 45627.00; f.ask = 45642.78; f.quoteTickMs = 1795612882611;
   return f;
}

int main()
{
   const string legacy = "{\"retcode\":10009}";
   string entryRaw = ArxDemoResultRaw(entry(), 10009);
   string exitRaw = ArxDemoResultRaw(exitLeg(), 10009);
   string tick = ArxBoundTickEnvelope(7, "v135-1795612800-123456-8", 1795612864000, "1.35",
                                      41339260, "Deriv-Demo", "Volatility 75 Index", 45641.15, 45656.93, 1795612863702);
   check(entryRaw.find("\"atiExecutionCostV1\":") != string::npos, "entry carries a receipt");
   check(exitRaw.find("\"resultKind\":\"CLOSE\"") != string::npos && exitRaw.find("\"leg\":\"EXIT\"") != string::npos, "close is an EXIT leg");
   check(!tick.empty(), "tick envelope builds");

   // Anything short of a complete broker deal reports the fill with no claim.
   ArxDemoCostFacts f = entry(); f.ready = false;
   check(ArxDemoResultRaw(f, 10009) == legacy, "unread deal: legacy raw");
   f = entry(); check(ArxDemoResultRaw(f, 10010) == "{\"retcode\":10010}", "retcode disagreement: legacy raw");
   f = entry(); f.deal = 0; check(ArxDemoResultRaw(f, 10009) == legacy, "no deal: legacy raw");
   f = entry(); f.order = 0; check(ArxDemoResultRaw(f, 10009) == legacy, "no order: legacy raw");
   f = entry(); f.side = "buy"; check(ArxDemoResultRaw(f, 10009) == legacy, "lower-case side refused");
   f = entry(); f.price = NAN; check(ArxDemoResultRaw(f, 10009) == legacy, "NaN price refused");
   f = entry(); f.volume = 0; check(ArxDemoResultRaw(f, 10009) == legacy, "zero volume refused");
   f = entry(); f.retcode = 10008; check(ArxDemoResultRaw(f, 10008) == "{\"retcode\":10008}", "placed-only retcode refused");
   f = entry(); f.login = 0; check(ArxDemoResultRaw(f, 10009) == legacy, "no account login refused");
   f = entry(); f.symbol = "V75\"x"; check(ArxDemoResultRaw(f, 10009) == legacy, "quote in symbol refused, never escaped");
   f = entry(); f.server = "Deriv\\Demo"; check(ArxDemoResultRaw(f, 10009) == legacy, "backslash in server refused");
   f = entry(); f.server = ""; check(ArxDemoResultRaw(f, 10009) == legacy, "empty server refused");
   f = exitLeg(); f.positionTicket = 0; check(ArxDemoResultRaw(f, 10009) == legacy, "exit needs its position ticket");
   f = exitLeg(); f.positionId = 0; check(ArxDemoResultRaw(f, 10009) == legacy, "exit needs its position id");
   // Optional evidence degrades to null rather than refusing the receipt.
   f = entry(); f.hasQuote = false;
   check(ArxDemoResultRaw(f, 10009).find("\"submissionQuote\":null") != string::npos, "missing tick: null quote");
   f = entry(); f.ask = f.bid - 1;
   check(ArxDemoResultRaw(f, 10009).find("\"submissionQuote\":null") != string::npos, "crossed tick: null quote");
   f = entry(); f.currency = "usd";
   check(ArxDemoResultRaw(f, 10009).find("\"currency\":null") != string::npos, "malformed currency: null");
   f = entry(); f.commission = NAN;
   check(ArxDemoResultRaw(f, 10009).find("\"commission\":null") != string::npos, "unknown commission: null");
   f = entry(); f.tickValueLoss = 0;
   check(ArxDemoResultRaw(f, 10009).find("tickValuation") == string::npos, "partial tick valuation omitted");
   // Tick envelope refusals.
   check(ArxBoundTickEnvelope(-1, "abcdefgh", 1, "1.35", 1, "S", "X", 1, 2, 1).empty(), "negative sequence refused");
   check(ArxBoundTickEnvelope(0, "short", 1, "1.35", 1, "S", "X", 1, 2, 1).empty(), "short idempotency key refused");
   check(ArxBoundTickEnvelope(0, "abcdefgh", 1, "1.35", 1, "S", "X", 2, 1, 1).empty(), "crossed tick refused");
   check(ArxBoundTickEnvelope(0, "abcdefgh", 1, "1.35", 0, "S", "X", 1, 2, 1).empty(), "no login refused");
   check(ArxBoundTickEnvelope(0, "abcdefgh", 0, "1.35", 1, "S", "X", 1, 2, 1).empty(), "no EA clock refused");
   check(ArxBoundTickEnvelope(0, "abcdefgh", 1, "1.35", 1, "S", "X", 1, 2, 0).empty(), "no tick time refused");
   check(ArxBoundTickEnvelope(0, "abcdefgh", 1, "1.35", 1, "S", string(33, 'X'), 1, 2, 1).empty(), "symbol over 32 refused");
   check(ArxBoundTickEnvelope(0, "abcdefgh", 1, "1.35", 1, "S", "X\"", 1, 2, 1).empty(), "quote in symbol refused");

   std::cout << entryRaw << "\n" << exitRaw << "\n" << tick << "\n";
   std::cerr << checks << " cost-receipt checks passed; no terminal, broker or network calls.\n";
   return 0;
}
