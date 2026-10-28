async outer => {
  // Returns a verdict and all samples even on failure. The caller MUST inspect
  // verdict; a successful Playwright transport/exit is not a benchmark PASS.
  const base = typeof CHART_QA_BASE_URL === 'string' ? CHART_QA_BASE_URL : 'http://127.0.0.1:4179';
  const REPS = 40, PASSES = 2, WARMUP = 2, LIMIT_MS = 100, TIMEOUT_MS = 5000;
  const result = {schemaVersion:1,verdict:'FAIL',base,viewport:{width:390,height:844},
    method:'Trusted click capture; second-rAF feedback and source-preserving disclosure completion followed by a further animation frame. Rendering opportunity, not hardware paint.',
    workload:'Isolated production chart fixture; 5000 synthetic EURUSD M15 candles, no studies/drawings; automatic reader has no usable source evidence and is NOT profiled.',
    repetitions:{warmupsPerPass:WARMUP,repetitionsPerPass:REPS,passes:PASSES},targetCompletionP95Ms:LIMIT_MS,
    build:null,environment:null,runs:[],errors:[],externalRequests:[],failure:null};
  const page = await outer.context().newPage();
  const cdp = await page.context().newCDPSession(page);
  const check = (value, message) => { if (!value) throw Error(message); };
  const nearest = (sorted,p) => sorted.length ? sorted[Math.ceil(sorted.length*p)-1] : null;
  const stats = values => { const a=[...values].sort((x,y)=>x-y),n=a.length;return {samples:n,median:n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null,p95:nearest(a,.95),p99:nearest(a,.99),max:n?a[n-1]:null}; };
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if (origin === new URL(base).origin) return route.continue();
    result.externalRequests.push(origin); return route.abort();
  });
  await page.addInitScript(() => {
    const state = window.__mobileDisclosure = {armed:null,samples:[],longTasks:[]};
    try { new PerformanceObserver(entries => state.longTasks.push(...entries.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true}); }
    catch { state.longTasksUnsupported=true; }
    const preserved = (a,b) => {
      if (!a || !b) return false;
      for (const key of ['adapterId','containerId','chartId','seriesId','candlesId','dataRevision','barCount','symbol','intervalSeconds','style']) if(a[key]!==b[key])return false;
      for (const key of ['canvasIds','first','last','feed']) if(JSON.stringify(a[key])!==JSON.stringify(b[key]))return false;
      if(!a.range || !b.range || Math.abs(a.range.from-b.range.from)>1e-6 || Math.abs(a.range.to-b.range.to)>1e-6)return false;
      return Math.abs(a.bounds.width-b.bounds.width)<.5 && Math.abs(a.bounds.height-b.bounds.height)<.5;
    };
    function visibleDescendantGeometry(panel) {
      // Expanded tools use display:contents: their parent has no own box.
      // Inspect real controls, and union their visible boxes instead.
      const controls=[...panel.querySelectorAll('button,input,select,textarea,[tabindex],[role="button"]')];
      const rects=controls.flatMap(control=>{
        const rect=control.getBoundingClientRect(),style=getComputedStyle(control);
        return control.getClientRects().length>0 && rect.width>0 && rect.height>0
          && style.display!=='none' && style.visibility!=='hidden' && style.visibility!=='collapse'
          && Number(style.opacity)!==0 ? [rect] : [];
      });
      if(!rects.length)return {visible:false,totalControls:controls.length,visibleControls:0,bounds:null};
      const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));
      const right=Math.max(...rects.map(r=>r.x+r.width)),bottom=Math.max(...rects.map(r=>r.y+r.height));
      return {visible:true,totalControls:controls.length,visibleControls:rects.length,bounds:{x,y,width:right-x,height:bottom-y}};
    }
    const witness = arm => {
      const current=window.__arxChartQa?.snapshot();
      const button=document.querySelector('[data-testid="arx-native-chart"] button[aria-label="Chart tools"]');
      const panel=document.querySelector('[data-testid="arx-native-chart"] [data-testid="chart-advanced-tools"]');
      if(!button || !panel)return {pass:false,reason:'controls missing',current};
      const geometry=visibleDescendantGeometry(panel);
      if(!geometry.totalControls)return {pass:false,reason:'disclosure controls missing',current,geometry};
      if(button.getAttribute('aria-expanded')!==String(arm.expanded) || geometry.visible!==arm.expanded)return {pass:false,reason:'disclosure geometry pending',current,geometry};
      if(button.getAttribute('aria-controls')!==panel.id || !panel.id)return {pass:false,reason:'disclosure association missing',current};
      if(!preserved(arm.before,current))return {pass:false,reason:'chart/source/range changed',current};
      return {pass:true,current,geometry};
    };
    window.addEventListener('click',event=>{
      const arm=state.armed;
      if(!arm || !event.isTrusted || !event.target.closest?.('button[aria-label="Chart tools"]'))return;
      state.armed=null;
      const start=performance.now();
      const {before:baseline,...identity}=arm;
      const sample={...identity,startedAt:start,trusted:event.isTrusted,feedbackMs:null,completionMs:null,completionFrame:null,witnessCostMs:0,lastWitness:null,failure:null};
      let frame=0,firstEligibleFrame=null;
      const poll=()=>{
        frame++;
        if(frame===2)sample.feedbackMs=performance.now()-start;
        const began=performance.now(),seen=witness(arm);
        sample.witnessCostMs+=performance.now()-began;sample.lastWitness=seen;
        if(seen.pass){
          if(firstEligibleFrame!==null && frame>firstEligibleFrame && frame>=2){sample.completionMs=performance.now()-start;sample.completionFrame=frame;state.samples.push(sample);return;}
          firstEligibleFrame=frame;
        } else firstEligibleFrame=null;
        if(performance.now()-start>=arm.timeoutMs){sample.failure=seen.reason??'completion timeout';state.samples.push(sample);return;}
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    },true);
  });
  let sequence=0;
  try {
    await page.setViewportSize(result.viewport);
    for(const cpuRate of [1,4]){
      const run={cpuRate,startedAt:new Date().toISOString(),before:null,after:null,dataBefore:null,dataAfter:null,samples:[],summary:[],longTasks:[],verdict:'FAIL',failure:null};
      result.runs.push(run);
      try {
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
        await page.goto(base);
        await page.evaluate(()=>localStorage.clear());await page.reload();
        const id=await page.locator('meta[name="arx-chart-qa-build-id"]').getAttribute('content');
        const response=await page.request.get(`${base.replace(/\/$/,'')}/arx-chart-qa-build-info.json`);
        check(response.ok(),'Production build metadata unavailable');
        const build=await response.json();
        check(build.buildId===id && build.minified===true && build.git?.dirty===false && build.git?.treeChangedDuringBuild===false,'Unverified or dirty production fixture build');
        if(typeof CHART_QA_EXPECTED_COMMIT==='string')check(build.git.head===CHART_QA_EXPECTED_COMMIT,'Unexpected source commit');
        if(result.build)check(result.build.buildId===build.buildId,'Build changed between CPU rates');
        result.build=build;
        result.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,platform:navigator.platform,reportedHardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,visibility:document.visibilityState,hasFocus:document.hasFocus()}));
        run.timeOrigin=await page.evaluate(()=>performance.timeOrigin);
        const button=page.getByTestId('arx-native-chart').first().getByRole('button',{name:'Chart tools',exact:true});
        await button.waitFor({state:'visible'});
        await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===5000);
        await page.evaluate(()=>document.fonts.ready);
        check(await button.getAttribute('aria-expanded')==='false','Mobile advanced tools must initially be collapsed');
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        run.before=await page.evaluate(()=>window.__arxChartQa.snapshot());
        run.dataBefore=await page.evaluate(()=>window.__arxChartQa.data());
        check(run.before.symbol==='EURUSD' && run.before.intervalSeconds===900 && run.before.style==='candles'
          && run.before.feed.source==='offline_fixture' && run.before.feed.livePriceAffordance===false,
          'Unexpected chart symbol, interval, style or source in the initial witness');
        for(let pass=1;pass<=PASSES;pass++)for(let rep=0;rep<WARMUP+REPS;rep++)for(const expanded of [true,false]){
          const arm={id:++sequence,cpuRate,pass,rep,record:rep>=WARMUP,control:expanded?'Open chart tools':'Close chart tools',expanded,timeoutMs:TIMEOUT_MS,before:run.before};
          await page.evaluate(a=>{window.__mobileDisclosure.armed=a;},arm);
          await button.click();
          await page.waitForFunction(id=>window.__mobileDisclosure.samples.some(s=>s.id===id),arm.id,{timeout:TIMEOUT_MS+2000});
          const sample=await page.evaluate(id=>window.__mobileDisclosure.samples.find(s=>s.id===id),arm.id);
          check(!sample.failure,`${arm.control}: ${sample.failure}`);
        }
        run.after=await page.evaluate(()=>window.__arxChartQa.snapshot());
        run.dataAfter=await page.evaluate(()=>window.__arxChartQa.data());
        check(JSON.stringify(run.dataBefore)===JSON.stringify(run.dataAfter),'Canonical or rendered price data changed during disclosure checks');
        run.verdict='PASS';
      } catch(error){run.failure=String(error?.stack??error);}
      finally {
        if(!run.after)run.after=await page.evaluate(()=>window.__arxChartQa?.snapshot()??null).catch(()=>null);
        if(!run.dataAfter)run.dataAfter=await page.evaluate(()=>window.__arxChartQa?.data()??null).catch(()=>null);
        const observed=await page.evaluate(()=>({samples:window.__mobileDisclosure?.samples??[],longTasks:window.__mobileDisclosure?.longTasks??[],longTasksUnsupported:window.__mobileDisclosure?.longTasksUnsupported??false})).catch(()=>({samples:[],longTasks:[],longTasksUnsupported:true}));
        Object.assign(run,observed);
        for(const control of ['Open chart tools','Close chart tools']){
          const samples=run.samples.filter(s=>s.record&&s.control===control);
          const completed=samples.filter(s=>s.completionMs!==null),completion=stats(completed.map(s=>s.completionMs));
          const item={control,expectedSamples:REPS*PASSES,recordedSamples:samples.length,feedback:stats(samples.filter(s=>s.feedbackMs!==null).map(s=>s.feedbackMs)),completion,witnessOverhead:stats(samples.map(s=>s.witnessCostMs)),failures:samples.filter(s=>s.failure).length,
            meetsTarget:samples.length===REPS*PASSES && completed.length===samples.length && completion.p95!==null && completion.p95<=LIMIT_MS};
          run.summary.push(item);if(!item.meetsTarget)run.verdict='FAIL';
        }
      }
      if(run.failure)break;
    }
    result.verdict=result.runs.length===2&&result.runs.every(run=>run.verdict==='PASS')&&!result.errors.length&&!result.externalRequests.length?'PASS':'FAIL';
  } catch(error){result.failure=String(error?.stack??error);}
  finally {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await cdp.detach().catch(()=>{});await page.close().catch(()=>{});
  }
  return result;
}
