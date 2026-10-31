async page=>{
 if(new URL(page.url()).origin!=='http://127.0.0.1:4299')throw Error('Diagnostic fixture only');
 const cdp=await page.context().newCDPSession(page);const r={diagnosticOnly:true,scenario:'CPU sampling of chart mount after navigation link is visible; profiling setup adds dwell, NOT immediate-click acceptance',cpuThrottle:4};
 try{
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});await page.setViewportSize({width:1440,height:1100});await page.goto('http://127.0.0.1:4299/',{waitUntil:'commit'});
  const link=page.locator('aside a[href="/market-scanner"]');await link.waitFor({state:'visible'});
  await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:500});await cdp.send('Profiler.start');
  r.start=await page.evaluate(()=>performance.now());await link.click();await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));r.end=await page.evaluate(()=>performance.now());
  r.profile=(await cdp.send('Profiler.stop')).profile;r.state=await page.evaluate(()=>window.__arxChartQa.snapshot());r.metadata=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());
 }finally{await cdp.send('Profiler.disable').catch(()=>{});await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
 return r;
}
