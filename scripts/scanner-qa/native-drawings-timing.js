// Local synthetic Canvas timing. Keeps every warmup and outlier; no app or competitor claim.
async page => {
 await page.route('**/*',r=>new URL(r.request().url()).origin==='http://127.0.0.1:4199'?r.continue():r.abort());
 const cdp=await page.context().newCDPSession(page),runs=[];
 await page.setViewportSize({width:1280,height:1000});await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 try{for(const cpuRate of [1,4,4,1]){
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});await page.goto('http://127.0.0.1:4199');await page.waitForFunction(()=>window.__arxNativeViewportQa?.viewport.getState().status==='ready');await page.locator('#studies').selectOption('starter');
  const result=await page.evaluate(async()=>{
   const q=window.__arxNativeViewportQa,v=q.viewport,rows=q.sampleDrawings(),drawings=Array.from({length:40},(_,i)=>{const d=structuredClone(rows[i%rows.length]),shift=Math.floor(i/rows.length)*.2;d.id='timed-'+i;d.start.price+=shift;if(d.end)d.end.price+=shift;if(d.offset)d.offset.price+=shift;return d;});
   v.setDrawings(drawings);await q.waitPaint(v.getState().paintCount);
   const samples=[];
   for(let i=0;i<90;i++){const count=v.getState().paintCount,start=performance.now();v.setRange({from:q.data.length-201-(i%10),to:q.data.length-1-(i%10)});await q.waitPaint(count);samples.push({warmup:i<15,ms:performance.now()-start});}
   const refresh=[];
   for(let i=0;i<25;i++){const next=q.data.map(b=>({...b}));next.at(-1).close+=.001;const count=v.getState().paintCount,start=performance.now();q.replace(next);const preparationMs=performance.now()-start;await q.waitPaint(count);refresh.push({warmup:i<5,preparationMs,toPaintMs:performance.now()-start});}
   return {state:v.getState(),samples,refresh};
  });runs.push({cpuRate,...result});
 }}finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});}
 return {metric:'Range request to completed RAF Canvas submission (not physical paint)',fixture:'20,000 synthetic bars, 200 visible span, 5 studies, 40 local drawing objects',refreshMetric:'Full-history replacement, separate synchronous preparation and request-to-RAF; fixture construction excluded',runs};
}
