#property strict
#property indicator_chart_window
#property indicator_buffers 1
#property indicator_plots 0
// Five-minute same-symbol native history diagnostic only. No network/orders.
const bool ReadOnlyMode=true,AllowOrderExecution=false,AllowPendingOrders=false,AllowProtectionModify=false,
 AllowPositionClose=false,AllowPendingCancel=false,AllowPendingModify=false,AllowEmergencyClose=false;
#include "ArxMarketObservation.mqh"
ENUM_TIMEFRAMES periods[]={PERIOD_M1,PERIOD_M5,PERIOD_H1,PERIOD_M15,PERIOD_M30,PERIOD_H4,PERIOD_D1,PERIOD_H2,PERIOD_H3,PERIOD_H6,PERIOD_H8,PERIOD_H12,PERIOD_W1,PERIOD_MN1,PERIOD_M2,PERIOD_M3,PERIOD_M4,PERIOD_M6,PERIOD_M10,PERIOD_M12,PERIOD_M20};
int cursor=0,xau=-1;ulong began=0,lastObserve=0;double pulse[];
int OnInit() {
 if(!ArxMarketSafe() || _Symbol!="XAUUSD" || _Period!=PERIOD_M1)return INIT_FAILED;
 for(int i=0;i<ArraySize(arxMarketCanonicals);i++)if(arxMarketCanonicals[i]=="XAUUSD")xau=i;
 if(xau<0)return INIT_FAILED;
 IndicatorSetString(INDICATOR_SHORTNAME,"ARX XAU ReadOnly Diagnostic");SetIndexBuffer(0,pulse,INDICATOR_DATA);
 began=GetTickCount64();EventSetTimer(1);return INIT_SUCCEEDED;
}
void Observe() {
 ulong now=GetTickCount64();if(now-began>300000){EventKillTimer();return;}
 if(lastObserve>0 && now-lastObserve<1000)return;lastObserve=now;
 if(!ArxMarketSafe() || !TerminalInfoInteger(TERMINAL_CONNECTED))return;
 for(int n=0;n<2;n++) {
  ENUM_TIMEFRAMES tf=periods[cursor];cursor=(cursor+1)%ArraySize(periods);
  bool complete=false;string row=ArxMarketSeries(xau,tf,2,complete);
  MqlRates datePair[2];ResetLastError();int dateCount=CopyRates("XAUUSD",tf,TimeTradeServer(),2,datePair),dateError=GetLastError();
  string dateBars="";for(int k=0;k<dateCount;k++){if(dateBars!="")dateBars+=",";dateBars+=ArxNativeSeamBar(datePair[k],2);}
  string name=StringSubstr(EnumToString(tf),7);
  ArxMarketWrite("diagnostic-xau-"+name+".json",ArxMarketHeader()+",\"producer\":\"bounded_same_symbol_diagnostic\",\"chartSymbol\":"+ArxMarketQ(_Symbol)+",\"chartTimeframe\":\"M1\",\"series\":["+row+"],\"dateCopyCount\":"+(string)dateCount+",\"dateCopyError\":"+(string)dateError+",\"datePair\":["+dateBars+"]}");
 }
}
int OnCalculate(const int total,const int prev,const int begin,const double &price[]) {Observe();if(total>0)pulse[total-1]=1;return total;}
void OnTimer(){Observe();}
void OnDeinit(const int reason){EventKillTimer();}
