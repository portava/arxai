// Actual Scanner and native reader, with deliberately constructed source-shaped
// responses. Install before the shared setup; no real provider/broker evidence.
async page => {
  let responses = 0;
  await page.route('**/api/chart/candles?*', async route => {
    if(route.request().method()!=='GET') return route.fulfill({status:503,body:'OFFLINE_WRITE_BLOCKED'});
    const url=new URL(route.request().url());
    if(url.origin!=='http://127.0.0.1:4199')return route.abort();
    const symbol=url.searchParams.get('symbol'),timeframe=url.searchParams.get('timeframe');
    const seconds=({M1:60,M2:120,M3:180,M4:240,M5:300,M6:360,M10:600,M12:720,M15:900,M20:1200,M30:1800,H1:3600,H2:7200,H3:10800,H4:14400,H6:21600,H8:28800,H12:43200,D1:86400})[timeframe];
    if(!seconds)throw Error('Unsupported constructed interval');
    const count=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')||200)));
    const end=Math.floor(Date.now()/1000/seconds)*seconds;
    const candles=Array.from({length:count},(_,i)=>({symbol,timeframe,source:'deriv_public',sourceMode:'live',openTime:new Date((end-(count-i)*seconds)*1000).toISOString(),closeTime:new Date((end-(count-i-1)*seconds)*1000).toISOString(),open:100,high:101,low:99,close:100,isComplete:true,isFinal:true,isForming:false,qualityFlags:[],volume:0}));
    const stamp=candles.at(-1).closeTime;
    const feedStatus={symbol,displaySymbol:symbol,assetClass:'forex',source:'deriv_public',quality:'clean',isLive:true,stale:false,aiUsable:true,lastCandleTime:stamp,lastTickTime:new Date().toISOString(),latencyMs:0,missingCandleCount:0,duplicateCount:0,outOfOrderCount:0,invalidOhlcCount:0,trailingIntervals:0,warning:'CONSTRUCTED QA RESPONSE — NO REAL MARKET DATA',message:'OFFLINE source-shaped input'};
    responses++;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({symbol,displaySymbol:symbol,timeframe,source:'deriv_public',quality:'clean',aiUsable:true,requestedLimit:count,candleCount:count,candles,feedStatus,marketEvidence:{symbol,timeframe,source:'deriv_public',sourceIdentity:'a'.repeat(64),lastClosedCandleAt:stamp},truthResult:null,chartTruthScore:null})});
  });
  return {responses:()=>responses};
}
