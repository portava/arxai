async page=>{
const SCANNER_QA_IDLE_BEFORE_CLICK_MS=0;
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
return await (// Run shared-chart-setup.js first in a fresh offline browser session.
// Unlike the earlier navigation probe, no metadata or OHLC reads delay the click.
async page => {
  const origin='http://127.0.0.1:4199';
  if(new URL(page.url()).origin!==origin)throw Error('Offline loopback fixture required');
  const expectedHead=typeof SCANNER_QA_EXPECTED_COMMIT==='string'?SCANNER_QA_EXPECTED_COMMIT:null;
  function navigationBudget(idleBeforeClickMs) {
    if(!Number.isSafeInteger(idleBeforeClickMs)||idleBeforeClickMs<0||idleBeforeClickMs>2000)throw Error('Idle-before-click must be an explicit 0..2000ms integer');
    return {idleBeforeClickMs,clickAfterReadyMs:150+idleBeforeClickMs,completionMs:100,timeoutMs:8000};
  }
  const budget=navigationBudget(typeof SCANNER_QA_IDLE_BEFORE_CLICK_MS==='undefined'?0:SCANNER_QA_IDLE_BEFORE_CLICK_MS);
  const report={schemaVersion:2,passed:false,build:null,samples:[],failure:null,budget,
    method:{scenario:budget.idleBeforeClickMs===0?'immediate first actionable click':`first click after explicit ${budget.idleBeforeClickMs}ms idle dwell; NOT immediate-click acceptance`,start:'Trusted click event.timeStamp. First actionable navigation link is observed in-page from document initialization.',
      completion:'Exact canonical AND displayed OHLC, source, symbol, interval and real series identity match on two consecutive rendering frames. Visible completion additionally requires 100x100 viewport intersection and five unobscured plot hit-test points.',
      click:budget.idleBeforeClickMs===0?'After document commit, immediately issue the visible Scanner-link click. No metadata fetch, screenshot, readback or intentional hover dwell precedes it.':`After navigation becomes visible, wait ${budget.idleBeforeClickMs}ms without hovering, then click. This distinct idle-warmed scenario must not be mixed with immediate clicks.`,
      cache:'Full-document route reloads with intercepted requests (HTTP cache disabled by Playwright routing). Initial fixture preparation primes browser resources; this is not cold browser-process startup.',
      failures:'Every planned attempt remains. A blocked or late click, missing response, incorrect series or offscreen chart cannot pass. Successful timing distributions are labelled separately.'},
    limitations:['Offline historical synthetic bars and fixed 80ms candle response delay; no provider, published app or broker measurement.',
      'Two rendering opportunities are not hardware paint. Full OHLC witness cost is included, never subtracted.',
      'Desktop/mobile viewports are browser emulation, not physical devices. Active AI analysis remains unavailable.',
      'Navigation controls are already exposed on both sizes; no drawer opening or forced DOM click is substituted.']};
  function assess(current,authority,viewport,unobscured) {
    const state=current?.state,data=current?.data;
    if(!state||!data||!Array.isArray(data.canonical)||!Array.isArray(data.display))return {source:false,visible:false,reason:'chart observer unavailable'};
    const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
    const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    if(state.symbol!==authority.symbol||state.intervalSeconds!==authority.intervalSeconds||state.style!=='candles'||state.feed?.source!==authority.source||state.feed?.livePriceAffordance!==false)return {source:false,visible:false,reason:'context/source/style mismatch'};
    if(!state.adapterId||!state.chartId||!state.seriesId||!state.canvasIds?.length||state.barCount!==authority.canonical.length||!state.range||!(state.range.to>state.range.from))return {source:false,visible:false,reason:'actual chart/series/range not ready'};
    if(!eq(data.canonical,authority.canonical)||!eq(data.display.map(bar),authority.canonical))return {source:false,visible:false,reason:'canonical/displayed OHLC mismatch'};
    const b=state.bounds;
    const visible=!!b&&Math.min(b.x+b.width,viewport.width)-Math.max(b.x,0)>=100&&Math.min(b.y+b.height,viewport.height)-Math.max(b.y,0)>=100&&unobscured;
    return {source:true,visible,reason:visible?null:'plot offscreen or obscured',identity:[state.adapterId,state.chartId,state.seriesId,...state.canvasIds].join(':')};
  }
  function plotVisible(bounds,viewport,hit) {
    const left=Math.max(0,bounds.x),right=Math.min(viewport.width,bounds.x+bounds.width);
    const top=Math.max(0,bounds.y),bottom=Math.min(viewport.height,bounds.y+bounds.height);
    if(right-left<100||bottom-top<100)return false;
    // A fixed bottom nav can cover the centre of a partial plot intersection.
    // Find an actual 100px square; never infer visibility from bounds alone.
    for(const x of [left+50,(left+right)/2,right-50])for(const y of [top+50,(top+bottom)/2,bottom-50]) {
      if([[x,y],[x-49,y-49],[x+49,y-49],[x-49,y+49],[x+49,y+49]].every(([px,py])=>hit(px,py)))return true;
    }
    return false;
  }
  function acceptSample(sample,budget) {
    const errors=[];
    if(sample.failure)errors.push(sample.failure);
    if(sample.trusted!==true||!Number.isFinite(sample.click)||sample.click<0)errors.push('No trusted valid-clock Scanner click');
    if(!Number.isFinite(sample.readyAt)||!Number.isFinite(sample.readyToClickMs)||sample.readyToClickMs<(budget.idleBeforeClickMs??0)||sample.readyToClickMs>budget.clickAfterReadyMs)errors.push('Click outside declared readiness/dwell window');
    if(!Number.isFinite(sample.sourceCompleteMs)||!Number.isFinite(sample.visibleCompleteMs)||sample.sourceCompleteMs<0||sample.visibleCompleteMs<sample.sourceCompleteMs)errors.push('Source-correct visible completion not proven');
    if(!sample.responseMatches||!sample.buildMatches)errors.push('Response or executing build not verified');
    return {valid:errors.length===0,meetsTarget:errors.length===0&&sample.visibleCompleteMs<=budget.completionMs,errors};
  }
  function install({authority,budget,assessSource,visibilitySource}) {
    const assess=(0,eval)('('+assessSource+')');
    const plotVisible=(0,eval)('('+visibilitySource+')');
    const result=window.__arxFirstNavigation={readyAt:null,click:null,readyToClickMs:null,trusted:false,pointerAt:null,canvasMs:null,sourceCompleteMs:null,visibleCompleteMs:null,witnessCostMs:0,frames:0,failure:null,done:false,dialogObserved:false};
    let previousSource=null,previousVisible=null,frame=0,timer=null;
    const started=performance.now();
    const navigationSelector=innerWidth<768?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]';
    const visibleBox=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.visibility==='visible'&&Number(s.opacity)>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
    function actionableLink() {
      return [...document.querySelectorAll(navigationSelector)].find(element=>{
        if(!visibleBox(element))return false;
        const r=element.getBoundingClientRect(),x=Math.max(0,r.left)+Math.min(r.width,innerWidth-Math.max(0,r.left))/2,y=Math.max(0,r.top)+Math.min(r.height,innerHeight-Math.max(0,r.top))/2;
        const hit=document.elementFromPoint(x,y);return hit===element||element.contains(hit);
      });
    }
    function finish(failure) { result.failure=failure;result.done=true;cancelAnimationFrame(frame);clearTimeout(timer); }
    function observe() {
      if(result.done)return;
      const now=performance.now();
      if(result.readyAt===null&&actionableLink())result.readyAt=now;
      if(document.querySelector('[role="dialog"][data-state="open"]'))result.dialogObserved=true;
      if(result.click===null){if(now-started>budget.timeoutMs)finish('Navigation not clicked before deadline');else frame=requestAnimationFrame(observe);return;}
      result.frames++;
      const before=performance.now();
      const canvas=document.querySelector('[data-testid="arx-native-canvas"]');
      if(canvas&&result.canvasMs===null)result.canvasMs=now-result.click;
      let unobscured=false;
      if(canvas)unobscured=plotVisible(canvas.getBoundingClientRect(),{width:innerWidth,height:innerHeight},(x,y)=>{const hit=document.elementFromPoint(x,y);return canvas===hit||canvas.contains(hit);});
      const witness=assess({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()},authority,{width:innerWidth,height:innerHeight},unobscured);
      const observedAt=performance.now();result.witnessCostMs+=observedAt-before;result.lastWitness=witness;
      if(witness.source&&previousSource===witness.identity&&result.sourceCompleteMs===null)result.sourceCompleteMs=observedAt-result.click;
      if(witness.visible&&previousVisible===witness.identity&&result.visibleCompleteMs===null)result.visibleCompleteMs=observedAt-result.click;
      previousSource=witness.source?witness.identity:null;previousVisible=witness.visible?witness.identity:null;
      if(result.visibleCompleteMs!==null){finish(null);return;}
      frame=requestAnimationFrame(observe);
    }
    document.addEventListener('pointerdown',event=>{if(event.isTrusted&&event.target.closest?.(navigationSelector)&&result.pointerAt===null)result.pointerAt=event.timeStamp;},true);
    document.addEventListener('click',event=>{
      if(result.click!==null||!event.target.closest?.(navigationSelector))return;
      const now=performance.now();result.trusted=event.isTrusted;
      if(!event.isTrusted||!Number.isFinite(event.timeStamp)||event.timeStamp<0||event.timeStamp>now){finish('Untrusted click or unsupported event clock');return;}
      // Capture does not fabricate an earlier readiness mark if the observer missed it.
      result.click=event.timeStamp;result.capturedAt=now;result.clickTarget={selector:navigationSelector,testId:event.target.closest(navigationSelector).getAttribute("data-testid"),scrollY,rect:event.target.closest(navigationSelector).getBoundingClientRect().toJSON()};result.readyToClickMs=result.readyAt===null?null:event.timeStamp-result.readyAt;
      timer=setTimeout(()=>finish('Source-correct visible completion deadline exceeded'),budget.timeoutMs);
    },true);
    frame=requestAnimationFrame(observe);
  }
  try {
    // Preflight the already prepared fixture OUTSIDE all reload/click samples.
    const preflight=await page.evaluate(async()=>({metadata:await (await fetch('/arx-scanner-qa-build-info.json')).json(),runtime:window.__arxScannerQaBuildId,log:await window.__readFixtureLog()}));
    const metadata=preflight.metadata;
    if(preflight.runtime!==metadata.buildId||!metadata.sourceUnchanged||metadata.source.status||(expectedHead&&metadata.source.head!==expectedHead))throw Error('Unverified fixture source');
    const response=preflight.log.candleResponses.filter(r=>r.symbol==='EURUSD'&&r.timeframe==='M15').at(-1);
    if(!response||response.source!=='offline_fixture'||response.canonical.length!==200)throw Error('Expected fixture authority missing');
    const authority={symbol:'EURUSD',intervalSeconds:900,source:response.source,canonical:response.canonical};report.build=metadata;
    await page.addInitScript(install,{authority,budget,assessSource:assess.toString(),visibilitySource:plotVisible.toString()});
    for(const viewport of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]) {
      await page.setViewportSize({width:viewport.width,height:viewport.height});
      for(let index=0;index<5;index++) {
        const sample={viewport:viewport.name,index,failure:null};report.samples.push(sample);
        try {
          await page.goto(origin+'/',{waitUntil:'commit',timeout:15000});
          const navigationSelector=viewport.name==='mobile'?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]';
          if(budget.idleBeforeClickMs>0){await page.waitForFunction(()=>window.__arxFirstNavigation?.readyAt!==null&&window.__arxFirstNavigation?.readyAt!==undefined);await page.waitForTimeout(budget.idleBeforeClickMs);}
          await page.locator(navigationSelector).click({timeout:budget.timeoutMs});
          await page.waitForFunction(()=>window.__arxFirstNavigation?.done,null,{timeout:budget.timeoutMs+1000});
        } catch(error){sample.failure=String(error?.message??error);}
        const current=await page.evaluate(async()=>({timing:window.__arxFirstNavigation,timeOrigin:performance.timeOrigin,runtime:window.__arxScannerQaBuildId,log:await window.__readFixtureLog()}));
        const failure=sample.failure;Object.assign(sample,current.timing??{});if(failure)sample.failure=failure;
        sample.timeOrigin=current.timeOrigin;sample.buildMatches=current.runtime===metadata.buildId;
        const requests=current.log.requests.filter(r=>r.started>=current.timeOrigin&&r.path==='/api/chart/candles');
        sample.candleRequests=requests.map(r=>({...r,relativeToClick:sample.click===null?null:r.started-current.timeOrigin-sample.click}));
        const received=current.log.candleResponses.filter(r=>r.symbol==='EURUSD'&&r.timeframe==='M15').at(-1);
        sample.responseMatches=requests.length>0&&received?.source===authority.source&&JSON.stringify(received.canonical)===JSON.stringify(authority.canonical);
        const knownWrites=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];
        if(current.log.errors.length||current.log.blocked.some(r=>r.kind!=='mutation'||r.method!=='POST'||r.status!==503||!knownWrites.includes(r.path)))sample.failure='Page error, external request or unexpected write';
        sample.acceptance=acceptSample(sample,budget);
      }
    }
    report.network=await page.evaluate(()=>window.__readFixtureLog());
    report.summary=['desktop','mobile'].map(viewport=>{
      const all=report.samples.filter(s=>s.viewport===viewport),valid=all.filter(s=>s.acceptance.valid),times=valid.map(s=>s.visibleCompleteMs).sort((a,b)=>a-b);
      return {viewport,planned:5,recorded:all.length,valid:valid.length,meets100ms:valid.filter(s=>s.acceptance.meetsTarget).length,successfulTimingDistributionOnly:true,
        medianMs:times.length?times[Math.floor(times.length/2)]:null,maxMs:times.at(-1)??null,failedIndices:all.filter(s=>!s.acceptance.valid).map(s=>s.index)};
    });
    report.passed=report.samples.length===10&&report.samples.every(s=>s.acceptance.meetsTarget);
  } catch(error){report.failure=String(error?.stack??error);}
  return report;
}
)(page);
}