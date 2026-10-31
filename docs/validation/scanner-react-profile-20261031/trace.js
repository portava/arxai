async page => {
 const cdp=await page.context().newCDPSession(page);let trace=null,tracing=false;
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const request=new Proxy(page.request,{get(target,key){
  if(key==='post')return async (...args)=>{
   const response=await target.post(...args);const event=args[1]?.data?.event;
   if(event?.kind==='attempt'&&event.ordinal===0){await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.stack',transferMode:'ReturnAsStream'});tracing=true;}
   if(event?.kind==='result'&&event.ordinal===0){
    const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await done;tracing=false;
    let data='';while(true){const chunk=await cdp.send('IO.read',{handle:stream,size:65536});if(chunk.base64Encoded)throw Error('Unexpected encoded trace');data+=chunk.data;if(chunk.eof)break;}
    await cdp.send('IO.close',{handle:stream});trace=JSON.parse(data);
   }
   return response;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const isolated=new Proxy(page,{get(target,key){if(key==='request')return request;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 try {const measure=(// Run shared-chart-setup.js first in a fresh offline browser session.
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
  const report={schemaVersion:3,passed:false,build:null,samples:[],failure:null,budget,
    method:{scenario:budget.idleBeforeClickMs===0?'immediate first actionable click':`first click after explicit ${budget.idleBeforeClickMs}ms idle dwell; NOT immediate-click acceptance`,start:'Trusted click event.timeStamp. First actionable navigation link is observed in-page from document initialization.',
      completion:'Exact canonical AND displayed OHLC, source, symbol, interval and real series identity match on two consecutive rendering frames. Visible completion additionally requires 100x100 viewport intersection and five unobscured plot hit-test points.',
      click:budget.idleBeforeClickMs===0?'After document commit, immediately issue the visible Scanner-link click. No metadata fetch, screenshot, readback or intentional hover dwell precedes it.':`After navigation becomes visible, wait ${budget.idleBeforeClickMs}ms without hovering, then click. This distinct idle-warmed scenario must not be mixed with immediate clicks.`,
      cache:'Full-document route reloads with intercepted requests (HTTP cache disabled by Playwright routing). Initial fixture preparation primes browser resources; this is not cold browser-process startup.',
      failures:'Every planned attempt remains. A blocked or late click, missing response, incorrect series or offscreen chart cannot pass. Successful timing distributions are labelled separately.'},
    limitations:['Offline historical synthetic bars and fixed 80ms candle response delay; no provider, published app or broker measurement.',
      'Two rendering opportunities are not hardware paint. Full OHLC witness cost is included, never subtracted.',
      'Desktop/mobile viewports are browser emulation, not physical devices. Active AI analysis remains unavailable.',
      'Navigation controls are already exposed on both sizes; no drawer opening or forced DOM click is substituted.',
      'Fixture journal flushes occur before navigation and after evidence collection, outside measured clicks. An interrupted pending attempt is retained as incomplete.',
      'Resource responseEnd is browser network completion, not JSON parsing or React query-cache readiness. Long tasks and frame gaps show overlap, not causation.']};
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
    const diagnostic={longTasks:[],frameGaps:[],linkChanges:[],droppedLongTasks:0,droppedFrameGaps:0,droppedLinkChanges:0};
    let longTaskObserver=null,lastFrame=null,lastLink=null;
    const bounded=(key,value)=>{if(diagnostic[key].length<200)diagnostic[key].push(value);else diagnostic['dropped'+key[0].toUpperCase()+key.slice(1)]++;};
    const recordTasks=entries=>entries.forEach(e=>bounded('longTasks',{startTime:e.startTime,duration:e.duration,name:e.name}));
    try {longTaskObserver=new PerformanceObserver(list=>recordTasks(list.getEntries()));longTaskObserver.observe({type:'longtask',buffered:true});diagnostic.longTaskSupported=true;}
    catch {diagnostic.longTaskSupported=false;}
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
    function finish(failure) {
      if(result.done)return;
      result.failure=failure;result.done=true;cancelAnimationFrame(frame);clearTimeout(timer);
      if(longTaskObserver){recordTasks(longTaskObserver.takeRecords());longTaskObserver.disconnect();}
      const resources=performance.getEntriesByType('resource').filter(e=>{const u=new URL(e.name);return u.origin===location.origin&&(u.pathname==='/api/chart/candles'||/\.(js|css)$/.test(u.pathname));});
      diagnostic.resources=resources.slice(0,200).map(e=>({url:new URL(e.name).pathname+new URL(e.name).search,initiatorType:e.initiatorType,startTime:e.startTime,responseStart:e.responseStart,responseEnd:e.responseEnd,duration:e.duration,transferSize:e.transferSize}));
      diagnostic.droppedResources=Math.max(0,resources.length-200);
      result.diagnostics=diagnostic;
    }
    function observe() {
      if(result.done)return;
      const now=performance.now();
      if(lastFrame!==null&&now-lastFrame>25)bounded('frameGaps',{startTime:lastFrame,duration:now-lastFrame});lastFrame=now;
      const link=actionableLink(),rect=link?.getBoundingClientRect();
      const linkState=rect?`${rect.x},${rect.y},${rect.width},${rect.height}`:'unavailable';
      if(linkState!==lastLink){bounded('linkChanges',{at:now,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null});lastLink=linkState;}
      if(result.readyAt===null&&link)result.readyAt=now;
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
    const endpoint=origin+'/__arx-qa/navigation-journal';
    const journalResponse=await page.request.get(endpoint,{timeout:5000});
    if(!journalResponse.ok())throw Error('Durable fixture journal unavailable');
    const journal=await journalResponse.json();
    if(journal.schemaVersion!==1||journal.buildId!==metadata.buildId||journal.sourceHead!==metadata.source.head)throw Error('Journal source mismatch');
    const checkpoint=async event=>{
      const response=await page.request.post(endpoint,{headers:{'x-arx-qa-token':journal.token,'content-type':'application/json'},data:{runId:report.journal?.runId,event},timeout:5000});
      if(!response.ok())throw Error('Journal write failed: '+await response.text());
      const receipt=await response.json();report.journal={...receipt,directory:metadata.buildId+'-navigation-receipts'};
    };
    report.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,performanceTimeOrigin:performance.timeOrigin}));
    report.environment.cpuThrottle='Not set by this harness; outer runner/host settings must be recorded separately';
    report.environment.browserVersion=await page.context().browser()?.version()??null;
    await checkpoint({kind:'start',planned:10,budget,method:report.method,environment:report.environment});
    await page.addInitScript(install,{authority,budget,assessSource:assess.toString(),visibilitySource:plotVisible.toString()});
    for(const viewport of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]) {
      await page.setViewportSize({width:viewport.width,height:viewport.height});
      for(let index=0;index<5;index++) {
        const sample={viewport:viewport.name,index,failure:null};report.samples.push(sample);
        const ordinal=report.samples.length-1;
        await checkpoint({kind:'attempt',ordinal,viewport:viewport.name,index});
        sample.runner={navigationIssuedAt:Date.now()};
        try {
          await page.goto(origin+'/',{waitUntil:'commit',timeout:15000});
          sample.runner.navigationCommittedAt=Date.now();
          const navigationSelector=viewport.name==='mobile'?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]';
          if(budget.idleBeforeClickMs>0){await page.waitForFunction(()=>window.__arxFirstNavigation?.readyAt!==null&&window.__arxFirstNavigation?.readyAt!==undefined);await page.waitForTimeout(budget.idleBeforeClickMs);}
          sample.runner.clickIssuedAt=Date.now();
          await page.locator(navigationSelector).click({timeout:budget.timeoutMs});
          sample.runner.clickReturnedAt=Date.now();
          await page.waitForFunction(()=>window.__arxFirstNavigation?.done,null,{timeout:budget.timeoutMs+1000});
        } catch(error){sample.failure=String(error?.message??error);}
        const current=await page.evaluate(async()=>({timing:window.__arxFirstNavigation,timeOrigin:performance.timeOrigin,runtime:window.__arxScannerQaBuildId,log:await window.__readFixtureLog()}));
        const failure=sample.failure;Object.assign(sample,current.timing??{});if(failure)sample.failure=failure;
        sample.timeOrigin=current.timeOrigin;sample.buildMatches=current.runtime===metadata.buildId;
        const requests=current.log.requests.filter(r=>r.started>=current.timeOrigin&&r.path==='/api/chart/candles');
        sample.candleRequests=requests.map(r=>({...r,endedMeaning:'Mock response preparation, before route.fulfill; NOT browser receipt',relativeToClick:sample.click===null?null:r.started-current.timeOrigin-sample.click}));
        const received=current.log.candleResponses.filter(r=>r.symbol==='EURUSD'&&r.timeframe==='M15').at(-1);
        sample.responseMatches=requests.length>0&&received?.source===authority.source&&JSON.stringify(received.canonical)===JSON.stringify(authority.canonical);
        const knownWrites=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];
        if(current.log.errors.length||current.log.blocked.some(r=>r.kind!=='mutation'||r.method!=='POST'||r.status!==503||!knownWrites.includes(r.path)))sample.failure='Page error, external request or unexpected write';
        sample.acceptance=acceptSample(sample,budget);
        sample.networkCounts={requests:current.log.requests.length,unknown:current.log.unknown.length,blocked:current.log.blocked.length,pageErrors:current.log.errors.length,consoleErrors:current.log.consoleErrors.length};
        await checkpoint({kind:'result',ordinal,sample});
      }
    }
    report.network=await page.evaluate(()=>window.__readFixtureLog());
    report.summary=['desktop','mobile'].map(viewport=>{
      const all=report.samples.filter(s=>s.viewport===viewport),valid=all.filter(s=>s.acceptance.valid),times=valid.map(s=>s.visibleCompleteMs).sort((a,b)=>a-b);
      return {viewport,planned:5,recorded:all.length,valid:valid.length,meets100ms:valid.filter(s=>s.acceptance.meetsTarget).length,successfulTimingDistributionOnly:true,
        medianMs:times.length?times[Math.floor(times.length/2)]:null,maxMs:times.at(-1)??null,failedIndices:all.filter(s=>!s.acceptance.valid).map(s=>s.index)};
    });
    report.passed=report.samples.length===10&&report.samples.every(s=>s.acceptance.meetsTarget);
    await checkpoint({kind:'complete',passed:report.passed,summary:report.summary});
  } catch(error){report.passed=false;report.failure=String(error?.stack??error);}
  return report;
}
);const report=await measure(isolated);return {diagnosticOnly:true,controlledCpuThrottle:4,tracedSample:'desktop0',report,trace};}
 finally {if(tracing)await cdp.send('Tracing.end');await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
}