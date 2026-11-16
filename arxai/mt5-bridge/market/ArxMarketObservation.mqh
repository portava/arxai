#ifndef ARX_MARKET_OBSERVATION_MQH
#define ARX_MARKET_OBSERVATION_MQH
#include "ArxMarketUniverse.mqh"
#include "ArxHistoryBoundary.mqh"
// Pure read-only observation. No network, broker orders, account balances,
// positions, or command polling. Existing immutable EA safety inputs are used.
ulong arxMarketLastQuote=0, arxMarketLastInventory=0, arxMarketLastHistory=0;
string arxMarketInstance="";
long arxMarketSequence=0;
string ArxMarketQ(string s) {
   string out="\"";
   for(int i=0;i<StringLen(s);i++) {
      ushort c=StringGetCharacter(s,i);
      if(c==34) out+="\\\""; else if(c==92) out+="\\\\";
      else if(c<32) out+=StringFormat("\\u%04X",c); else out+=StringSubstr(s,i,1);
   }
   return out+"\"";
}
string ArxMarketN(double v,int digits=8) {
   return MathIsValidNumber(v) ? DoubleToString(v,digits) : "null";
}
bool ArxMarketSafe() {
   return ReadOnlyMode && !AllowOrderExecution && !AllowPendingOrders && !AllowProtectionModify && !AllowPositionClose &&
      !AllowPendingCancel && !AllowPendingModify && !AllowEmergencyClose &&
      !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && !MQLInfoInteger(MQL_TESTER) &&
      AccountInfoInteger(ACCOUNT_LOGIN)==62249354 && AccountInfoString(ACCOUNT_SERVER)=="DerivSVG-Server";
}
string ArxMarketHeader() {
   if(arxMarketInstance=="") arxMarketInstance=(string)(long)TimeGMT()+"-"+(string)GetTickCount64()+"-"+(string)ChartID();
   return "{\"version\":1,\"account\":"+ArxMarketQ((string)AccountInfoInteger(ACCOUNT_LOGIN))+",\"server\":"+ArxMarketQ(AccountInfoString(ACCOUNT_SERVER))+
      ",\"instanceId\":"+ArxMarketQ(arxMarketInstance)+",\"sequence\":"+(string)(++arxMarketSequence)+
      ",\"observedAtUtc\":"+(string)(long)TimeGMT()+",\"serverNow\":"+(string)(long)TimeTradeServer()+",\"lastQuoteServer\":"+(string)(long)TimeCurrent()+
      ",\"terminalConnected\":"+(TerminalInfoInteger(TERMINAL_CONNECTED)?"true":"false")+
      ",\"readOnly\":"+(ArxMarketSafe()?"true":"false")+",\"algoTradingAllowed\":"+(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)?"true":"false")+
      ",\"tester\":"+(MQLInfoInteger(MQL_TESTER)?"true":"false");
}
bool ArxMarketWrite(const string name,const string body) {
   FolderCreate("ARX_ReadOnly_MarketData");
   string target="ARX_ReadOnly_MarketData\\"+name, temporary=target+".tmp";
   int file=FileOpen(temporary,FILE_WRITE|FILE_BIN); if(file==INVALID_HANDLE) return false;
   char bytes[]; int n=StringToCharArray(body,bytes,0,WHOLE_ARRAY,CP_UTF8);
   FileWriteArray(file,bytes,0,n-1);FileFlush(file);FileClose(file);
   return FileMove(temporary,0,target,FILE_REWRITE);
}
// Exact existing registry names only. Never substitute US Dollar Basket for DXY.
string ArxMarketResolve(int index) {
   string aliases[];int n=StringSplit(arxMarketAliases[index],'|',aliases);
   for(int a=0;a<n;a++) {bool custom=false; if(SymbolExist(aliases[a],custom) && !custom) return aliases[a];}
   return "";
}
string ArxMarketSpec(const string name) {
   long chartMode=SymbolInfoInteger(name,SYMBOL_CHART_MODE);
   string basis=chartMode==SYMBOL_CHART_MODE_BID ? "bid" : (chartMode==SYMBOL_CHART_MODE_LAST ? "last" : "unknown");
   return "\"brokerSymbol\":"+ArxMarketQ(name)+",\"description\":"+ArxMarketQ(SymbolInfoString(name,SYMBOL_DESCRIPTION))+
      ",\"path\":"+ArxMarketQ(SymbolInfoString(name,SYMBOL_PATH))+",\"baseCurrency\":"+ArxMarketQ(SymbolInfoString(name,SYMBOL_CURRENCY_BASE))+
      ",\"profitCurrency\":"+ArxMarketQ(SymbolInfoString(name,SYMBOL_CURRENCY_PROFIT))+",\"digits\":"+(string)SymbolInfoInteger(name,SYMBOL_DIGITS)+
      ",\"point\":"+ArxMarketN(SymbolInfoDouble(name,SYMBOL_POINT))+",\"tickSize\":"+ArxMarketN(SymbolInfoDouble(name,SYMBOL_TRADE_TICK_SIZE))+
      ",\"tradeMode\":"+(string)SymbolInfoInteger(name,SYMBOL_TRADE_MODE)+",\"chartPriceBasis\":"+ArxMarketQ(basis)+
      ",\"contractSize\":"+ArxMarketN(SymbolInfoDouble(name,SYMBOL_TRADE_CONTRACT_SIZE))+",\"volumeMin\":"+ArxMarketN(SymbolInfoDouble(name,SYMBOL_VOLUME_MIN))+
      ",\"volumeMax\":"+ArxMarketN(SymbolInfoDouble(name,SYMBOL_VOLUME_MAX))+",\"volumeStep\":"+ArxMarketN(SymbolInfoDouble(name,SYMBOL_VOLUME_STEP));
}
void ArxMarketInventory() {
   int total=SymbolsTotal(false), cap=2000;string rows="";
   for(int i=0;i<total && i<cap;i++) {
      string name=SymbolName(i,false);if(rows!="")rows+=",";
      rows+="{"+ArxMarketSpec(name)+"}";
   }
   ArxMarketWrite("inventory.json",ArxMarketHeader()+",\"symbolsTotal\":"+(string)total+",\"complete\":"+(total<=cap?"true":"false")+",\"symbols\":["+rows+"]}");
}
void ArxMarketQuotes() {
   string rows="";
   for(int i=0;i<ArraySize(arxMarketCanonicals);i++) {
      if(rows!="")rows+=",";string canonical=arxMarketCanonicals[i], name=ArxMarketResolve(i);
      rows+="{\"canonical\":"+ArxMarketQ(canonical)+",\"available\":"+(name!=""?"true":"false");
      if(name!="") {
         bool selected=SymbolSelect(name,true);MqlTick tick={};ResetLastError();bool got=selected && SymbolInfoTick(name,tick);int error=GetLastError();
         int digits=(int)SymbolInfoInteger(name,SYMBOL_DIGITS);
         rows+=","+ArxMarketSpec(name)+",\"selected\":"+(selected?"true":"false")+",\"synchronized\":"+(SymbolIsSynchronized(name)?"true":"false")+
            ",\"tickAvailable\":"+(got?"true":"false")+",\"tickError\":"+(string)error+",\"tickTimeServerMs\":"+(string)tick.time_msc+
            ",\"tickTimeServerSeconds\":"+(string)(long)tick.time+",\"bid\":"+ArxMarketN(tick.bid,digits)+",\"ask\":"+ArxMarketN(tick.ask,digits)+
            ",\"last\":"+ArxMarketN(tick.last,digits)+",\"flags\":"+(string)tick.flags;
      }
      rows+="}";
   }
   ArxMarketWrite("quotes.json",ArxMarketHeader()+",\"quotes\":["+rows+"]}");
}
int arxMarketHistoryCursor=0;
ulong arxMarketFullHistoryAt[], arxMarketLastFastM1=0, arxMarketLastFastSlow=0;
#include "ArxNativeSeamObservation.mqh"
datetime ArxHistoryClose(datetime opened,ENUM_TIMEFRAMES tf) {
   if(tf!=PERIOD_MN1)return opened+PeriodSeconds(tf);
   MqlDateTime d;TimeToStruct(opened,d);d.day=1;d.hour=0;d.min=0;d.sec=0;
   d.mon++;if(d.mon>12){d.mon=1;d.year++;}return StructToTime(d);
}
string ArxMarketSeries(int index,ENUM_TIMEFRAMES tf,int wanted,bool &complete,datetime endBefore=0) {
   string name=ArxMarketResolve(index);complete=false;if(name=="")return "";
   SymbolSelect(name,true);MqlRates bars[];ResetLastError();
   int count=endBefore>0 ? CopyRates(name,tf,endBefore,wanted,bars) : CopyRates(name,tf,1,wanted,bars);
   int error=GetLastError();
   long serverFirst=SeriesInfoInteger(name,tf,SERIES_SERVER_FIRSTDATE);
   bool boundary=count>0 && serverFirst>0 && bars[0].time<=serverFirst && ArxHistoryClose(bars[0].time,tf)>serverFirst;
   string boundaryRange="";
   if(error==0 && count>0 && count<wanted && !boundary && serverFirst>0 &&
      bars[0].time>serverFirst && (long)bars[0].time/86400==serverFirst/86400) {
      // This bounded DATE-RANGE query also requests any missing prefix. A cold
      // indicator read returns an error; it must retry, never declare EOF.
      MqlRates firstRange[];long through=(long)ArxHistoryClose(bars[0].time,tf)-1;
      ResetLastError();int rangeCount=CopyRates(name,tf,(datetime)serverFirst,(datetime)through,firstRange);
      int rangeError=GetLastError();
      bool synchronized=SeriesInfoInteger(name,tf,SERIES_SYNCHRONIZED)!=0;
      long localFirst=SeriesInfoInteger(name,tf,SERIES_FIRSTDATE);
      long rangeFirst=rangeCount>0?(long)firstRange[0].time:0;
      boundary=ArxHistoryFirstDayRangeValid(serverFirst,(long)bars[0].time,through+1,
         serverFirst,through,rangeFirst,localFirst,rangeCount,rangeError,synchronized);
      if(boundary)boundaryRange=",\"firstDayRange\":{\"fromServer\":"+(string)serverFirst+
         ",\"throughServer\":"+(string)through+",\"firstOpenServer\":"+(string)rangeFirst+
         ",\"localFirstServer\":"+(string)localFirst+",\"copyCount\":"+(string)rangeCount+
         ",\"error\":"+(string)rangeError+",\"synchronized\":true}";
   }
   complete=error==0 && (count==wanted || boundary);
   int digits=(int)SymbolInfoInteger(name,SYMBOL_DIGITS);string values="";
   // Large native pages should not repeatedly grow the JSON string buffer.
   // Reserving capacity changes neither the native values nor page size.
   if(count>0)StringReserve(values,(uint)count*256);
   for(int b=0;b<count;b++) {
      if(values!="")values+=",";
      values+="{\"openTimeServer\":"+(string)(long)bars[b].time+",\"open\":"+ArxMarketN(bars[b].open,digits)+
         ",\"high\":"+ArxMarketN(bars[b].high,digits)+",\"low\":"+ArxMarketN(bars[b].low,digits)+",\"close\":"+ArxMarketN(bars[b].close,digits)+
         ",\"tickVolume\":"+(string)bars[b].tick_volume+",\"spreadPoints\":"+(string)bars[b].spread+"}";
   }
   string timeframe=StringSubstr(EnumToString(tf),7);
   string history=wanted>2 ? ",\"requestedHistoryBars\":"+(string)wanted+",\"historyKind\":"+ArxMarketQ(endBefore>0?"backfill":"seed")+
      ",\"requestedEndServer\":"+(string)(long)endBefore+",\"serverFirstHistoryServer\":"+(string)serverFirst+
      ",\"brokerHistoryBoundaryReached\":"+(boundary?"true":"false")+",\"historyDepthPartial\":"+(count<wanted?"true":"false")+boundaryRange : "";
   string seam=wanted==2 ? ",\"nativeSeam\":"+ArxNativeSeamObservation(index,tf) : "";
   return "{\"canonical\":"+ArxMarketQ(arxMarketCanonicals[index])+","+ArxMarketSpec(name)+",\"timeframe\":"+ArxMarketQ(timeframe)+
      ",\"copyCount\":"+(string)count+",\"error\":"+(string)error+",\"closedOnly\":true,\"bars\":["+values+"]"+seam+history+"}";
}
void ArxMarketFastClosed(bool minuteOnly) {
   string groups="";
   for(int i=0;i<ArraySize(arxMarketCanonicals);i++) {
      for(int t=0;t<(minuteOnly?1:2);t++) {
         ENUM_TIMEFRAMES tf=minuteOnly?PERIOD_M1:(t==0?PERIOD_M5:PERIOD_H1);
         bool complete=false;string group=ArxMarketSeries(i,tf,2,complete);
         if(group!="") {if(groups!="")groups+=",";groups+=group;}
      }
   }
   ArxMarketWrite(minuteOnly?"fast-m1.json":"fast-slow.json",ArxMarketHeader()+",\"series\":["+groups+"]}");
}
void ArxMarketHistory() {
   if(ArraySize(arxMarketFullHistoryAt)!=ArraySize(arxMarketCanonicals)) {ArrayResize(arxMarketFullHistoryAt,ArraySize(arxMarketCanonicals));ArrayInitialize(arxMarketFullHistoryAt,0);}
   int i=arxMarketHistoryOrder[arxMarketHistoryCursor];
   arxMarketHistoryCursor=(arxMarketHistoryCursor+1)%ArraySize(arxMarketHistoryOrder);
   ulong now=GetTickCount64();
   // Full history is initialization/resynchronization work, not the live lane.
   if(arxMarketFullHistoryAt[i]>0 && now-arxMarketFullHistoryAt[i]<60000)return;
   string groups="";bool allComplete=true;
   for(int t=0;t<3;t++) {
      ENUM_TIMEFRAMES tf=t==0?PERIOD_M1:(t==1?PERIOD_M5:PERIOD_H1);
      bool complete=false;string group=ArxMarketSeries(i,tf,200,complete);allComplete=allComplete && complete;
      if(group!="") {if(groups!="")groups+=",";groups+=group;}
   }
   if(ArxMarketWrite("history-"+arxMarketCanonicals[i]+".json",ArxMarketHeader()+",\"series\":["+groups+"]}") && allComplete)arxMarketFullHistoryAt[i]=now;
}
void ArxObserveMarketData() {
   ulong now=GetTickCount64();
   if(!ArxMarketSafe()) {ArxMarketWrite("quotes.json",ArxMarketHeader()+",\"quotes\":[],\"error\":\"READ_ONLY_GUARD_FAILED\"}");return;}
   if(now-arxMarketLastQuote>=2000) {arxMarketLastQuote=now;ArxMarketQuotes();}
   if(now-arxMarketLastFastM1>=2000 || arxMarketLastFastM1==0) {arxMarketLastFastM1=now;ArxMarketFastClosed(true);}
   if(now-arxMarketLastFastSlow>=2000 || arxMarketLastFastSlow==0) {arxMarketLastFastSlow=now;ArxMarketFastClosed(false);}
   if(now-arxMarketLastInventory>=60000 || arxMarketLastInventory==0) {arxMarketLastInventory=now;ArxMarketInventory();}
   if(now-arxMarketLastHistory>=1000 || arxMarketLastHistory==0) {arxMarketLastHistory=now;ArxMarketHistory();}
}
#endif
