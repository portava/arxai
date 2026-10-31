async page=>{
 const r={passed:false,samples:[],failure:null,limitations:['Offline actual Scanner with 200 synthetic historical bars; all APIs intercepted.','390x844 desktop browser resized, not a physical phone.','Two rendering frames are not physical paint; no real-provider or competitor timing.']};
 const check=(v,m)=>{if(!v)throw Error(m);};const cdp=await page.context().newCDPSession(page);
 try{
  await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:4199/market-scanner');await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  r.build=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());check(r.build.productionRuntimeChecked&&r.build.sourceUnchanged&&!r.build.source.status,'Unverified source');
  await page.getByTestId('arx-assistant-trigger').waitFor();
  const tools=page.getByTestId('chart-workbench-tools').first();await tools.evaluate(el=>{el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();window.scrollBy(0,b.top+b.height/2-(innerHeight-108));});
  r.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,devicePixelRatio,hardwareConcurrency:navigator.hardwareConcurrency,viewport:{width:innerWidth,height:innerHeight}}));
  const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));r.before=before;
  for(const cpu of [1,4]){await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});for(let repeat=0;repeat<5;repeat++)for(const direction of ['in','out']){
   const label=`Zoom ${direction} chart`,button=tools.getByRole('button',{name:label,exact:true});
   await button.scrollIntoViewIfNeeded();
   const previous=await page.evaluate(()=>window.__arxChartQa.snapshot().range);
   await page.evaluate(({label,direction,previous,before})=>{
    const t=window.__dockZoom={done:false,failure:null};
    const capture=e=>{
     if(!e.isTrusted||e.target.closest('button')?.getAttribute('aria-label')!==label)return;
     document.removeEventListener('click',capture,true);t.start=e.timeStamp;t.trusted=true;let validFrames=0;
     const deadline=setTimeout(()=>{t.done=true;t.failure='source-correct visible zoom timed out';},5000);
     const tick=()=>{
      if(t.done)return;
      const w=window.__arxChartQa,s=w.snapshot(),d=w.data(),b=s.bounds,range=s.range,eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      const width=range.to-range.from,old=previous.to-previous.from;
      const left=Math.max(b.x,0),right=Math.min(b.x+b.width-70,innerWidth),top=Math.max(b.y,0),bottom=Math.min(b.y+b.height,innerHeight-56);
      const canvas=document.querySelector('[data-testid="arx-native-canvas"]'),x=(left+right)/2,y=(top+bottom)/2;
      const visible=right-left>=100&&bottom-top>=100&&[[x,y],[x-49,y-49],[x+49,y-49],[x-49,y+49],[x+49,y+49]].every(([px,py])=>canvas.contains(document.elementFromPoint(px,py)));
      const correct=Number.isFinite(width)&&(direction==='in'?width<old:width>old)&&eq(d,before.data)&&s.chartId===before.state.chartId&&s.seriesId===before.state.seriesId&&s.symbol===before.state.symbol&&s.intervalSeconds===before.state.intervalSeconds&&eq(s.feed,before.state.feed);
      t.last={visible,correct,range,bounds:b};validFrames=correct&&visible?validFrames+1:0;
      if(validFrames>=2){t.done=true;t.ms=performance.now()-t.start;clearTimeout(deadline);return;}requestAnimationFrame(tick);
     };requestAnimationFrame(tick);
    };document.addEventListener('click',capture,true);
   },{label,direction,previous,before});
   const sample={cpu,repeat,direction};r.samples.push(sample);await button.click();await page.waitForFunction(()=>window.__dockZoom?.done,null,{timeout:6000});Object.assign(sample,await page.evaluate(()=>window.__dockZoom));check(!sample.failure,'Zoom failed');
  }}
  r.summary=[1,4].map(cpu=>{const t=r.samples.filter(s=>s.cpu===cpu).map(s=>s.ms).sort((a,b)=>a-b);return{cpu,n:t.length,medianMs:t[Math.floor(t.length/2)],maxMs:t.at(-1),under100:t.filter(x=>x<=100).length};});
  r.passed=r.samples.length===20&&r.summary.every(s=>s.under100===10);
 }catch(e){r.failure=String(e?.stack??e);}
 finally{r.network=await page.evaluate(()=>window.__readFixtureLog()).catch(()=>null);await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
 return r;
}
