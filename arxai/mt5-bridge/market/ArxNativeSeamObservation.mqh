#ifndef ARX_NATIVE_SEAM_OBSERVATION_MQH
#define ARX_NATIVE_SEAM_OBSERVATION_MQH
// Native shift-1 + shift-0 metadata only. Never added to closed candle arrays,
// never sent to the candle-ingest route, and never used for order execution.
string ArxNativeSeamBar(const MqlRates &bar,const int digits) {
   return "{\"openTimeEpochMs\":"+(string)((long)bar.time*1000)+",\"open\":"+ArxMarketN(bar.open,digits)+
      ",\"high\":"+ArxMarketN(bar.high,digits)+",\"low\":"+ArxMarketN(bar.low,digits)+",\"close\":"+ArxMarketN(bar.close,digits)+"}";
}
string ArxNativeSeamObservation(const int index,const ENUM_TIMEFRAMES tf) {
   if(!ArxMarketSafe() || !TerminalInfoInteger(TERMINAL_CONNECTED))return "{\"available\":false,\"reason\":\"READ_ONLY_GUARD_FAILED\"}";
   string name=ArxMarketResolve(index);if(name=="")return "{\"available\":false,\"reason\":\"SYMBOL_UNAVAILABLE\"}";
   MqlRates pair[2];ResetLastError();
   // CopyRates puts the oldest copied element first in physical memory:
   // pair[0] is native shift1; pair[1] is native shift0 from this one call.
   int count=CopyRates(name,tf,0,2,pair), error=GetLastError();
   datetime collected=TimeGMT(), server=TimeTradeServer();
   bool synchronized=SeriesInfoInteger(name,tf,SERIES_SYNCHRONIZED)!=0;
   string prefix="{\"available\":"+(count==2 && error==0 && synchronized?"true":"false")+
      ",\"copyCount\":"+(string)count+",\"error\":"+(string)error+",\"synchronized\":"+(synchronized?"true":"false");
   if(count!=2 || error!=0 || !synchronized)return prefix+"}";
   int digits=(int)SymbolInfoInteger(name,SYMBOL_DIGITS);
   return prefix+",\"observation\":{\"symbol\":"+ArxMarketQ(arxMarketCanonicals[index])+",\"brokerSymbol\":"+ArxMarketQ(name)+
      ",\"timeframe\":"+ArxMarketQ(StringSubstr(EnumToString(tf),7))+",\"collectedAtEpochMs\":"+(string)((long)collected*1000)+
      ",\"brokerServerTimeEpochMs\":"+(string)((long)server*1000)+",\"brokerUtcOffsetMs\":"+(string)(((long)server-(long)collected)*1000)+
      ",\"lastClosed\":"+ArxNativeSeamBar(pair[0],digits)+",\"forming\":"+ArxNativeSeamBar(pair[1],digits)+"}}";
}
#endif
