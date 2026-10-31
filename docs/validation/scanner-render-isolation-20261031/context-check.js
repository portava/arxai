async page=>{
 const r={passed:false,checks:[],failure:null};const check=(v,m)=>{if(!v)throw Error(m);};
 try{
  const universe={ok:true,symbols:["EURUSD","GBPUSD","USDJPY"].map(symbol=>({symbol,displayName:symbol,brokerSymbol:null,category:"Offline Forex",source:"default",tradeable:false,scannerEnabled:true,candlesEnabled:true,executionRequiresBrokerConfirmation:true,freshness:"MISSING"})),enumerationStatus:{available:false,count:0,lastEnumeratedAt:null},warnings:["Offline fixture"],sourceSummary:{sharedBridge:0,enumerated:0,defaults:3}};
  r.universeFixture=universe;r.universeRequests=0;
  await page.context().route("http://127.0.0.1:4199/api/me/symbols",async route=>{if(route.request().method()!=="GET")return route.fallback();r.universeRequests++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(universe)});});
  await page.setViewportSize({width:1440,height:1100});await page.goto('http://127.0.0.1:4199/market-scanner');
  await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  for(const symbol of ['GBPUSD','USDJPY','EURUSD']){
   await page.getByTestId('button-symbol-picker').click();await page.getByTestId('symbol-option-'+symbol).click();
   await page.waitForFunction(symbol=>window.__arxChartQa?.snapshot()?.symbol===symbol&&window.__arxChartQa?.snapshot()?.barCount===200,symbol);
   for(const interval of [{id:'M5',seconds:300},{id:'M15',seconds:900}]){
    await page.getByTestId('arx-native-tf-'+interval.id).click();
    await page.waitForFunction(({symbol,seconds})=>{const s=window.__arxChartQa?.snapshot();return s?.symbol===symbol&&s?.intervalSeconds===seconds&&s?.barCount===200;},{symbol,seconds:interval.seconds});
    const state=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),log:window.__readFixtureLog()}));
    const log=await page.evaluate(()=>window.__readFixtureLog());const authority=log.candleResponses.filter(c=>c.symbol===symbol&&c.timeframe===interval.id).at(-1);
    check(!!authority,'No candle receipt for '+symbol+interval.id);const project=c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close});
    check(JSON.stringify(state.data.canonical)===JSON.stringify(authority.canonical),'Canonical source mismatch');
    check(JSON.stringify(state.data.display.map(project))===JSON.stringify(authority.canonical),'Displayed source mismatch');
    check(state.state.feed.livePriceAffordance===false,'Historical fixture appeared live');
    r.checks.push({symbol,interval,state:state.state,data:state.data});
   }
  }
  await page.getByTestId('page-tab-symbols').click();await page.getByTestId('page-tab-focus').click();
  await page.getByTestId('ruby-scalp-focus').waitFor();await page.getByTestId('arx-native-canvas').waitFor();
  r.passed=r.checks.length===6;
 }catch(e){r.failure=String(e?.stack??e);}
 r.network=await page.evaluate(()=>window.__readFixtureLog());return r;
}
