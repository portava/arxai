// Run shared-chart-setup.js first in a fresh offline browser session.
// Unlike the earlier navigation probe, no metadata or OHLC reads delay the click.
async page => {
  const origin='http://127.0.0.1:4199';
  if(new URL(page.url()).origin!==origin)throw Error('Offline loopback fixture required');
  const expectedHead=typeof SCANNER_QA_EXPECTED_COMMIT==='string'?SCANNER_QA_EXPECTED_COMMIT:null;
  const budget={clickAfterReadyMs:150,completionMs:100,timeoutMs:8000};
  const report={schemaVersion:2,passed:false,build:null,samples:[],failure:null,budget,
    method:{start:'Trusted click event.timeStamp. First actionable navigation link is observed in-page from document initialization.',
      completion:'Exact canonical AND displayed OHLC, source, symbol, interval and real series identity match on two consecutive rendering frames. Visible completion additionally requires 100x100 viewport intersection and five unobscured plot hit-test points.',
      click:'After document commit, immediately issue the visible Scanner-link click. No metadata fetch, screenshot, readback or intentional hover dwell precedes it.',
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
  function acceptSample(sample,budget) {
    const errors=[];
    if(sample.failure)errors.push(sample.failure);
    if(sample.trusted!==true||!Number.isFinite(sample.click)||sample.click<0)errors.push('No trusted valid-clock Scanner click');
    if(!Number.isFinite(sample.readyAt)||!Number.isFinite(sample.readyToClickMs)||sample.readyToClickMs<0||sample.readyToClickMs>budget.clickAfterReadyMs)errors.push('Not an immediate first actionable click');
    if(!Number.isFinite(sample.sourceCompleteMs)||!Number.isFinite(sample.visibleCompleteMs)||sample.sourceCompleteMs<0||sample.visibleCompleteMs<sample.sourceCompleteMs)errors.push('Source-correct visible completion not proven');
    if(!sample.responseMatches||!sample.buildMatches)errors.push('Response or executing build not verified');
    return {valid:errors.length===0,meetsTarget:errors.length===0&&sample.visibleCompleteMs<=budget.completionMs,errors};
  }
  function install({authority,budget,assessSource}) {
    const assess=(0,eval)('('+assessSource+')');
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
      const canvas=document.querySelector('[data-testid="arx-native-canvas"]');
      if(canvas&&result.canvasMs===null)result.canvasMs=now-result.click;
      let unobscured=false;
      if(canvas){const b=canvas.getBoundingClientRect(),left=Math.max(0,b.x),right=Math.min(innerWidth,b.right),top=Math.max(0,b.y),bottom=Math.min(innerHeight,b.bottom),x=(left+right)/2,y=(top+bottom)/2;unobscured=right-left>=100&&bottom-top>=100&&[[x,y],[x-49,y-49],[x+49,y-49],[x-49,y+49],[x+49,y+49]].every(([px,py])=>{const hit=document.elementFromPoint(px,py);return canvas===hit||canvas.contains(hit);});}
      const before=performance.now();
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
    await page.addInitScript(install,{authority,budget,assessSource:assess.toString()});
    for(const viewport of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]) {
      await page.setViewportSize({width:viewport.width,height:viewport.height});
      for(let index=0;index<5;index++) {
        const sample={viewport:viewport.name,index,failure:null};report.samples.push(sample);
        try {
          await page.goto(origin+'/',{waitUntil:'commit',timeout:15000});
          const navigationSelector=viewport.name==='mobile'?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]';
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
