async page => {
  // Run shared-chart-setup.js first in a fresh isolated session, then this file.
  // Only the existing offline production fixture is supported. This script does
  // not start a server/build, change route interception, or click order controls.
  // Optional SCANNER_QA_EXPECTED_COMMIT binds the build to the requested source.
  const REPS=40,PASSES=2,WARMUPS=2,TARGET_MS=100,TIMEOUT_MS=5000,MAX_RUN_MS=120000;
  const result={schemaVersion:1,verdict:'FAIL',build:null,runs:[],failure:null,
    samplePlan:{repsPerPass:REPS,passes:PASSES,warmupPairsPerPass:WARMUPS,cpuRates:[1,4],maxRunMs:MAX_RUN_MS},
    targetCompletedOpportunityP95Ms:TARGET_MS,
    method:{start:'Trusted click event timestamp; style starts at trusted native change (selection commit), excluding menu navigation.',
      acknowledgement:'Input captured; optional DOM control-state acknowledgment. Zoom/pan buttons have no persistent state, so their control acknowledgment is null.',
      completion:'Exact canonical/display data, engine/source, and intended logical range or style/disclosure, observed correct across two consecutive animation frames.',
      opportunity:'The second consecutive successful animation frame; not hardware paint, pixel presentation or 60fps.',
      overhead:'Full 200-bar canonical/display observation is included in measured time; witness cost is reported without subtracting it.',
      setup:'Untrusted selectOption may establish a style origin or recover candles outside measured actions; it never supplies a measured sample.',
      environment:'Actual Scanner route/providers, minified production fixture, offline historical synthetic bars. Periodic app reads remain active and are logged.'},
    limitations:['Native style timing excludes opening/navigating the native selection menu.','Unavailable AI truth: active automatic-analysis performance is not measured.',
      'No broker, real feed, network latency, equivalent-condition TradingView/MT5 comparison, or architecture-completion claim.',
      '80 measured observations/control/CPU condition; nearest-rank p99 is the sample maximum. All warmups, failures and slow samples remain in the report.']};
  function stats(values) {
    const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
    const q=p=>sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;
    return {n:sorted.length,p50:q(.5),p95:q(.95),p99:q(.99),max:sorted.at(-1)??null};
  }
  function summarizeControl(allSamples,control,expectedSamples,target,controlFailure=null) {
    const samples=allSamples.filter(s=>s.record&&s.control===control);
    const success=samples.filter(s=>s.trusted===true&&!s.failure&&Number.isFinite(s.completedOpportunityMs)&&s.completedOpportunityMs>=0);
    const item={control,expectedSamples,recordedSamples:samples.length,failedSamples:samples.length-success.length,controlFailure,
      inputCaptured:stats(samples.map(s=>s.inputCapturedMs)),controlAcknowledgement:stats(samples.map(s=>s.controlAcknowledgementMs)),
      actualState:stats(success.map(s=>s.actualStateMs)),completedOpportunity:stats(success.map(s=>s.completedOpportunityMs)),witnessCost:stats(samples.map(s=>s.witnessCostMs)),
      captureToActualState:stats(success.map(s=>s.captureToActualStateMs)),captureToCompletedOpportunity:stats(success.map(s=>s.captureToCompletedOpportunityMs)),
      outlierSampleIds:samples.filter(s=>!success.includes(s)||s.completedOpportunityMs>target).map(s=>s.id),successfulTimingDistributionOnly:true};
    item.meetsTarget=!controlFailure&&samples.length===expectedSamples&&success.length===samples.length&&item.completedOpportunity.p95!==null&&item.completedOpportunity.p95<=target;
    return item;
  }
  async function performWithStyleIsolation(spec,run,perform,recover) {
    const previous=run.controlFailures.find(f=>f.control===spec.control);
    if(previous){run.skippedActions.push({control:spec.control,pass:spec.pass,rep:spec.rep,record:spec.record,reason:previous.reason});return;}
    try{await perform();}
    catch(error){
      if(spec.kind!=='style')throw error; // Do not mask an application/navigation failure.
      const proof=await recover();
      run.controlFailures.push({control:spec.control,pass:spec.pass,rep:spec.rep,record:spec.record,reason:String(error?.stack??error),...proof});
    }
  }
  // Self-contained because Playwright serializes this function into the page.
  function installSampler() {
    window.__scannerLatency?.dispose?.();
    const state=window.__scannerLatency={armed:null,inFlight:null,samples:[],longTasks:[],inputAttempts:[],longTasksUnsupported:false};
    const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<.002;
    function assessCompletion(arm,current,controls) {
      const before=arm.before,state=current?.state,data=current?.data;
      if(!state||!data||!Array.isArray(data.canonical)||!Array.isArray(data.display))return {pass:false,reason:'adapter observation unavailable'};
      for(const key of ['adapterId','containerId','chartId','symbol','intervalSeconds','barCount'])if(state[key]!==before.state[key])return {pass:false,reason:'engine/context changed: '+key};
      if(!equal(state.canvasIds,before.state.canvasIds)||!equal(state.feed,before.state.feed))return {pass:false,reason:'canvas/source changed'};
      if(!equal(data.canonical,arm.authority))return {pass:false,reason:'canonical source data changed'};
      if(!equal(data.display.map(p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close})),arm.authority))return {pass:false,reason:'displayed OHLC differs from source'};
      if(!state.range||!before.state.range)return {pass:false,reason:'logical range missing'};
      const range=state.range,old=before.state.range,width=old.to-old.from,nowWidth=range.to-range.from;
      if(!(width>0&&nowWidth>0))return {pass:false,reason:'invalid logical range'};
      if(arm.kind!=='tools') {
        const b=state.bounds,v=arm.viewport;
        if(!b||!v||Math.min(b.x+b.width,v.width)-Math.max(b.x,0)<100||Math.min(b.y+b.height,v.height)-Math.max(b.y,0)<100)return {pass:false,reason:'plot lacks 100x100 viewport intersection'};
      }
      if(arm.kind==='zoom') {
        if(state.style!==before.state.style||state.seriesId!==before.state.seriesId)return {pass:false,reason:'navigation changed price series'};
        if(!close(nowWidth,width*arm.factor)||!close(range.from+range.to,old.from+old.to))return {pass:false,reason:'requested zoom range pending'};
      } else if(arm.kind==='pan') {
        if(state.style!==before.state.style||state.seriesId!==before.state.seriesId)return {pass:false,reason:'navigation changed price series'};
        if(!close(nowWidth,width)||!close(range.from,old.from+width*arm.fraction)||!close(range.to,old.to+width*arm.fraction))return {pass:false,reason:'requested pan range pending'};
      } else {
        if(!close(range.from,old.from)||!close(range.to,old.to))return {pass:false,reason:'non-navigation action changed range'};
        if(arm.kind==='style') {
          if(state.style!==arm.style||state.seriesId===before.state.seriesId||controls.style!==arm.style)return {pass:false,reason:'requested real price-series replacement pending'};
        } else if(arm.kind==='tools') {
          if(state.style!==before.state.style||state.seriesId!==before.state.seriesId)return {pass:false,reason:'disclosure changed series'};
          if(!controls.associated||!controls.total||controls.expanded!==arm.expanded||controls.visible!==arm.expanded||(arm.expanded&&(!controls.visibleOnscreen||!controls.styleVisible||!controls.studiesVisible)))return {pass:false,reason:'disclosure DOM/descendant geometry pending'};
        } else return {pass:false,reason:'unknown action'};
      }
      return {pass:true,sourceRevisionChanged:state.dataRevision!==before.state.dataRevision,canonicalIdentityChanged:state.candlesId!==before.state.candlesId};
    }
    function controlsSnapshot() {
      const card=document.querySelector('[data-testid="scanner-chart-panel"] [data-testid="arx-native-chart"]');
      const panel=card?.querySelector('[data-testid="chart-advanced-tools"]'),button=card?.querySelector('button[aria-label="Chart tools"]');
      const controls=panel?[...panel.querySelectorAll('button,input,select,textarea,[tabindex]')]:[];
      // Expanded panel is display:contents and has no own box.
      const visible=controls.filter(c=>{const r=c.getBoundingClientRect(),s=getComputedStyle(c);return c.getClientRects().length&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&Number(s.opacity)!==0;});
      return {style:card?.querySelector('select[aria-label="Chart style"]')?.value,
        associated:!!panel?.id&&button?.getAttribute('aria-controls')===panel.id,expanded:button?.getAttribute('aria-expanded')==='true',total:controls.length,visible:visible.length>0,
        styleVisible:visible.includes(panel?.querySelector('select[aria-label="Chart style"]')),
        studiesVisible:visible.some(c=>c.tagName==='BUTTON'&&/^Studies \(/.test(c.textContent?.trim()??'')),
        visibleOnscreen:visible.some(c=>{const r=c.getBoundingClientRect();return r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;})};
    }
    const observe=()=>({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()});
    const finish=(sample,failure)=>{if(state.inFlight!==sample)return;clearTimeout(sample.timer);delete sample.timer;sample.failure=failure??null;state.samples.push(sample);state.inFlight=null;};
    const capture=event=>{
      const arm=state.armed;
      if(arm?.kind==='style'&&['keydown','keyup','change','input'].includes(event.type)&&event.target.closest?.(arm.selector))state.inputAttempts.push({sampleId:arm.id,type:event.type,key:event.key??null,value:event.target.value,trusted:event.isTrusted,eventTimeStamp:event.timeStamp,capturedAt:performance.now()});
      if(!arm||event.type!==arm.event||!event.isTrusted||!event.target.closest?.(arm.selector))return;
      if(arm.kind==='style'&&event.target.value!==arm.style)return;
      state.armed=null;
      const captured=performance.now(),validStamp=Number.isFinite(event.timeStamp)&&event.timeStamp>=0&&event.timeStamp<=captured;
      const start=validStamp?event.timeStamp:captured;
      const sample={id:arm.id,control:arm.control,cpuRate:arm.cpuRate,pass:arm.pass,rep:arm.rep,record:arm.record,kind:arm.kind,event:event.type,trusted:true,
        start,eventTimeStamp:event.timeStamp,capturedAt:captured,clock:validStamp?'event.timeStamp':'capture-fallback',inputCapturedMs:captured-start,controlAcknowledgementMs:null,actualStateMs:null,completedOpportunityMs:null,captureToActualStateMs:null,captureToCompletedOpportunityMs:null,
        witnessCostMs:0,frames:0,sourceRevisionChanged:false,canonicalIdentityChanged:false,lastWitness:null,lastSnapshot:null,failure:null};
      state.inFlight=sample;
      if(!validStamp){finish(sample,'unsupported input event clock');return;}
      // Timer records stalled/rAF-starved failures too. It cannot make a sample pass.
      sample.timer=setTimeout(()=>finish(sample,'completion deadline exceeded'),arm.timeoutMs);
      let priorSuccessFrame=null;
      const poll=()=>{
        if(state.inFlight!==sample)return;
        if(performance.now()-start>=arm.timeoutMs){finish(sample,'completion deadline exceeded');return;}
        sample.frames++;
        const began=performance.now(),controls=controlsSnapshot(),current=observe();
        const witness=assessCompletion(arm,current,controls);
        sample.witnessCostMs+=performance.now()-began;sample.lastWitness=witness;sample.lastSnapshot=current;
        if(sample.controlAcknowledgementMs===null&&((arm.kind==='style'&&controls.style===arm.style)||(arm.kind==='tools'&&controls.expanded===arm.expanded)))sample.controlAcknowledgementMs=performance.now()-start;
        sample.sourceRevisionChanged ||= witness.sourceRevisionChanged===true;
        sample.canonicalIdentityChanged ||= witness.canonicalIdentityChanged===true;
        if(witness.pass) {
          if(sample.actualStateMs===null){const now=performance.now();sample.actualStateMs=now-start;sample.captureToActualStateMs=now-captured;}
          if(priorSuccessFrame!==null&&sample.frames===priorSuccessFrame+1) {
            const now=performance.now();sample.completedOpportunityMs=now-start;sample.captureToCompletedOpportunityMs=now-captured;finish(sample,null);return;
          }
          priorSuccessFrame=sample.frames;
        } else priorSuccessFrame=null;
        if(performance.now()-start>=arm.timeoutMs){finish(sample,witness.reason??'completion timeout');return;}
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    };
    for(const event of ['click','change','input','keydown','keyup'])window.addEventListener(event,capture,true);
    let observer;
    try{observer=new PerformanceObserver(list=>state.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));observer.observe({type:'longtask',buffered:true});}catch{state.longTasksUnsupported=true;}
    state.cancelPending=reason=>{if(state.inFlight)finish(state.inFlight,reason);state.armed=null;};
    state.dispose=()=>{for(const event of ['click','change','input','keydown','keyup'])window.removeEventListener(event,capture,true);observer?.disconnect();if(state.inFlight)finish(state.inFlight,'sampler disposed while pending');};
    state.assessCompletion=assessCompletion;
  }
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const cdp=await page.context().newCDPSession(page);
  let sequence=0;
  const plans=[{name:'desktop',viewport:{width:1440,height:1100},controls:['Zoom in','Zoom out','Pan earlier','Pan later','Style bars','Style candles']},
    {name:'mobile',viewport:{width:390,height:844},controls:['Open Tools','Close Tools']}];
  try {
    check(new URL(page.url()).hostname==='127.0.0.1'&&new URL(page.url()).pathname==='/market-scanner','Run offline Scanner setup first');
    for(const cpuRate of [1,4])for(const plan of plans) {
      const run={name:plan.name,cpuRate,viewport:plan.viewport,startedAt:new Date().toISOString(),verdict:'FAIL',samples:[],summary:[],controlFailures:[],skippedActions:[],failure:null,pendingSample:null};
      result.runs.push(run);const wallStart=Date.now();
      try {
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});await page.setViewportSize(plan.viewport);await page.reload();
        await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount>0);
        const metadata=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('Build metadata unavailable');return r.json();});
        const runtimeId=await page.evaluate(()=>window.__arxScannerQaBuildId);
        check(runtimeId===metadata.buildId&&metadata.minified&&metadata.productionRuntimeChecked&&metadata.dashboardUtilityCss&&metadata.sourceUnchanged&&!metadata.source.status,'Unverified executed production fixture build');
        if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(metadata.source.head===SCANNER_QA_EXPECTED_COMMIT,'Unexpected commit');
        if(result.build)check(result.build.buildId===metadata.buildId,'Build changed between runs');result.build=metadata;
        run.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,timeOrigin:performance.timeOrigin,visibility:document.visibilityState,hasFocus:document.hasFocus()}));
        check(run.environment.visibility==='visible','Page is hidden');
        const panel=page.getByTestId('scanner-chart-panel'),button=name=>panel.getByRole('button',{name,exact:true});
        check(await panel.getByTestId('arx-native-chart').count()===1&&await page.locator('iframe,embed,object').count()===0,'Not the single native Scanner chart');
        await panel.getByTestId('arx-native-tf-M15').click();
        const tools=button('Chart tools');if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
        const style=panel.getByLabel('Chart style',{exact:true});await style.selectOption('candles');
        await button('Fit history').click();await frames();await button('Zoom in chart').click();await frames();await button('Zoom in chart').click();await frames();
        const log=await page.evaluate(()=>window.__readFixtureLog());
        const initial=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
        const expected=log.candleResponses.filter(r=>r.symbol===initial.state.symbol&&r.timeframe==='M15').at(-1);
        check(initial.state.symbol==='EURUSD'&&initial.state.intervalSeconds===900&&initial.state.style==='candles'&&initial.state.feed.source==='offline_fixture'&&initial.state.feed.livePriceAffordance===false,'Unexpected Scanner workload');
        check(expected&&JSON.stringify(initial.data.canonical)===JSON.stringify(expected.canonical),'Initial actual bars do not match response');
        check(initial.data.canonical.length===200,'Expected exactly200 synthetic bars');
        run.authority=expected;run.before=initial;
        if(plan.name==='mobile'&&await tools.getAttribute('aria-expanded')==='true')await tools.click();
        await page.evaluate(()=>document.fonts.ready);await frames();await page.evaluate(installSampler);
        const act=async(spec,pass,rep)=>{
          check(Date.now()-wallStart<MAX_RUN_MS,'Run time budget exceeded; remaining samples not attempted');
          if(spec.kind==='style') {
            const origin=spec.style==='bars'?'candles':'bars';
            // A failed opposite direction must not make this direction a no-op.
            // This preparation is explicitly outside the measured trusted input.
            if(await style.inputValue()!==origin)await style.selectOption(origin);
            await page.waitForFunction(origin=>window.__arxChartQa.snapshot()?.style===origin,origin);await frames();
          }
          const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
          const arm={...spec,id:++sequence,cpuRate,pass,rep,record:rep>=WARMUPS,timeoutMs:TIMEOUT_MS,viewport:plan.viewport,before,authority:expected.canonical};
          run.pendingSample=arm;
          await page.evaluate(arm=>{const s=window.__scannerLatency;if(s.armed||s.inFlight)throw Error('Prior sample still pending');s.armed=arm;},arm);
          if(spec.kind==='style') {
            await style.focus();
            // Native trusted selection. Chrome/macOS may first open a popup;
            // Enter commits it. Timing begins only at the expected change event.
            await page.keyboard.press(spec.style==='bars'?'ArrowDown':'Home');
            await page.keyboard.press('Enter');
          } else await button(spec.button).click();
          await page.waitForFunction(id=>window.__scannerLatency.samples.some(s=>s.id===id),arm.id,{timeout:TIMEOUT_MS+2000});
          const sample=await page.evaluate(id=>window.__scannerLatency.samples.find(s=>s.id===id),arm.id);
          run.pendingSample=null;check(!sample.failure,spec.control+': '+sample.failure);
        };
        for(let pass=1;pass<=PASSES;pass++)for(let rep=0;rep<WARMUPS+REPS;rep++) {
          const actions=plan.name==='mobile'?[{control:'Open Tools',kind:'tools',button:'Chart tools',expanded:true},{control:'Close Tools',kind:'tools',button:'Chart tools',expanded:false}]:[
            {control:'Zoom in',kind:'zoom',button:'Zoom in chart',factor:.75},{control:'Zoom out',kind:'zoom',button:'Zoom out chart',factor:4/3},
            {control:'Pan earlier',kind:'pan',button:'Pan to earlier candles',fraction:-.25},{control:'Pan later',kind:'pan',button:'Pan to later candles',fraction:.25},
            {control:'Style bars',kind:'style',style:'bars'},{control:'Style candles',kind:'style',style:'candles'}];
          for(const spec of actions) {
            const action={...spec,event:spec.kind==='style'?'change':'click',selector:spec.kind==='style'?'[data-testid="scanner-chart-panel"] select[aria-label="Chart style"]':`[data-testid="scanner-chart-panel"] button[aria-label="${spec.button}"]`};
            await performWithStyleIsolation({...action,pass,rep,record:rep>=WARMUPS},run,()=>act(action,pass,rep),async()=>{
              const proof=await page.evaluate(()=>{const s=window.__scannerLatency;return{pendingArm:s.armed,inFlight:s.inFlight?{...s.inFlight,timer:undefined}:null,inputAttempts:s.inputAttempts.filter(e=>e.sampleId===s.armed?.id||e.sampleId===s.inFlight?.id),current:{state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}};});
              proof.pendingSample=run.pendingSample;
              proof.kind=proof.pendingArm&&!proof.inFlight?'trusted selection change was not observed':'observed style did not complete correctly';
              await page.evaluate(()=>window.__scannerLatency.cancelPending('style control failed; evidence retained'));
              run.pendingSample=null;
              await page.keyboard.press('Escape');await style.selectOption('candles');
              await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.style==='candles');await frames();
              return proof;
            });
          }
        }
        run.verdict='PASS';
      } catch(error) {run.failure=String(error?.stack??error);}
      finally {
        const observed=await page.evaluate(()=>{const s=window.__scannerLatency;return {samples:s?.samples??[],inFlight:s?.inFlight?{...s.inFlight,timer:undefined}:null,pendingArm:s?.armed??null,inputAttempts:s?.inputAttempts??[],longTasks:s?.longTasks??[],longTasksUnsupported:s?.longTasksUnsupported??true};}).catch(()=>({samples:[],observationUnavailable:true}));
        Object.assign(run,observed);run.after=await page.evaluate(()=>({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()})).catch(()=>null);
        for(const control of plan.controls) {
          const item=summarizeControl(run.samples,control,REPS*PASSES,TARGET_MS,run.controlFailures.find(f=>f.control===control)?.kind??null);
          item.skippedMeasuredActions=run.skippedActions.filter(a=>a.record&&a.control===control).length;
          run.summary.push(item);if(!item.meetsTarget)run.verdict='FAIL';
        }
        if(run.failure||run.inFlight||run.pendingArm||run.pendingSample||run.controlFailures.length)run.verdict='FAIL';
        await page.evaluate(()=>window.__scannerLatency?.dispose?.()).catch(()=>{});
      }
    }
    result.network=await page.evaluate(()=>window.__readFixtureLog());
    const permittedBlocked=new Set(['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus']);
    result.unexpectedRequests=result.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!permittedBlocked.has(r.path)||r.status!==503);
    result.verdict=result.runs.length===4&&result.runs.every(r=>r.verdict==='PASS')&&!result.network.errors.length&&!result.unexpectedRequests.length?'PASS':'FAIL';
  } catch(error) {result.failure=String(error?.stack??error);}
  finally {await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
  return result; // Inspect verdict; successful CLI transport is not PASS.
}
