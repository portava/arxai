// Counterbalanced native renderer lab only. Range timing includes RAF waiting;
// full-history replacement and first study setup are measured separately.
async page => {
  const cdp=await page.context().newCDPSession(page),runs=[];
  await page.route('**/*',r=>new URL(r.request().url()).origin==='http://127.0.0.1:4199'?r.continue():r.abort());
  await page.setViewportSize({width:1280,height:1000});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  try {
    for(const [cpuRate,preset] of [[1,'none'],[1,'starter'],[4,'starter'],[4,'none'],[4,'none'],[4,'starter'],[1,'starter'],[1,'none']]) {
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
      await page.goto('http://127.0.0.1:4199');
      await page.waitForFunction(()=>window.__arxNativeViewportQa?.viewport.getState().paintCount>0);
      const setupMs=await page.evaluate(preset=>{const select=document.querySelector('#studies'),start=performance.now();select.value=preset;select.dispatchEvent(new Event('change',{bubbles:true}));return performance.now()-start;},preset);
      await page.waitForFunction(()=>!window.__arxNativeViewportQa.viewport.getState().pendingPaint);
      const initial=await page.evaluate(()=>window.__arxNativeViewportQa.viewport.getState());
      if(initial.status!=='ready'||initial.pixelRatio!==1||initial.width<1000||initial.paneCount!==(preset==='starter'?2:0))throw Error('Benchmark configuration mismatch');
      const interaction=await page.evaluate(()=>window.__arxNativeViewportQa.benchmark());
      const refresh=await page.evaluate(async()=>{
        const q=window.__arxNativeViewportQa,samples=[];
        for(let i=0;i<35;i++){
          const next=q.data.map(b=>({...b}));next[next.length-1].close+=.001;
          const start=performance.now();q.replace(next);const elapsed=performance.now()-start;
          await q.waitPaint(q.viewport.getState().paintCount);if(i>=5)samples.push(elapsed);
        }
        return {samples,warmup:5};
      });
      runs.push({cpuRate,preset,setupMs,initial,interaction,refresh});
    }
  } finally {await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});}
  return {metric:'Synthetic native viewport range request to completed Canvas RAF submission, not compositor/app/competitor latency',refreshMetric:'Full history setCandles synchronous preparation; fixture construction and paint excluded',runs};
}
