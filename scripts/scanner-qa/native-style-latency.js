async page => {
  // Actual Scanner, offline production fixture only. No order controls.
  const styles = ['candles', 'bars', 'line', 'area', 'baseline', 'heikinAshi', 'hollow'];
  const inputMode = typeof NATIVE_STYLE_QA_INPUT === 'string' ? NATIVE_STYLE_QA_INPUT : 'trusted';
  if(!['trusted','programmatic'].includes(inputMode))throw Error('Invalid input mode');
  const reps = typeof NATIVE_STYLE_QA_REPS === 'number' ? NATIVE_STYLE_QA_REPS : 20;
  if (!Number.isInteger(reps) || reps < 1 || reps > 40) throw Error('Invalid repetition count');
  const result = {schemaVersion: 1, inputMode, performanceAccepted: false, verdict: 'FAIL', build: null, runs: [], failure: null,
    method: (inputMode==='trusted'?'Trusted native select change':'PROGRAMMATIC selection: functional correctness only; timings are diagnostic')+' to completed native draw with exact canonical/display data on two consecutive frames. Menu opening/navigation excluded. Observation cost included; not hardware paint.',
    originalMethod: 'Trusted native select change to completed native draw with exact canonical/display data on two consecutive frames. Menu opening/navigation excluded. Observation cost included; not hardware paint.',
    limitations: ['200 historical synthetic candles; offline source and unavailable AI analysis.', 'Viewport emulation, not physical mobile hardware. Primed application, not first navigation.', 'No live feed, broker, deployed app or matched TradingView/MT5 measurement.'],
    plan: {reps, warmups: 2, styles, rates: [1, 4], targetMs: 100}};
  const check = (ok, why) => {if (!ok) throw Error(why);};
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cdp = await page.context().newCDPSession(page);
  const stats = values => {const s = values.filter(Number.isFinite).sort((a,b) => a-b);return {n:s.length,median:s[Math.ceil(s.length*.5)-1]??null,p95:s[Math.ceil(s.length*.95)-1]??null,max:s.at(-1)??null};};
  function install({authority,inputMode}) {
    const qa = window.__nativeStyleTiming = {samples:[],inputAttempts:[],arm:null,pending:null};
    const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    // Independent displayed HA oracle. All other styles retain canonical OHLC.
    const ha=[];
    for (const c of authority) {const prev=ha.at(-1),open=prev?(prev.open+prev.close)/2:(c.open+c.close)/2,close=(c.open+c.high+c.low+c.close)/4;
      ha.push({time:c.time,open,high:Math.max(c.high,open,close),low:Math.min(c.low,open,close),close});}
    qa.inspect = (snapshot,data,arm) => {
      if (!snapshot || !data || !snapshot.renderVerified || snapshot.state.pendingPaint || snapshot.state.status!=='ready') return 'native draw pending';
      if (snapshot.engineId!=='arx-native'||snapshot.symbol!=='EURUSD'||snapshot.intervalSeconds!==900||snapshot.feed?.source!=='offline_fixture'||snapshot.feed.livePriceAffordance!==false) return 'source identity changed';
      if (snapshot.style!==arm.target || snapshot.state.drawCount<=arm.before.state.drawCount) return 'requested style not drawn';
      if (snapshot.adapterId!==arm.before.adapterId||snapshot.chartId!==arm.before.chartId||!same(snapshot.range,arm.before.range)) return 'chart identity or range changed';
      if (!same(data.canonical,authority)||!same(data.display,arm.target==='heikinAshi'?ha:authority)) return 'canonical or displayed data mismatch';
      const container=document.querySelector('[data-chart-engine="arx-native"]'),box=container?.getBoundingClientRect(),plot=window.__arxChartQa.layout()?.price;
      if(!box||!plot)return 'plot unavailable';
      const left=Math.max(0,box.left+plot.left),top=Math.max(0,box.top+plot.top),right=Math.min(innerWidth,box.left+plot.left+plot.width),bottom=Math.min(innerHeight,box.top+plot.top+plot.height);
      if(right-left<100||bottom-top<100)return 'plot not visibly intersecting viewport';
      const canvas=container.querySelector('canvas[data-arx-native-viewport]');
      if(!canvas||document.elementFromPoint((left+right)/2,(top+bottom)/2)!==canvas)return 'plot obscured';
      return null;
    };
    const finish=(sample,failure)=>{if(qa.pending!==sample)return;clearTimeout(sample.timer);delete sample.timer;sample.failure=failure;qa.samples.push(sample);qa.pending=null;};
    const capture=event=>{
      const arm=qa.arm;
      if(arm)qa.inputAttempts.push({id:arm.id,event:event.type,value:event.target.value,trusted:event.isTrusted});
      if(!arm||(inputMode==='trusted'&&!event.isTrusted)||!event.target.matches('[data-testid="scanner-chart-panel"] select[aria-label="Chart style"]')||event.target.value!==arm.target)return;
      qa.arm=null;
      const now=performance.now(),sample={id:arm.id,target:arm.target,record:arm.record,trusted:event.isTrusted,start:event.timeStamp,captureMs:now-event.timeStamp,completionMs:null,witnessMs:0,frames:0,lastReason:null};
      qa.pending=sample;
      if(!Number.isFinite(sample.start)||sample.start<0||sample.start>now){finish(sample,'invalid input clock');return;}
      sample.timer=setTimeout(()=>finish(sample,'native style completion timeout'),5000);
      let consecutive=0;
      const observe=()=>{
        if(qa.pending!==sample)return;
        const began=performance.now();sample.frames++;
        const snapshot=window.__arxChartQa.snapshot(),data=window.__arxChartQa.data();
        sample.lastReason=qa.inspect(snapshot,data,arm);sample.witnessMs+=performance.now()-began;
        consecutive=sample.lastReason?0:consecutive+1;
        if(consecutive===2){sample.completionMs=performance.now()-sample.start;sample.after={style:snapshot.style,drawCount:snapshot.state.drawCount,renderVerified:snapshot.renderVerified};finish(sample,null);return;}
        requestAnimationFrame(observe);
      };requestAnimationFrame(observe);
    };
    window.addEventListener('change',capture,true);
    qa.dispose=()=>{window.removeEventListener('change',capture,true);if(qa.pending)finish(qa.pending,'sampler disposed');};
  }
  try {
    check(page.url().startsWith('http://127.0.0.1:4199/market-scanner'),'Run shared-chart-setup first');
    for(const rate of [1,4])for(const viewport of [{width:1440,height:1100},{width:390,height:844}]){
      const run={rate,viewport,samples:[],summary:[],failure:null,negativeControls:null};result.runs.push(run);
      try{
        await cdp.send('Emulation.setCPUThrottlingRate',{rate});await page.setViewportSize(viewport);await page.reload();
        await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
        const meta=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('No build metadata');return r.json();});
        check(meta.sourceUnchanged&&!meta.source.status&&meta.minified&&meta.productionRuntimeChecked&&meta.nativeEngine&&!meta.qaOnlyDefaultEngineOverride&&!meta.diagnosticOnly,'Invalid production fixture');
        check(await page.evaluate(()=>window.__arxScannerQaBuildId)===meta.buildId,'Runtime build mismatch');
        if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(meta.source.head===SCANNER_QA_EXPECTED_COMMIT,'Unexpected source commit');
        if(result.build)check(meta.buildId===result.build.buildId,'Build changed');result.build=meta;
        run.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,visibility:document.visibilityState}));
        check(run.environment.visibility==='visible','Hidden page');
        const panel=page.getByTestId('scanner-chart-panel'),tools=panel.getByRole('button',{name:'Chart tools',exact:true}),select=panel.getByLabel('Chart style',{exact:true});
        if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')==='true')await tools.click();
        await select.selectOption('candles');await frames();
        // Fullscreen keeps the actual plot visible while using the toolbar on mobile.
        await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await frames();
        if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')==='true')await tools.click();
        await select.scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);await frames();
        const log=await page.evaluate(()=>window.__readFixtureLog()),response=log.candleResponses.filter(x=>x.symbol==='EURUSD'&&x.timeframe==='M15').at(-1);
        check(response?.canonical.length===200,'Missing expected response authority');run.authority=response;
        await page.evaluate(install,{authority:response.canonical,inputMode});
        // Negative controls must reject queued state, wrong style, wrong source,
        // altered canonical data and stale draw counts before timing can proceed.
        run.negativeControls=await page.evaluate(()=>{
          const s=window.__arxChartQa.snapshot(),d=window.__arxChartQa.data(),arm={target:s.style,before:{...s,state:{...s.state,drawCount:s.state.drawCount-1}}},q=window.__nativeStyleTiming;
          const baseline=q.inspect(s,d,arm),container=document.querySelector('[data-chart-engine="arx-native"]'),cover=document.createElement('div'),box=container.getBoundingClientRect();
          Object.assign(cover.style,{position:'fixed',left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px',background:'#000',zIndex:'2147483647'});container.appendChild(cover);
          const obscured=q.inspect(s,d,arm);cover.remove();
          return {baseline,obscured,pending:q.inspect({...s,renderVerified:false},d,arm),style:q.inspect({...s,style:'invalid'},d,arm),source:q.inspect({...s,symbol:'GBPUSD'},d,arm),data:q.inspect(s,{...d,canonical:d.canonical.slice(1)},arm),draw:q.inspect(s,d,{...arm,before:s})};
        });
        check(run.negativeControls.baseline===null&&Object.entries(run.negativeControls).filter(([k])=>k!=='baseline').every(([,v])=>typeof v==='string'),'Completion witness controls failed');
        const order=styles.slice(1).concat('candles');let id=0;
        for(let rep=0;rep<reps+2;rep++)for(const target of order){
          const before=await page.evaluate(()=>window.__arxChartQa.snapshot());check(before.style!==target,'Measured style would be a no-op');
          const arm={id:++id,target,before,record:rep>=2};await page.evaluate(a=>{window.__nativeStyleTiming.arm=a;},arm);
          if(inputMode==='programmatic')await select.selectOption(target);
          else {await select.focus();await page.keyboard.press('Space');await page.keyboard.press('Home');
            for(let index=0;index<styles.indexOf(target);index++)await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');}
          await page.waitForFunction(id=>window.__nativeStyleTiming.samples.some(s=>s.id===id),id,{timeout:7000});
          const sample=await page.evaluate(id=>window.__nativeStyleTiming.samples.find(s=>s.id===id),id);check(!sample.failure,sample.failure);
        }
      }catch(error){run.failure=String(error?.stack??error);}
      finally{
        const state=await page.evaluate(()=>{const q=window.__nativeStyleTiming;q?.dispose();return {samples:q?.samples??[],unobservedArm:q?.arm??null,inputAttempts:q?.inputAttempts??[],finalSnapshot:window.__arxChartQa?.snapshot()};}).catch(()=>({samples:[],observationFailed:true}));Object.assign(run,state);
        for(const style of styles){const samples=run.samples.filter(s=>s.record&&s.target===style),good=samples.filter(s=>!s.failure&&(s.trusted||inputMode==='programmatic')&&Number.isFinite(s.completionMs));
          const summary={style,planned:reps,recorded:samples.length,failed:samples.length-good.length,timing:stats(good.map(s=>s.completionMs)),outliers:samples.filter(s=>s.failure||s.completionMs>100).map(s=>s.id)};
          summary.passed=samples.length===reps&&good.length===reps&&(inputMode==='programmatic'||summary.timing.p95<=100);run.summary.push(summary);}
      }
    }
    result.network=await page.evaluate(()=>window.__readFixtureLog());
    const allowed=new Set(['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus']);
    result.unexpectedRequests=result.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.has(r.path)||r.status!==503);
    result.verdict=result.runs.length===4&&result.runs.every(r=>!r.failure&&!r.unobservedArm&&r.summary.every(s=>s.passed))&&!result.network.errors.length&&!result.unexpectedRequests.length?(inputMode==='trusted'?'PASS':'FUNCTIONAL_PASS'):'FAIL';result.performanceAccepted=result.verdict==='PASS';
  }catch(error){result.failure=String(error?.stack??error);}
  finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
  return result;
}
