// Synchronous CTrade result evidence only. No transaction-history aggregation,
// durable outbox or exactly-once guarantee. Shared with offline C++ harness.
#ifndef ARX_TRADE_RESULT_MQH
#define ARX_TRADE_RESULT_MQH
bool ArxPositiveResultNumber(const double n) { return MathIsValidNumber(n) && n>0; }
bool ArxDefiniteTradeRejection(const int code)
{
   // Deliberately narrow. Timeout, connection loss, generic error, locked,
   // already-closed and unknown codes remain unresolved rather than release risk.
   return code==10004 || code==10006 || code==10007 ||
      (code>=10013 && code<=10022) || code==10026 || code==10027 ||
      code==10030 || code==10032 || code==10033 || code==10034 ||
      code==10035 || code==10038 || (code>=10040 && code<=10046);
}
string ArxTradeResultOutcome(const string kind,const bool callOk,const int code,
                            const ulong deal,const ulong order,const double requested,
                            const double actualVolume,const double actualPrice)
{
   if(kind!="ENTRY" && kind!="CLOSE" && kind!="MODIFY") return "LIVE_UNKNOWN";
   if(ArxDefiniteTradeRejection(code))
      return (deal==0 && actualVolume==0)?"LIVE_REJECTED":"LIVE_UNKNOWN";
   if(!callOk) return "LIVE_UNKNOWN";
   if(code==10008) return deal==0?"LIVE_ACKNOWLEDGED":"LIVE_UNKNOWN";
   // MODIFY has no deal/fill. The old internal completed-command enum remains
   // LIVE_FILLED, but the wire kind plus null fill/volume distinguishes it.
   if(kind=="MODIFY") return (code==10009 && deal==0 && actualVolume==0)?"LIVE_FILLED":"LIVE_UNKNOWN";
   if((code!=10009 && code!=10010) || deal==0 || (kind=="ENTRY" && order==0) ||
      !ArxPositiveResultNumber(requested) || !ArxPositiveResultNumber(actualVolume) ||
      !ArxPositiveResultNumber(actualPrice) || actualVolume>requested) return "LIVE_UNKNOWN";
   if(code==10010 || actualVolume<requested) return "LIVE_PARTIALLY_FILLED";
   return "LIVE_FILLED";
}
string ArxResultNumber(const double n)
{
   return MathIsValidNumber(n)?StringFormat("%.17g",n):"null";
}
string ArxTradeResultFields(const string kind,const bool callOk,const int code,
                           const ulong deal,const ulong order,const double requested,
                           const double actualVolume,const double actualPrice)
{
   string outcome=ArxTradeResultOutcome(kind,callOk,code,deal,order,requested,actualVolume,actualPrice);
   bool filled=(kind!="MODIFY" && (outcome=="LIVE_FILLED" || outcome=="LIVE_PARTIALLY_FILLED"));
   return StringFormat("\"resultEvidenceVersion\":1,\"resultKind\":\"%s\",\"tradeCallSucceeded\":%s,\"resultDeal\":\"%I64u\",\"resultOrder\":\"%I64u\",\"resultVolume\":%s,\"resultPrice\":%s,\"requestedVolume\":%s,\"executedVolume\":%s,\"fillPrice\":%s,\"mt5Retcode\":%d",
      kind,callOk?"true":"false",deal,order,ArxResultNumber(actualVolume),ArxResultNumber(actualPrice),ArxResultNumber(requested),
      filled?ArxResultNumber(actualVolume):"null",filled?ArxResultNumber(actualPrice):"null",code);
}
#endif
