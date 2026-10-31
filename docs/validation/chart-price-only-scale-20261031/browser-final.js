async page=>{
const SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD=true;
const SCANNER_QA_OUTPUT_PREFIX="/Users/areyouok/arx-tier1-release/chart-price-only-scale-20261031/final";
await (async page => {
 function resolveFixtureRole(value) {
  if(value===undefined)return 'USER';
  if(value==='USER'||value==='ADMIN')return value;
  throw Error('Offline fixture role must be USER or ADMIN');
 }
 const fixtureRole=resolveFixtureRole(typeof SCANNER_QA_ROLE==='undefined'?undefined:SCANNER_QA_ROLE);
 const preserveStorageOnReload=typeof SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD==='undefined'?false:SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD;
 if(typeof preserveStorageOnReload!=='boolean')throw Error('Offline storage preservation must be boolean');
 function initializeOfflineStorage(preserve) {
  const marker='arx.offline.qa.storage.initialized.v1';
  if(!preserve||sessionStorage.getItem(marker)!=='yes') {
   localStorage.clear();sessionStorage.clear();
   localStorage.setItem('highroll.chartSymbol','EURUSD');
   localStorage.setItem('highroll.onboarding.firstrun.dismissed.v1','1');
   if(preserve)sessionStorage.setItem(marker,'yes');
  }
 }

 const requests=[],unknown=[],blocked=[],errors=[],consoleErrors=[],candleResponses=[];
 const origin=typeof SCANNER_QA_BASE_URL==='string'?SCANNER_QA_BASE_URL:'http://127.0.0.1:4199';
 if(new URL(origin).hostname!=='127.0.0.1')throw Error('Offline fixture requires loopback');
 if(page.context().serviceWorkers().length)throw Error('Use a fresh browser session without service workers');
 let fixtureSource='offline_fixture',fixtureIdentity='synthetic-history-A';
 await page.exposeFunction('__fixtureSwitchSource', config => {fixtureSource=config.source;fixtureIdentity=config.identity;return true;});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error') consoleErrors.push(m.text());});
 await page.exposeFunction('__readFixtureLog',()=>({fixtureRole,preserveStorageOnReload,requests,unknown,blocked,errors,consoleErrors,candleResponses}));
 await page.context().routeWebSocket('**/*',ws=>{blocked.push({kind:'websocket',url:ws.url()});ws.close();});
 await page.addInitScript(initializeOfflineStorage,preserveStorageOnReload);
 await page.addInitScript(()=>{
  if(navigator.serviceWorker)navigator.serviceWorker.register=async()=>{throw Error('Service workers disabled for offline QA');};
  window.__offlineStreams=[];
  class OfflineEventSource { constructor(url){this.url=url;this.readyState=2;window.__offlineStreams.push(this);} close(){this.closed=true;} addEventListener(){} removeEventListener(){} }
  window.EventSource=OfflineEventSource;
  window.addEventListener('DOMContentLoaded',()=>{const note=document.createElement('div');note.textContent='OFFLINE QA — synthetic historical candles; all APIs intercepted; trading disabled';note.style='position:fixed;bottom:0;left:0;right:0;z-index:999999;background:#854d0e;color:white;padding:4px;font:12px sans-serif;pointer-events:none';document.body.append(note);});
 });
 const symbols=['EURUSD','GBPUSD','USDJPY','XAUUSD','NAS100','V75'];
 const mode={ok:true,userId:900007,currentAccountMode:'LIVE_SHARED',cleanModeLabel:'Offline read-only fixture',cleanUserMessage:'No broker connection',cleanBlockedReason:'OFFLINE_FIXTURE',role:fixtureRole,isAdmin:fixtureRole==='ADMIN',isAdminPreviewingUserMode:false,adminDiagnosticsAvailable:false,liveExecutionArmed:false,userSharedMasterAssignment:{attached:false},accountShellStatus:{accountMode:'SHARED_MASTER_MT5',tradingMode:'DISABLED',tradingModeLabel:'Disabled',approvalStatus:'APPROVED',tradingStatus:'DISABLED'},userAllocation:{hasAllocation:false,currentBalance:0,assignedStartingBalance:null,equity:0,marginUsed:0},userRiskCaps:{maxLotSize:0,maxOpenTrades:0,maxDailyLossAmount:0,allowedSymbols:[],requireStopLoss:true},userFrozenStatus:{isFrozen:true,freezeMessage:'Offline fixture'},userApprovalStatus:'APPROVED',userCanManualTrade:false,userCanAutoTrade:false,aiSleeveStatus:{enabled:false,autoEnabled:false},demoAvailable:false,paperAvailable:false,modeSwitchOptions:[],adminDiagnostics:null};
 function selected(symbol,timeframe){return{ok:true,symbolRaw:symbol,symbol,timeframe,highlights:{bias:'WAIT',confidenceLabel:'Very Low',confidenceScore:0,volatilityLabel:'Calm',trendState:'neutral',entryZone:null,suggestedStop:null,suggestedTakeProfit:null,riskRewardRatio:0,riskWarnings:['Offline fixture: not market analysis']},explanation:{hedge:'Offline fixture; no live market read.',why:'Synthetic historical candles for UI validation only.',whyItMatters:'No financial inference is available.',risk:'Unavailable.',invalidation:'Unavailable.',cautions:['No live source'],disclaimer:'OFFLINE QA ONLY'},upcomingEvents:[],newsRisk:{riskLevel:'none',blockTrading:true,summary:'News unavailable in offline fixture'},dataSource:'LIVE_FEED',dataSourceLabel:'Offline fixture — no live feed',dataState:'UNAVAILABLE',dataAsOf:'2026-01-02T12:00:00.000Z',generatedAt:'2026-01-02T12:00:01.000Z',levelsWithheld:true,levelsWithheldReason:'Offline fixture',cacheHit:false};}
 function candles(symbol,timeframe,limit){const step=({M1:60,M2:120,M3:180,M4:240,M5:300,M6:360,M10:600,M12:720,M15:900,M20:1200,M30:1800,H1:3600,H2:7200,H3:10800,H4:14400,H6:21600,H8:28800,H12:43200,D1:86400})[timeframe];if(!step)throw Error('Unsupported fixture interval: '+timeframe);limit=Math.min(Math.max(Math.floor(limit),1),1000);const end=1767355200;const bars=Array.from({length:Math.min(limit,1000)},(_,i)=>{const ms=(end-(limit-i)*step)*1000,close=(symbol==='GBPUSD'?100:symbol==='USDJPY'?10000:1)*(1+Math.sin(i/17)*.003);return{symbol,timeframe,openTime:new Date(ms).toISOString(),closeTime:new Date(ms+step*1000).toISOString(),open:close-.0001,high:close+.0003,low:close-.0003,close,volume:0,source:fixtureSource,isComplete:true,isFinal:true,sourceMode:'MOCK',qualityFlags:['MOCK_DATA']};});const fs={symbol,displaySymbol:symbol,assetClass:'forex',source:fixtureSource,quality:'invalid',isLive:false,stale:true,aiUsable:false,lastCandleTime:'2026-01-02T12:00:00.000Z',lastTickTime:null,latencyMs:0,missingCandleCount:0,duplicateCount:0,outOfOrderCount:0,invalidOhlcCount:0,trailingIntervals:9999,warning:'OFFLINE FIXTURE — synthetic historical bars, not market data',message:'Offline fixture',feedReadinessState:null,completenessReason:null};return{symbol,displaySymbol:symbol,timeframe,assetClass:'forex',source:fixtureSource,quality:'invalid',aiUsable:false,requestedLimit:limit,candleCount:bars.length,candles:bars,feedStatus:fs,marketEvidence:{symbol,timeframe,source:fixtureSource,sourceIdentity:fixtureIdentity,lastClosedCandleAt:'2026-01-02T12:00:00Z'},truthResult:null,chartTruthScore:null};}
 await page.context().route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin){blocked.push({kind:'external',url:request.url()});return route.abort();}
  if(!url.pathname.startsWith('/api/')){if(request.method()!=='GET'){blocked.push({kind:'mutation',path:url.pathname,method:request.method(),status:503});return route.fulfill({status:503,contentType:'application/json',body:'{\"error\":\"OFFLINE_MUTATION_BLOCKED\"}'});}return route.continue();}
  const item={path:url.pathname,query:url.search,method:request.method(),started:Date.now(),ended:null,status:200};requests.push(item);
  let payload,status=200,delay=20;
  const p=url.pathname,symbol=url.searchParams.get('symbol')??'EURUSD',tf=url.searchParams.get('timeframe')??'M15';
  if(request.method()!=='GET'){status=503;payload={ok:false,error:'OFFLINE_MUTATION_BLOCKED'};blocked.push({kind:'mutation',path:p,method:request.method(),status:503});}
  else if(p==='/api/me')payload={user:{id:900007,email:'offline@example.invalid',name:'Offline QA',role:fixtureRole,lastLoginAt:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}};
  else if(p==='/api/me/account-mode')payload=mode;
  else if(p==='/api/me/assistant-settings')payload={displayName:'Eleanor',isDefault:true};
  else if(p==='/api/onboarding/status')payload={status:{status:'COMPLETED',walkthroughCompleted:true,totalSteps:0,completedSteps:[],skippedSteps:[],nextStep:null}};
  else if(p==='/api/feature-announcements')payload={announcements:[]};
  else if(p==='/api/market-scanner/universes')payload={universes:[{id:'all',label:'Offline universe',symbols,available:true,note:'Fixture symbols only'},{id:'forex',label:'Forex',symbols:symbols.slice(0,3),available:true}],defaultUniverse:'all'};
  else if(p==='/api/market-scanner/status')payload={running:false,universe:'all',lastScanAt:null,feedNote:'OFFLINE QA — no live feed'};
  else if(p==='/api/market-scanner/opportunities')payload={opportunities:[],universe:'all',universeSymbols:symbols,generatedAt:'2026-01-02T12:00:01Z',dataSource:'AWAITING_FEED'};
  else if(p==='/api/market-scanner/selected-market'){payload=selected(symbol,tf);delay=450;}
  else if(p==='/api/chart/candles'){payload=candles(symbol,tf,Number(url.searchParams.get('limit')??200));delay=80;candleResponses.push({symbol,timeframe:tf,requestPath:p,requestQuery:url.search,source:fixtureSource,sourceIdentity:fixtureIdentity,canonical:payload.candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close}))});}
  else if(p==='/api/chart/history')payload={ok:true,source:fixtureSource,candles:[],status:'unavailable',returnedCount:0,oldest:null,newest:null,hasMoreHistory:false,nextBefore:null,providerLimitReached:true,limitationReason:'Offline fixture',cacheHit:false};
  else if(p==='/api/market-data/deriv/status')payload={configured:false,connected:false,status:'OFFLINE_FIXTURE'};
  else if(p==='/api/me/opportunity-map'){const cats=['READY_NOW','FORMING_SOON','WATCH_AFTER_NEWS','TOO_LATE','AVOID','NO_CLEAN_SETUP'];const rows=symbols.map(symbol=>({symbol,displayName:symbol,direction:'NEUTRAL',recommendedAction:'WAIT',setupType:'Offline fixture',edgeScore:0,entryQuality:0,executionQuality:0,newsRisk:'unknown',hasLiveData:false,isLate:false,reason:'Offline fixture: no live analysis.',category:'NO_CLEAN_SETUP',kind:'NONE',bestAction:'WAIT',stageLabel:'Unavailable'}));payload={universe:'all',timeframe:tf,generatedAt:new Date().toISOString(),universeCount:rows.length,map:{rows,categories:Object.fromEntries(cats.map(c=>[c,c==='NO_CLEAN_SETUP'?rows:[]])),best:{bestScalp:null,bestMomentum:null,bestRetest:null,bestReversal:null},scannedCount:rows.length,liveCount:0},bestVsSelected:{selectedSymbol:url.searchParams.get('selectedSymbol'),hasCleanerAlternative:false,best:null,message:'Offline fixture'},skippedSymbols:[],dataNote:'OFFLINE FIXTURE — no market assessment'};delay=url.searchParams.has('selectedSymbol')?450:20;}
  else if(p==='/api/watchlists')payload=[];
  else if(p==='/api/aaci/cohesion')payload={items:[]};
  else if(p==='/api/me/live/positions')payload={positions:[]};
  else if(p==='/api/me/live/commands')payload={commands:[]};
  else if(p==='/api/me/chart/smart-layers')payload={layers:[],handshakeInputs:{signalSymbol:symbol,signalExists:false,hasSufficientData:false,levelCount:0,newsMapped:false},signal:null};
  else if(p==='/api/me/chart-annotations')payload={annotations:[]};
  else {unknown.push({path:p,query:url.search});status=503;payload={ok:false,error:'OFFLINE_FIXTURE_UNAVAILABLE',message:'Unavailable in offline QA'};}
  await new Promise(resolve=>setTimeout(resolve,delay));
  item.ended=Date.now();item.status=status;
  try{await route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});}catch{item.cancelled=true;}
 });
 await page.setViewportSize({width:1440,height:1100});
 await page.goto(origin+'/market-scanner');
 await page.getByTestId('scanner-chart-panel').waitFor({timeout:15000});
 await page.getByTestId('arx-native-canvas').waitFor({timeout:15000});
 await page.getByTestId('badge-active-symbol').waitFor({timeout:15000});
 await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount>0);
 return{url:page.url(),fixtureRole,fixture:'real dashboard route and providers; synthetic history; no broker',canvasCount:await page.locator('canvas').count(),errors,unknown:[...new Set(unknown.map(x=>x.path))],requests:requests.length,blocked};
}
)(page);
return await (async page => {
  const report={passed:false,build:null,runs:[],failure:null,limitations:['Actual Scanner production fixture,200 historical synthetic bars; no real provider,broker,physical paint or competitor timing.','Desktop1440x1100,1x/4x CPU;20 measured toggles per condition plus4 retained warmups.','Completion is correct geometry/data on two frames; not guaranteed pixel presentation.']};
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/chart-price-scale';
  const check=(value,message)=>{if(!value)throw Error(message);};
  const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const read=()=>page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),configuration:window.__arxChartQa.configuration(),geometry:window.__arxChartQa.priceGeometry()}));
  const stats=values=>{const a=values.sort((a,b)=>a-b);return {n:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],p99:a[Math.ceil(a.length*.99)-1],max:a.at(-1)};};
  const cdp=await page.context().newCDPSession(page);
  try{
    check(new URL(page.url()).origin==='http://127.0.0.1:4199','Offline Scanner required');
    report.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');return r.json();});
    check(report.build.sourceUnchanged&&!report.build.source.status&&report.build.productionRuntimeChecked,'Clean production source required');
    check(await page.evaluate(()=>window.__arxScannerQaBuildId)===report.build.buildId,'Runtime identity mismatch');
    await page.evaluate(()=>localStorage.setItem('arx.chart.preferences.v1',JSON.stringify({style:'candles',scale:'linear',studies:[{kind:'bollinger',period:20,multiplier:100,color:'#38bdf8',id:'wide-band'},{kind:'rsi',period:14,color:'#fbbf24',id:'oscillator'}]})));
    await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.configuration()?.studies?.length===2&&window.__arxChartQa?.data()?.canonical.length===200);await frames();
    const panel=page.getByTestId('scanner-chart-panel'),button=panel.getByRole('button',{name:'Scale price only',exact:true});
    const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
    check(await button.getAttribute('aria-pressed')==='false','Default fitting policy changed');
    await panel.evaluate(element=>element.scrollIntoView({block:'start'}));await frames();
    const initial=await read();report.before=initial;
    await page.screenshot({path:prefix+'-disabled.png'});
    check(initial.configuration.studies[0].config.multiplier===100,'Wide-band workload not applied');
    const authority=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(r=>r.symbol===initial.state.symbol&&r.timeframe==='M15').at(-1);
    check(authority&&JSON.stringify(initial.data.canonical)===JSON.stringify(authority.canonical)&&JSON.stringify(initial.data.display.map(({time,open,high,low,close})=>({time,open,high,low,close})))===JSON.stringify(authority.canonical),'Source/display mismatch before test');
    const span=g=>Math.abs(g.highY-g.lowY);check(Number.isFinite(span(initial.geometry))&&span(initial.geometry)>0,'No initial price geometry');
    for(const cpuRate of [1,4]){
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
      const run={cpuRate,samples:[],failure:null};report.runs.push(run);
      for(let i=0;i<24;i++){
        const enabled=i%2===0;
        await page.evaluate(({initial,enabled})=>{
          const button=document.querySelector('[data-testid="scanner-chart-panel"] button[title^="Automatically fit the price scale"]');
          const capture=event=>{
            if(!event.isTrusted)return;
            const start=event.timeStamp;if(!Number.isFinite(start)||start<0||start>performance.now())throw Error('Invalid input clock');const result=window.__priceScaleTiming={start,enabled,trusted:event.isTrusted,done:false,failure:null,frames:0};
            let matched=false;
            const timer=setTimeout(()=>{result.failure='completion deadline';result.done=true;},5000);
            const tick=()=>{
              if(result.done)return;
              const w=window.__arxChartQa,state=w.snapshot(),data=w.data(),configuration=w.configuration(),geometry=w.priceGeometry();result.frames++;
              const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),span=g=>Math.abs(g.highY-g.lowY);
              const bounds=state.bounds,visible=Math.min(bounds.y+bounds.height,innerHeight)-Math.max(bounds.y,0)>=100&&Math.min(bounds.x+bounds.width,innerWidth)-Math.max(bounds.x,0)>=100;
              const container=document.querySelector('[data-testid="scanner-chart-panel"] [data-testid="arx-native-canvas"]'),left=Math.max(bounds.x,0),right=Math.min(bounds.x+bounds.width,innerWidth),top=Math.max(bounds.y,0),bottom=Math.min(bounds.y+bounds.height,innerHeight);
              const unobscured=[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].every(([x,y])=>container.contains(document.elementFromPoint(left+(right-left)*x,top+(bottom-top)*y)));
              const correct=visible&&unobscured&&button.getAttribute('aria-pressed')===String(enabled)&&same(data,initial.data)&&same(configuration,initial.configuration)&&same(state.range,initial.state.range)&&same(state.feed,initial.state.feed)&&state.seriesId===initial.state.seriesId&&state.chartId===initial.state.chartId&&geometry&&Number.isFinite(span(geometry))&&(enabled?span(geometry)>span(initial.geometry)*1.5:Math.abs(span(geometry)-span(initial.geometry))<1);
              result.last={state,geometry,correct};
              if(correct&&matched){result.ms=performance.now()-start;result.done=true;clearTimeout(timer);return;}
              matched=correct;requestAnimationFrame(tick);
            };requestAnimationFrame(tick);
          };button.addEventListener('click',capture,{once:true});
        },{initial,enabled});
        await button.click();await page.waitForFunction(()=>window.__priceScaleTiming?.done,null,{timeout:6500});
        const sample=await page.evaluate(()=>window.__priceScaleTiming);run.samples.push({...sample,record:i>=4});check(!sample.failure,'Geometry/data completion failed');
      }
      const values=run.samples.filter(s=>s.record).map(s=>s.ms);run.summary=stats(values);run.passed=values.length===20&&run.summary.p95<=100;
    }
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await button.click();await frames();report.enabled=await read();
    await page.screenshot({path:prefix+'-enabled.png'});
    await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.configuration()?.studies?.length===2&&window.__arxChartQa?.data()?.canonical.length===200);await frames();
    report.reloaded=await read();check(await button.getAttribute('aria-pressed')==='true'&&span(report.reloaded.geometry)>span(initial.geometry)*1.5,'Preference not restored after reload');
    report.network=await page.evaluate(()=>window.__readFixtureLog());check(!report.network.errors.length,'Page exceptions recorded');
    report.passed=report.runs.length===2&&report.runs.every(r=>r.passed);
  }catch(error){report.failure=String(error?.stack??error);}
  finally{report.network=await page.evaluate(()=>window.__readFixtureLog()).catch(()=>null);await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
  return report;
}
)(page);
}