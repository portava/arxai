async page => {
 function resolveFixtureRole(value) {
  if(value===undefined)return 'USER';
  if(value==='USER'||value==='ADMIN')return value;
  throw Error('Offline fixture role must be USER or ADMIN');
 }
 const fixtureRole=resolveFixtureRole(typeof SCANNER_QA_ROLE==='undefined'?undefined:SCANNER_QA_ROLE);
 const requests=[],unknown=[],blocked=[],errors=[],consoleErrors=[],candleResponses=[];
 const origin=typeof SCANNER_QA_BASE_URL==='string'?SCANNER_QA_BASE_URL:'http://127.0.0.1:4199';
 if(new URL(origin).hostname!=='127.0.0.1')throw Error('Offline fixture requires loopback');
 if(page.context().serviceWorkers().length)throw Error('Use a fresh browser session without service workers');
 let fixtureSource='offline_fixture',fixtureIdentity='synthetic-history-A';
 await page.exposeFunction('__fixtureSwitchSource', config => {fixtureSource=config.source;fixtureIdentity=config.identity;return true;});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error') consoleErrors.push(m.text());});
 await page.exposeFunction('__readFixtureLog',()=>({fixtureRole,requests,unknown,blocked,errors,consoleErrors,candleResponses}));
 await page.context().routeWebSocket('**/*',ws=>{blocked.push({kind:'websocket',url:ws.url()});ws.close();});
 await page.addInitScript(()=>{
  localStorage.clear();
  sessionStorage.clear();
  if(navigator.serviceWorker)navigator.serviceWorker.register=async()=>{throw Error('Service workers disabled for offline QA');};
  localStorage.setItem('highroll.chartSymbol','EURUSD');
  localStorage.setItem('highroll.onboarding.firstrun.dismissed.v1','1');
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
