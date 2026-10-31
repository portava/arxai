// After shared-chart-stream-reader.js and shared-chart-setup.js in a NEW session.
// Measures synthetic stream delivery -> reader DOM, not user input or broker latency.
async page => {
 if(new URL(page.url()).origin!=='http://127.0.0.1:4199')throw Error('Loopback fixture required');
 const reader=page.getByTestId('smart-chart-reader');
 await page.waitForFunction(()=>document.querySelector('[data-testid="smart-chart-reader"]')?.getAttribute('data-analysis-status')==='ready');
 const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),asOf:document.querySelector('[data-testid="smart-chart-reader"]').getAttribute('data-analysis-asof')}));
 const samples=[];
 for(const close of [100.5,100,100.6,100,100.7,100]){
  const expected=close===100?'ready':'unavailable';
  samples.push(await page.evaluate(({close,expected})=>new Promise((resolve,reject)=>{
   const state=window.__arxChartQa.snapshot();
   const stream=window.__offlineStreams.filter(s=>!s.closed&&s.url.includes('/api/chart/tick-stream?')).find(s=>{const u=new URL(s.url,location.origin);return u.searchParams.get('symbol')===state.symbol&&u.searchParams.get('source')==='deriv_public';});
   if(!stream?.onmessage)return reject(Error('Actual Scanner stream handler unavailable'));
   const tf=new URL(stream.url,location.origin).searchParams.get('timeframe');
   const target=document.querySelector('[data-testid="smart-chart-reader"]');
   const start=performance.now();const timeout=setTimeout(()=>{observer.disconnect();reject(Error('Reader did not follow applied stream: '+expected));},2000);
   const observer=new MutationObserver(()=>{
    if(target.getAttribute('data-analysis-status')!==expected)return;
    const applied=window.__arxChartQa.snapshot();
    if(applied.last.close!==close)return;
    observer.disconnect();clearTimeout(timeout);const domMs=performance.now()-start;
    requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({close,expected,domMs,twoFramesMs:performance.now()-start,bar:applied.last,asOf:target.getAttribute('data-analysis-asof')})));
   });observer.observe(target,{attributes:true,subtree:true,childList:true,characterData:true});
   stream.readyState=1;
   stream.onmessage({data:JSON.stringify({type:'forming_bar',source:'deriv_public',symbol:state.symbol,timeframe:tf,frozen:false,bar:{openTimeMs:state.last.time*1000,open:100,high:101,low:99,close}})});
  }),{close,expected}));
 }
 const after=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),asOf:document.querySelector('[data-testid="smart-chart-reader"]').getAttribute('data-analysis-asof')}));
 if(before.state.chartId!==after.state.chartId||JSON.stringify(before.data)!==JSON.stringify(after.data)||before.asOf!==after.asOf)throw Error('Stream recovery changed history, renderer or confirmation boundary');
 const log=await page.evaluate(()=>window.__readFixtureLog());
 if(log.errors.length)throw Error('Runtime exception '+JSON.stringify(log.errors));
 return {status:'PASS',before,after,samples,errors:log.errors,blocked:log.blocked,limits:['Actual Scanner/adapter/reader; all responses and stream frames are constructed, not provider evidence.','No real market, physical paint, order/broker latency or competitor benchmark.','Per-frame response test, not the failed under-100ms first-navigation goal.']};
}
