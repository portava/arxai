async page => {
  const report={passed:false,build:null,runs:[],failure:null,limitations:['Actual Scanner production fixture,200 historical synthetic bars; no real provider,broker,physical paint or competitor timing.','Desktop1440x1100,1x/4x CPU;20 measured toggles per condition plus4 retained warmups.','Completion is correct geometry/data on two frames; not guaranteed pixel presentation.']};
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
    const initial=await read();report.before=initial;
    check(initial.configuration.studies[0].config.multiplier===100,'Wide-band workload not applied');
    const authority=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(r=>r.symbol===initial.state.symbol&&r.timeframe==='M15').at(-1);
    check(authority&&JSON.stringify(initial.data.canonical)===JSON.stringify(authority.canonical),'Source mismatch before test');
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
            const start=event.timeStamp;const result=window.__priceScaleTiming={start,enabled,trusted:event.isTrusted,done:false,failure:null,frames:0};
            let matched=false;
            const timer=setTimeout(()=>{result.failure='completion deadline';result.done=true;},5000);
            const tick=()=>{
              if(result.done)return;
              const w=window.__arxChartQa,state=w.snapshot(),data=w.data(),configuration=w.configuration(),geometry=w.priceGeometry();result.frames++;
              const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),span=g=>Math.abs(g.highY-g.lowY);
              const bounds=state.bounds,visible=Math.min(bounds.y+bounds.height,innerHeight)-Math.max(bounds.y,0)>=100&&Math.min(bounds.x+bounds.width,innerWidth)-Math.max(bounds.x,0)>=100;
              const correct=visible&&button.getAttribute('aria-pressed')===String(enabled)&&same(data,initial.data)&&same(configuration,initial.configuration)&&same(state.range,initial.state.range)&&same(state.feed,initial.state.feed)&&state.seriesId===initial.state.seriesId&&state.chartId===initial.state.chartId&&geometry&&Number.isFinite(span(geometry))&&(enabled?span(geometry)>span(initial.geometry)*1.5:Math.abs(span(geometry)-span(initial.geometry))<1);
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
    await page.screenshot({path:'/Users/areyouok/arx-tier1-release/chart-price-only-scale-20261031/enabled.png'});
    await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.configuration()?.studies?.length===2&&window.__arxChartQa?.data()?.canonical.length===200);await frames();
    report.reloaded=await read();check(await button.getAttribute('aria-pressed')==='true'&&span(report.reloaded.geometry)>span(initial.geometry)*1.5,'Preference not restored after reload');
    report.network=await page.evaluate(()=>window.__readFixtureLog());check(!report.network.errors.length,'Page exceptions recorded');
    report.passed=report.runs.length===2&&report.runs.every(r=>r.passed);
  }catch(error){report.failure=String(error?.stack??error);}
  finally{report.network=await page.evaluate(()=>window.__readFixtureLog()).catch(()=>null);await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
  return report;
}
