#property strict
#property version "1.00"
#property indicator_chart_window
#property indicator_buffers 1
#property indicator_plots 0
// Independent indicator thread: CopyRates starts asynchronous history builds
// instead of blocking the existing EA quote/M1 timer on cold downloads.
const bool ReadOnlyMode=true,AllowOrderExecution=false,AllowPendingOrders=false,AllowProtectionModify=false,
   AllowPositionClose=false,AllowPendingCancel=false,AllowPendingModify=false,AllowEmergencyClose=false;
#include "ArxMarketObservation.mqh"
ENUM_TIMEFRAMES arxExtraTimeframes[]={PERIOD_M1,PERIOD_M5,PERIOD_H1,PERIOD_M15,PERIOD_M30,PERIOD_H4,PERIOD_D1,PERIOD_H2,PERIOD_H3,PERIOD_H6,PERIOD_H8,PERIOD_H12,PERIOD_W1,PERIOD_MN1,PERIOD_M2,PERIOD_M3,PERIOD_M4,PERIOD_M6,PERIOD_M10,PERIOD_M12,PERIOD_M20};
int extraFullCursor=0,extraFastCursor=1;
ulong extraFullAt[],extraLastObserve=0;
double extraPulse[];
int OnInit() {
   if(!ArxMarketSafe())return INIT_FAILED;
   ArrayResize(extraFullAt,ArraySize(arxMarketCanonicals)*ArraySize(arxExtraTimeframes));ArrayInitialize(extraFullAt,0);
   IndicatorSetString(INDICATOR_SHORTNAME,"ARX ReadOnly Full History");
   SetIndexBuffer(0,extraPulse,INDICATOR_DATA);
   EventSetTimer(1);return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) {EventKillTimer();}
int OnCalculate(const int rates_total,const int prev_calculated,const int begin,const double &price[]) {
   // The dedicated always-open chart drives this read-only indicator without
   // any EA CopyBuffer wait. Both ticks and timer share the bounded throttle.
   ArxExtraObserve();if(rates_total>0)extraPulse[rates_total-1]=1.0;return rates_total;
}
void ExtraFastSnapshot(int timeframeIndex) {
   ENUM_TIMEFRAMES tf=arxExtraTimeframes[timeframeIndex];string groups="";
   for(int i=0;i<ArraySize(arxMarketCanonicals);i++) {
      bool complete=false;string group=ArxMarketSeries(i,tf,2,complete);
      if(group!="") {if(groups!="")groups+=",";groups+=group;}
   }
   ArxMarketWrite("fast-extra-"+StringSubstr(EnumToString(tf),7)+".json",ArxMarketHeader()+",\"producer\":\"read_only_history_indicator\",\"series\":["+groups+"]}");
}
void ExtraFullSnapshot() {
   int slot=extraFullCursor;extraFullCursor=(extraFullCursor+1)%ArraySize(extraFullAt);
   ulong now=GetTickCount64();if(extraFullAt[slot]>0 && now-extraFullAt[slot]<60000)return;
   int timeframeIndex=slot/ArraySize(arxMarketCanonicals), index=arxMarketHistoryOrder[slot%ArraySize(arxMarketCanonicals)];
   ENUM_TIMEFRAMES tf=arxExtraTimeframes[timeframeIndex];string name=ArxMarketResolve(index);if(name=="")return;
   // Always request the full target first; local Bars() may only reflect an
   // incomplete cache, not the broker history limit. Indicator CopyRates is async.
   MqlRates probe[];ResetLastError();int fullCount=CopyRates(name,tf,1,200,probe),fullError=GetLastError();
   int available=Bars(name,tf), wanted=fullCount>0?fullCount:(available>1?MathMin(200,available-1):200);
   long localFirst=SeriesInfoInteger(name,tf,SERIES_FIRSTDATE),serverFirst=SeriesInfoInteger(name,tf,SERIES_SERVER_FIRSTDATE);
   bool boundaryReached=localFirst>0 && serverFirst>0 && localFirst<=serverFirst;
   bool complete=false;string group=ArxMarketSeries(index,tf,wanted,complete);if(group=="")return;
   group=StringSubstr(group,0,StringLen(group)-1)+",\"requestedHistoryBars\":200,\"fullRequestCount\":"+(string)fullCount+",\"fullRequestError\":"+(string)fullError+
      ",\"localFirstHistoryServer\":"+(string)localFirst+",\"serverFirstHistoryServer\":"+(string)serverFirst+",\"brokerHistoryBoundaryReached\":"+(boundaryReached?"true":"false")+
      ",\"availableBarsIncludingForming\":"+(string)available+
      ",\"historyDepthPartial\":"+((wanted<200 || !complete)?"true":"false")+"}";
   string timeframe=StringSubstr(EnumToString(tf),7);
   if(ArxMarketWrite("history-extra-"+arxMarketCanonicals[index]+"-"+timeframe+".json",ArxMarketHeader()+",\"producer\":\"read_only_history_indicator\",\"series\":["+group+"]}") && complete)extraFullAt[slot]=now;
}
void OnTimer() {ArxExtraObserve();}
void ArxExtraObserve() {
   ulong now=GetTickCount64();if(extraLastObserve>0 && now-extraLastObserve<1000)return;
   extraLastObserve=now;
   if(!ArxMarketSafe() || !TerminalInfoInteger(TERMINAL_CONNECTED))return;
   // All market reads run in this indicator, where cold CopyRates returns
   // immediately. The EA calendar/heartbeat thread never reads candle history.
   if(now-arxMarketLastQuote>=2000 || arxMarketLastQuote==0) {arxMarketLastQuote=now;ArxMarketQuotes();}
   if(now-arxMarketLastFastM1>=2000 || arxMarketLastFastM1==0) {arxMarketLastFastM1=now;ArxMarketFastClosed(true);}
   if(now-arxMarketLastInventory>=60000 || arxMarketLastInventory==0) {arxMarketLastInventory=now;ArxMarketInventory();}
   // Other20 periods refresh in ten timer invocations; M1 has its own lane.
   for(int i=0;i<2;i++) {ExtraFastSnapshot(extraFastCursor);extraFastCursor++;if(extraFastCursor>=ArraySize(arxExtraTimeframes))extraFastCursor=1;}
   ulong began=GetTickCount64();
   for(int i=0;i<12 && GetTickCount64()-began<150;i++)ExtraFullSnapshot();
}
