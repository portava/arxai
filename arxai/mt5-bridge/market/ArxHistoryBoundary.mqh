#ifndef ARX_HISTORY_BOUNDARY_MQH
#define ARX_HISTORY_BOUNDARY_MQH
// SERIES_SERVER_FIRSTDATE is symbol-wide. Some native intraday series begin
// later on that first day (e.g. BTCUSD H1 at03:00 vs metadata at00:00).
// A local cache date or a short page alone is NEVER evidence of completion.
// Require a successful, synchronized CopyRates DATE RANGE from the server
// start through this candle, containing exactly this one native candle.
bool ArxHistoryFirstDayRangeValid(long serverFirst,long oldest,long closed,
   long rangeFrom,long rangeThrough,long rangeFirst,long localFirst,
   int copied,int error,bool synchronized) {
   return serverFirst>0 && oldest>serverFirst && oldest/86400==serverFirst/86400 && closed>oldest &&
      rangeFrom==serverFirst && rangeThrough==closed-1 && rangeFirst==oldest && localFirst==oldest &&
      copied==1 && error==0 && synchronized;
}
#endif
