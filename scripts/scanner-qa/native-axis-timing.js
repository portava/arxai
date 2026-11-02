// Trusted browser pointer moves on the actual app's native price axis.
// Synthetic fixed candles; no network, broker or physical-screen timing claim.
async page => {
 function nativeBuildProvenance(build) {
   if (!build?.nativeEngine) return null;
   if (build.qaOnlyDefaultEngineOverride === false && build.productDefaultEngineId === 'arx-native') return 'product-default';
   if (build.qaOnlyDefaultEngineOverride === true && build.productDefaultEngineId === 'lightweight-charts') return 'qa-override';
   return null;
 }
 const out={passed:false,groups:[],limitations:['Synthetic 200-bar actual Scanner fixture with recorded native-engine provenance.','Software CPU throttle; not physical-device, competitor, broker, network or first-navigation timing.','Completed paint is renderer evidence observed on a later animation frame, not hardware scanout.']};
 const client=await page.context().newCDPSession(page);
 const ready=()=>page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.state.status==='ready'&&!s.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified;});
 try{
  await page.setViewportSize({width:1440,height:1200});await ready();
  out.build=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());
  if(nativeBuildProvenance(out.build)===null||!out.build.productionRuntimeChecked||!out.build.sourceUnchanged||out.build.source.status||await page.evaluate(()=>window.__arxScannerQaBuildId)!==out.build.buildId)throw Error('Clean exact executed native source required');
  const canonical=await page.evaluate(()=>JSON.stringify(window.__arxChartQa.data().canonical));
  await page.getByTestId('arx-native-canvas').first().scrollIntoViewIfNeeded();await ready();
  const point=await page.evaluate(()=>{const s=window.__arxChartQa.snapshot(),p=window.__arxChartQa.layout().price;return{x:s.bounds.x+s.bounds.width-25,y:s.bounds.y+p.top+p.height*.5};});
  if(point.y<180||point.y+60>1150)throw Error('Axis target outside visible viewport');
  for(const rate of [1,4]){
   await client.send('Emulation.setCPUThrottlingRate',{rate});
   const group={rate,warmup:[],samples:[],failed:[]};out.groups.push(group);
   for(let i=0;i<65;i++){
    await page.mouse.move(point.x,point.y);await page.mouse.down();
    await page.evaluate(()=>{
     const canvas=document.querySelector('canvas[data-arx-native-viewport]'),start=window.__arxChartQa.snapshot(),startLayout=window.__arxChartQa.layout();
     window.__axisSample=new Promise(resolve=>{
      let started=null,acknowledgedMs=null,done=false;
      const finish=value=>{if(done)return;done=true;clearTimeout(timeout);canvas.removeEventListener('pointermove',onMove,true);resolve(value);};
      const timeout=setTimeout(()=>finish({ok:false,reason:'input/completed-paint deadline',before:start,after:window.__arxChartQa.snapshot()}),2000);
      const onMove=event=>{
       if(!event.isTrusted||!(event.buttons&1))return;
       started=performance.now();canvas.removeEventListener('pointermove',onMove,true);
       queueMicrotask(()=>{acknowledgedMs=performance.now()-started;});
       const observe=()=>{if(done)return;const s=window.__arxChartQa.snapshot();
        if(s?.adapterId===start.adapterId&&s.state.manualPriceRange&&JSON.stringify(s.state.manualPriceRange)!==JSON.stringify(start.state.manualPriceRange)&&s.state.paintCount>start.state.paintCount&&!s.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified)
         finish({ok:true,acknowledgedMs,completedMs:performance.now()-started,manualPriceRange:s.state.manualPriceRange,paintCount:s.state.paintCount,rangeUnchanged:JSON.stringify(s.range)===JSON.stringify(start.range),priceTransformChanged:window.__arxChartQa.layout().topPrice!==startLayout.topPrice||window.__arxChartQa.layout().bottomPrice!==startLayout.bottomPrice});
        else requestAnimationFrame(observe);
       };requestAnimationFrame(observe);
      };canvas.addEventListener('pointermove',onMove,true);
     });
    });
    await page.mouse.move(point.x,point.y+(i%2===0?45:-45));
    const sample=await page.evaluate(()=>window.__axisSample);await page.mouse.up();
    (i<5?group.warmup:group.samples).push(sample);if(!sample.ok||!sample.rangeUnchanged||!sample.priceTransformChanged)group.failed.push({index:i,...sample});
   }
   const values=group.samples.filter(s=>s.ok).map(s=>s.completedMs).sort((a,b)=>a-b),at=q=>values[Math.ceil(values.length*q)-1]??null;
   group.summary={count:group.samples.length,valid:values.length,failures:group.failed.length,medianMs:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:values.at(-1)??null,target100ms:group.failed.length===0&&values.length===60&&at(.95)<=100};
  }
  out.canonicalUnchanged=await page.evaluate(()=>JSON.stringify(window.__arxChartQa.data().canonical))===canonical;
  out.fixture=await page.evaluate(()=>window.__readFixtureLog());out.passed=out.canonicalUnchanged&&out.groups.every(g=>g.summary.target100ms)&&out.fixture.errors.length===0&&!out.fixture.blocked.some(x=>x.kind==='external'||x.kind==='websocket');
 }catch(error){out.failure=String(error);}
 finally{await page.mouse.up();await client.send('Emulation.setCPUThrottlingRate',{rate:1});await client.detach();}
 return out;
}
