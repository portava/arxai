// Actual synthetic component updates. Timing starts at the DOM click and ends
// after a new completed native paint with the expected canonical close. Does
// not measure network, terminal/broker delivery, route startup or hardware scanout.
async page => {
 function nativeBuildProvenance(build) {
   if (!build?.nativeEngine) return null;
   if (build.qaOnlyDefaultEngineOverride === false && build.productDefaultEngineId === 'arx-native') return 'product-default';
   if (build.qaOnlyDefaultEngineOverride === true && build.productDefaultEngineId === 'lightweight-charts') return 'qa-override';
   return null;
 }
 const output={passed:false,groups:[],limitations:['Synthetic 80-bar position component; native-engine provenance is recorded.','Software CPU throttling is environment-bound, not a physical slow device.','No baseline/competitor timing or broker/network/first-navigation measurement.']};
 const client=await page.context().newCDPSession(page);
 try {
  await page.goto('http://127.0.0.1:4199/position-mini-qa');
  await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.state.status==='ready'&&window.__arxChartQa.configuration().analysisFocus.verified);
  output.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');return r.json();});
  if(nativeBuildProvenance(output.build)===null||!output.build.productionRuntimeChecked||!output.build.sourceUnchanged||output.build.source.status||await page.evaluate(()=>window.__arxScannerQaBuildId)!==output.build.buildId)throw Error('Clean executed native build identity required');
  const before=await page.evaluate(()=>window.__arxChartQa.snapshot().adapterId);
  for(const rate of [1,4]){
   await client.send('Emulation.setCPUThrottlingRate',{rate});
   const group={rate,warmup:[],samples:[],failed:[]};output.groups.push(group);
   for(let i=0;i<65;i++){
    const sample=await page.evaluate(()=>new Promise(resolve=>{
     const start=window.__arxChartQa.snapshot(),expected=start.last.close===1.1082?1.1081:1.1082;
     const button=[...document.querySelectorAll('button')].find(x=>x.textContent==='Update supplied snapshot');
     let started=0,acknowledged=0,ended=false;
     const finish=value=>{if(ended)return;ended=true;clearTimeout(timeout);resolve(value);};
     const timeout=setTimeout(()=>finish({ok:false,reason:'completed-paint deadline',start,expected}),2000);
     button.addEventListener('click',()=>{started=performance.now();},{once:true,capture:true});
     button.click();acknowledged=performance.now()-started;
     const observe=()=>{if(ended)return;const now=window.__arxChartQa.snapshot();
      if(now?.adapterId===start.adapterId&&now.last.close===expected&&now.state.paintCount>start.state.paintCount&&!now.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified)
       finish({ok:true,acknowledgedMs:acknowledged,completedMs:performance.now()-started,paintCount:now.state.paintCount,close:now.last.close});
      else requestAnimationFrame(observe);
     };requestAnimationFrame(observe);
    }));
    (i<5?group.warmup:group.samples).push(sample);if(!sample.ok)group.failed.push({index:i,...sample});
   }
   const sorted=group.samples.filter(s=>s.ok).map(s=>s.completedMs).sort((a,b)=>a-b),percentile=p=>sorted[Math.ceil(p*sorted.length)-1]??null;
   group.summary={count:group.samples.length,valid:sorted.length,failures:group.failed.length,medianMs:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:sorted.at(-1)??null,target100ms:group.failed.length===0&&percentile(.95)<=100};
  }
  output.sameAdapter=await page.evaluate(before=>window.__arxChartQa.snapshot().adapterId===before,before);
  output.fixture=await page.evaluate(()=>window.__readFixtureLog());
  output.passed=output.sameAdapter&&output.groups.every(g=>g.summary.target100ms)&&output.fixture.errors.length===0&&!output.fixture.blocked.some(x=>x.kind==='external'||x.kind==='websocket');
 }catch(error){output.failure=String(error);}
 finally {await client.send('Emulation.setCPUThrottlingRate',{rate:1});await client.detach();}
 return output;
}
