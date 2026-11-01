async page=>{
  function assess(current,authority,viewport,unobscured) {
    const state=current?.state,data=current?.data;
    if(!state||!data||!Array.isArray(data.canonical)||!Array.isArray(data.display))return {source:false,visible:false,reason:'chart observer unavailable'};
    const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
    const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    if(state.symbol!==authority.symbol||state.intervalSeconds!==authority.intervalSeconds||state.style!=='candles'||state.feed?.source!==authority.source||state.feed?.livePriceAffordance!==false)return {source:false,visible:false,reason:'context/source/style mismatch'};
    if(!state.adapterId||!state.chartId||!state.seriesId||!state.canvasIds?.length||state.barCount!==authority.canonical.length||!state.range||!(state.range.to>state.range.from))return {source:false,visible:false,reason:'actual chart/series/range not ready'};
    if(!eq(data.canonical,authority.canonical)||!eq(data.display.map(bar),authority.canonical))return {source:false,visible:false,reason:'canonical/displayed OHLC mismatch'};
    const b=state.bounds;
    const visible=!!b&&Math.min(b.x+b.width,viewport.width)-Math.max(b.x,0)>=100&&Math.min(b.y+b.height,viewport.height)-Math.max(b.y,0)>=100&&unobscured;
    return {source:true,visible,reason:visible?null:'plot offscreen or obscured',identity:[state.adapterId,state.chartId,state.seriesId,...state.canvasIds].join(':')};
  }
  function plotVisible(bounds,viewport,hit) {
    const left=Math.max(0,bounds.x),right=Math.min(viewport.width,bounds.x+bounds.width);
    const top=Math.max(0,bounds.y),bottom=Math.min(viewport.height,bounds.y+bounds.height);
    if(right-left<100||bottom-top<100)return false;
    // A fixed bottom nav can cover the centre of a partial plot intersection.
    // Find an actual 100px square; never infer visibility from bounds alone.
    for(const x of [left+50,(left+right)/2,right-50])for(const y of [top+50,(top+bottom)/2,bottom-50]) {
      if([[x,y],[x-49,y-49],[x+49,y-49],[x-49,y+49],[x+49,y+49]].every(([px,py])=>hit(px,py)))return true;
    }
    return false;
  }

 const report={passed:false,samples:[],failure:null,method:'Trusted cached follow-checkbox click to exact canonical/displayed comparison candles, non-live source and real series identity plus unobscured 100px plot over two render frames. Not physical paint, startup or broker latency.'};
 const primary=page.getByTestId('arx-native-chart').nth(0),comparison=page.getByTestId('arx-native-chart').nth(1),region=page.getByRole('region',{name:'Comparison chart 1',exact:true}),follow=region.getByLabel('Follow primary interval',{exact:true});
 const cdp=await page.context().newCDPSession(page);
 try {
  report.build=await page.evaluate(()=>fetch('/arx-scanner-qa-build-info.json').then(r=>r.json()));
  if(!report.build.sourceUnchanged||report.build.source.status||report.build.diagnosticOnly||!report.build.productionRuntimeChecked)throw Error('Unverified production fixture');
  await primary.getByTestId('arx-native-tf-M15').click();
  await comparison.getByTestId('arx-native-tf-M15').click();
  await page.waitForFunction(()=>window.__arxChartQa.snapshot(1)?.barCount===300&&window.__arxChartQa.snapshot(1)?.intervalSeconds===900);
  const responses=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses;
  const response=responses.filter(x=>x.symbol==='EURUSD'&&x.timeframe==='M15'&&new URLSearchParams(x.requestQuery).get('limit')==='300').at(-1);
  if(!response)throw Error('No300-bar authority');
  const authority={symbol:'EURUSD',intervalSeconds:900,source:response.source,canonical:response.canonical};
  await follow.evaluate((input,{authority,assessSource,visibleSource})=>{
   const assess=(0,eval)('('+assessSource+')'),visible=(0,eval)('('+visibleSource+')');
   input.addEventListener('click',event=>{
    if(!input.checked)return;
    const result=window.__followProbe={trusted:event.isTrusted,click:event.timeStamp,done:false,sourceMs:null,visibleMs:null,last:null};let previous=null,frame=null;
    const timer=setTimeout(()=>{result.done=true;result.failure='Visible completion deadline exceeded';cancelAnimationFrame(frame);},5000);
    function observe(){
     const q=window.__arxChartQa,canvas=document.querySelectorAll('[data-testid="arx-native-canvas"]')[1];
     const unobscured=canvas&&visible(canvas.getBoundingClientRect(),{width:innerWidth,height:innerHeight},(x,y)=>canvas.contains(document.elementFromPoint(x,y)));
     const current=assess({state:q.snapshot(1),data:q.data(1)},authority,{width:innerWidth,height:innerHeight},unobscured);result.last=current;
     if(current.source&&result.sourceMs===null)result.sourceMs=performance.now()-result.click;
     if(current.visible&&previous===current.identity){result.visibleMs=performance.now()-result.click;result.done=true;clearTimeout(timer);return;}
     previous=current.visible?current.identity:null;frame=requestAnimationFrame(observe);
    }
    frame=requestAnimationFrame(observe);
   },true);
  },{authority,assessSource:assess.toString(),visibleSource:plotVisible.toString()});
  for(const rate of [1,4])for(const width of [1600,390]){
   await cdp.send('Emulation.setCPUThrottlingRate',{rate});await page.setViewportSize({width,height:width===390?844:1100});
   for(let i=0;i<5;i++){
    const sample={rate,width,index:i};report.samples.push(sample);
    try{
     await comparison.getByTestId('arx-native-tf-H1').click();await page.waitForFunction(()=>window.__arxChartQa.snapshot(1)?.intervalSeconds===3600&&window.__arxChartQa.snapshot(1)?.barCount===300);
     await follow.evaluate(el=>window.scrollBy(0,el.getBoundingClientRect().top-90));
     await page.evaluate(()=>{window.__followProbe=null;});await follow.check();
     await page.waitForFunction(()=>window.__followProbe?.done,null,{timeout:6000});Object.assign(sample,await page.evaluate(()=>window.__followProbe));
     sample.valid=sample.trusted===true&&!sample.failure&&Number.isFinite(sample.visibleMs)&&sample.visibleMs>=0;sample.meets100ms=sample.valid&&sample.visibleMs<=100;
    }catch(e){sample.failure=String(e.message??e);sample.valid=false;sample.meets100ms=false;}
   }
  }
  report.network=await page.evaluate(()=>window.__readFixtureLog());report.passed=report.samples.length===20&&report.samples.every(s=>s.meets100ms)&&report.network.errors.length===0;
 }catch(e){report.failure=String(e.stack??e);}finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
 return report;
}
