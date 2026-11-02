// Compose this factory's result as SCANNER_QA_HOOKS with shared-chart-setup.js.
// Synthetic read-only contracts; no connection to a terminal or account.
() => {
  const source = 'deriv_public', identity = 'b'.repeat(64), pages = [];
  const position = (symbol, ticket) => ({scope:'demo',brokerTicket:ticket,symbol,side:'BUY',lotSize:0.01,
    entryPrice:1.001,currentPrice:1.002,stopLoss:0.99,takeProfit:1.01,floatingPnl:null,
    openedAt:'2026-01-02T10:00:00.000Z',sourceCommandId:null,accountMode:'DEMO',source:'OFFLINE_FIXTURE'});
  return {
    initialSource:source, initialIdentity:identity,
    install:async page => { await page.exposeFunction('__readNativeHistoryFixture',()=>pages); },
    readResponse:({path,symbol,timeframe,query}) => {
      if(path==='/api/me/positions/all')return {ok:true,live:[],demo:[position('EURUSD','fixture-eur'),position('GBPUSD','fixture-gbp')],liveCount:0,demoCount:2};
      if(path!=='/api/chart/history')return undefined;
      const params=new URLSearchParams(query), before=params.get('before'), end=Date.parse(before), step=900000;
      if(symbol!=='EURUSD'||timeframe!=='M15'||!Number.isFinite(end)||params.get('source')!==source||params.get('sourceIdentity')!==identity)throw Error('Unexpected synthetic history request: '+query);
      const candles=Array.from({length:60},(_,i)=>{
        const time=end-(60-i)*step,close=1+Math.sin(i/9)*.002;
        return {symbol,timeframe,openTime:new Date(time).toISOString(),closeTime:new Date(time+step).toISOString(),open:close-.0001,high:close+.0003,low:close-.0003,close,source,isComplete:true,isFinal:true,volume:0};
      });
      pages.push({query,canonical:candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close}))});
      return {ok:true,source,candles,status:'historical_only',returnedCount:60,oldest:candles[0].openTime,newest:candles.at(-1).openTime,
        hasMoreHistory:false,nextBefore:null,providerLimitReached:true,limitationReason:'End of synthetic QA history',cacheHit:false,
        historyEvidence:{symbol,timeframe,source,sourceIdentity:identity,scope:'public_provider',lastClosedCandleAt:before}};
    },
  };
}
