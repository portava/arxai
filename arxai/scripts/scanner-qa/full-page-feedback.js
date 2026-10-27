async page => {
 const cdp=await page.context().newCDPSession(page),runs=[];
 for(const cpuRate of [1,4]){
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
  await page.setViewportSize({width:1440,height:1100});
  const beforeNavigation=await page.evaluate(()=>window.__readFixtureLog());
  await page.evaluate(()=>localStorage.setItem('scanner.chart.timeframe','15m'));
  await page.goto('http://127.0.0.1:4198/market-scanner');
  await page.getByTestId('scanner-chart-canvas').locator('canvas').first().waitFor();
  await page.getByTestId('selected-market-panel').getByTestId('category-chip-forex').click();
  await page.getByTestId('chip-symbol-GBPUSD').waitFor();
  const startLog=await page.evaluate(()=>window.__readFixtureLog());
  const pick=async symbol=>{
   const panel=page.getByTestId('selected-market-panel');
   const chip=panel.getByTestId('chip-symbol-'+symbol);
   if(!await chip.isVisible())await panel.getByTestId('category-chip-forex').click();
   await chip.click();
  };
  await page.evaluate(()=>{
   window.__scannerPerf={samples:[],longTasks:[]};
   const observer=new PerformanceObserver(list=>window.__scannerPerf.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));
   observer.observe({type:'longtask',buffered:false});
   document.addEventListener('click',event=>{
    const element=event.target.closest('[data-testid]'); if(!element)return;
    const id=element.dataset.testid;
    if(!id.startsWith('chip-symbol-')&&!id.startsWith('scanner-chart-tf-'))return;
    const symbol=id.startsWith('chip-symbol-')?id.slice(12):document.querySelector('[data-testid="scanner-chart-symbol"]').textContent.trim();
    const tf=id.startsWith('scanner-chart-tf-')?id.slice(17):null;
    const sample={id,symbol,tf,phase:window.__scannerPerf.phase??'cold',start:performance.now(),wallStart:Date.now(),trusted:event.isTrusted,contextCommitMs:null,twoFrameMs:null,canvasAtTwoFrames:null};
    window.__scannerPerf.samples.push(sample);
    const correct=()=>document.querySelector('[data-testid="scanner-chart-symbol"]')?.textContent.trim()===symbol&&document.querySelector('[data-testid="badge-active-symbol"]')?.textContent.trim()===symbol&&(!tf||(localStorage.getItem('scanner.chart.timeframe')===tf&&document.querySelector('[data-testid="scanner-chart-tf-'+tf+'"]')?.classList.contains('bg-primary')));
    const recordCanvas=()=>{if(sample.canvasReadyMs==null&&correct()&&document.querySelector('[data-testid="scanner-chart-canvas"] canvas')){sample.canvasReadyMs=performance.now()-sample.start;requestAnimationFrame(()=>requestAnimationFrame(()=>{sample.canvasSecondFrameMs=performance.now()-sample.start;}));return true;}return false;};
    const canvasObserver=new MutationObserver(()=>{if(recordCanvas())canvasObserver.disconnect();});canvasObserver.observe(document.body,{subtree:true,childList:true});
    setTimeout(()=>canvasObserver.disconnect(),2500);
    queueMicrotask(()=>{if(recordCanvas())canvasObserver.disconnect();});
    const record=()=>{if(sample.contextCommitMs===null&&correct()){sample.contextCommitMs=performance.now()-sample.start;return true;}return false;};
    const mo=new MutationObserver(()=>{if(record())mo.disconnect();});mo.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    queueMicrotask(record);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{sample.twoFrameMs=performance.now()-sample.start;sample.contextCorrectAtTwoFrames=correct();sample.canvasAtTwoFrames=!!document.querySelector('[data-testid="scanner-chart-canvas"] canvas');mo.disconnect();}));
   },true);
  });
  // First visits are cold for GBPUSD/USDJPY and exercise delayed read arrival.
  for(const symbol of ['GBPUSD','USDJPY','EURUSD']){
   await pick(symbol);
   await page.getByTestId('scanner-chart-canvas').locator('canvas').first().waitFor();
   await page.waitForFunction(()=>window.__scannerPerf.samples.at(-1)?.twoFrameMs!==null);
   await page.evaluate(()=>{const s=window.__scannerPerf.samples.at(-1);s.chartReadyObservedMs=performance.now()-s.start;});
  }
  const coldCount=3;
  // Revisit cached selections: no synthetic latency is hidden by waiting here.
  await page.evaluate(()=>window.__scannerPerf.phase='warm');
  for(let i=0;i<8;i++){
   await pick(i%2?'EURUSD':'GBPUSD');
   await page.waitForFunction(()=>window.__scannerPerf.samples.at(-1)?.twoFrameMs!==null);
  }
  // Rapid changes deliberately arrive before the 450ms source fixture.
  await page.evaluate(()=>window.__scannerPerf.phase='rapid-timeframe');
  for(const tf of ['1m','5m','30m','1h','15m'])await page.getByTestId('scanner-chart-tf-'+tf).click();
  await page.getByTestId('scanner-chart-canvas').locator('canvas').first().waitFor();
  await page.waitForFunction(()=>window.__scannerPerf.samples.at(-1)?.twoFrameMs!==null);
  // A symbol burst without waiting for data.
  await page.evaluate(()=>window.__scannerPerf.phase='rapid-symbol');
  for(const symbol of ['USDJPY','GBPUSD','EURUSD','GBPUSD'])await pick(symbol);
  await page.getByTestId('scanner-chart-canvas').locator('canvas').first().waitFor();
  await page.waitForFunction(()=>window.__scannerPerf.samples.at(-1)?.twoFrameMs!==null);
  const beforeManualRefresh=await page.evaluate(()=>window.__readFixtureLog());
  const forcedResponse=page.waitForResponse(r=>r.url().includes('/selected-market?')&&r.url().includes('refresh=1'));
  await page.getByTestId('btn-refresh-symbol').click();
  await forcedResponse;
  await page.getByTestId('scanner-chart-panel').scrollIntoViewIfNeeded();
  await page.screenshot({path:'.playwright-cli/lifecycle-final-repeat-'+cpuRate+'x.png'});
  const state=await page.evaluate(async()=>({perf:window.__scannerPerf,log:await window.__readFixtureLog(),finalSymbol:document.querySelector('[data-testid="scanner-chart-symbol"]')?.textContent,finalTimeframe:localStorage.getItem('scanner.chart.timeframe'),finalPanelSymbol:document.querySelector('[data-testid="badge-active-symbol"]')?.textContent,canvasCount:document.querySelectorAll('[data-testid="scanner-chart-canvas"] canvas').length,errorsInSections:[...document.querySelectorAll('[data-testid]')].filter(e=>/error-boundary|section-error/.test(e.dataset.testid)).map(e=>e.textContent)}));
  const requests=state.log.requests.slice(startLog.requests.length);
  const counts={};for(const r of requests){const key=r.path+r.query;counts[key]=(counts[key]??0)+1;}
  const samples=state.perf.samples;
  const pct=(items,p)=>{const xs=items.filter(x=>x!==null).sort((a,b)=>a-b);return xs[Math.ceil(xs.length*p)-1]??null;};
  runs.push({cpuRate,viewport:{width:1440,height:1100},coldSamples:samples.slice(0,coldCount),warmSamples:samples.slice(coldCount,coldCount+8),rapidSamples:samples.slice(coldCount+8),warmContextP95Ms:pct(samples.slice(coldCount,coldCount+8).map(s=>s.contextCommitMs),.95),warmTwoFrameP95Ms:pct(samples.slice(coldCount,coldCount+8).map(s=>s.twoFrameMs),.95),initialRequests:state.log.requests.slice(beforeNavigation.requests.length,startLog.requests.length),manualRefreshRequests:state.log.requests.slice(beforeManualRefresh.requests.length).filter(r=>r.path.includes('selected-market')),allClicksTrusted:samples.every(s=>s.trusted),requestCounts:counts,requests,unknownEndpoints:[...new Set(state.log.unknown.map(x=>x.path))],pageErrors:state.log.errors,longTasks:state.perf.longTasks,finalTimeframe:state.finalTimeframe,finalSymbol:state.finalSymbol,finalPanelSymbol:state.finalPanelSymbol,canvasCount:state.canvasCount,errorsInSections:state.errorsInSections});
 }
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
 return {scope:'Actual full MarketScanner route locally built scanner chart lifecycle candidate; NODE_ENV=production; actual chart with200 synthetic historical candles; ancillary unsupported service contracts503; read-only interactions; allAPI/provider requests intercepted',method:'Trusted click capture to matching DOM context and second rAF; scheduling/paint opportunity only, not hardware presentation timestamp',fixtureNetworkDelayMs:450,runs};
}
