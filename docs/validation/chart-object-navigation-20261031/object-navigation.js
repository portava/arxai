async page=>{
 const result={passed:false,views:[],samples:[],failure:null,limitations:['Offline 200 synthetic historical bars; actual Scanner production runtime with isolated fixture config.','Desktop Chromium resized for mobile; CPU throttling is host-relative. Two frames are not physical paint.','No broker, real-provider or competitor timing acceptance.']};
 const check=(v,m)=>{if(!v)throw Error(m);};const cdp=await page.context().newCDPSession(page);
 try{
 for(const viewport of [{width:1440,height:1100},{width:390,height:844}]){
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await page.setViewportSize(viewport);
  await page.goto('http://127.0.0.1:4199/market-scanner');await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  const seed=await page.evaluate(()=>{
   const bars=window.__arxChartQa.data().canonical;
   const rows=[{id:'early',kind:'text',start:{time:bars[20].time,price:bars[20].close},text:'Earlier observation',color:'#fbbf24',locked:true},
    {id:'later',kind:'horizontal',start:{time:bars[170].time,price:bars[170].close},color:'#fbbf24',hidden:true},
    {id:'unloaded',kind:'vertical',start:{time:bars[0].time-86400,price:bars[0].close},color:'#ffffff'}];
   localStorage.setItem('arx.chart.drawings.v1:EURUSD:M15',JSON.stringify(rows));return rows;
  });
  await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  const build=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());check(build.productionRuntimeChecked&&build.sourceUnchanged&&!build.source.status,'Source not verified');
  const chart=page.getByTestId('scanner-chart-panel').getByTestId('arx-native-chart').first();
  const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
  const open=async()=>{const tools=chart.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')==='false')await tools.click();const objects=chart.getByRole('button',{name:'Objects (3)',exact:true});if(await objects.getAttribute('aria-expanded')==='false')await objects.click();};
  await open();await chart.getByLabel('Find drawing',{exact:true}).fill('Earlier observation');
  check(await chart.getByTestId('chart-drawing-object').count()===1,'Filter failed');
  await chart.getByLabel('Go to drawing 1 start',{exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-testid')==='arx-native-canvas');
  check(await chart.getByRole('button',{name:'Objects (3)',exact:true}).getAttribute('aria-expanded')==='false','Objects stayed open');
  await open();await chart.getByRole('button',{name:'Clear search',exact:true}).click();
  const rangeBefore=await page.evaluate(()=>window.__arxChartQa.snapshot().range);
  await chart.getByLabel('Go to drawing 3 start',{exact:true}).click();
  check(await chart.getByText(/Drawing 3 starts outside loaded history/).isVisible(),'Outside history not reported');
  check(JSON.stringify(rangeBefore)===JSON.stringify(await page.evaluate(()=>window.__arxChartQa.snapshot().range)),'Failed jump changed range');
  await chart.getByRole('button',{name:'Hide drawings',exact:true}).click();await chart.getByLabel('Go to drawing 1 start',{exact:true}).click();
  check(await chart.getByText(/Drawing remains hidden/).isVisible(),'Global hidden state lost');
  await open();await chart.getByRole('button',{name:'Show drawings',exact:true}).click();
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  for(let repeat=0;repeat<15;repeat++)for(const [number,index] of [[1,20],[2,170]]){
   await open();const button=chart.getByLabel(`Go to drawing ${number} start`,{exact:true});await button.scrollIntoViewIfNeeded();
   await page.evaluate(({number,index,before})=>{
    const trial=window.__objectJump={done:false,failure:null};
    const capture=e=>{
     if(!e.isTrusted||e.target.closest('button')?.getAttribute('aria-label')!==`Go to drawing ${number} start`)return;
     document.removeEventListener('click',capture,true);trial.start=e.timeStamp;trial.trusted=true;let validFrames=0;
     const deadline=setTimeout(()=>{trial.done=true;trial.failure='Source-correct visible object navigation timed out';},5000);
     const tick=()=>{
      if(trial.done)return;const s=window.__arxChartQa.snapshot(),d=window.__arxChartQa.data(),range=s.range,b=s.bounds;
      const left=Math.max(0,b.x),right=Math.min(innerWidth,b.x+b.width-70),top=Math.max(0,b.y),bottom=Math.min(innerHeight-56,b.y+b.height);
      const canvas=document.querySelector('[data-testid="scanner-chart-panel"] [data-testid="arx-native-canvas"]');
      const x=(left+right)/2,y=(top+bottom)/2;
      const visible=right-left>=100&&bottom-top>=100&&[[x,y],[x-49,y-49],[x+49,y-49],[x-49,y+49],[x+49,y+49]].every(([a,b])=>canvas.contains(document.elementFromPoint(a,b)));
      const exact=JSON.stringify(d)===JSON.stringify(before.data)&&s.chartId===before.state.chartId&&s.seriesId===before.state.seriesId&&JSON.stringify(s.feed)===JSON.stringify(before.state.feed)&&s.symbol===before.state.symbol&&s.intervalSeconds===before.state.intervalSeconds;
      const correct=Math.abs((range.from+range.to)/2-index)<1&&exact&&document.activeElement===canvas;
      trial.last={range,visible,correct,bounds:b};validFrames=visible&&correct?validFrames+1:0;
      if(validFrames>=2){trial.done=true;trial.ms=performance.now()-trial.start;clearTimeout(deadline);return;}requestAnimationFrame(tick);
     };requestAnimationFrame(tick);
    };document.addEventListener('click',capture,true);
   },{number,index,before});
   const sample={viewport,cpu:4,repeat,number,index};result.samples.push(sample);await button.click();await page.waitForFunction(()=>window.__objectJump?.done,null,{timeout:6000});Object.assign(sample,await page.evaluate(()=>window.__objectJump));check(!sample.failure,'Object jump completion failed');
  }
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  const after=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),stored:JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')),overflow:document.documentElement.scrollWidth>innerWidth+1}));
  check(JSON.stringify(seed)===JSON.stringify(after.stored),'Jump changed saved objects');check(!after.overflow,'Page overflow');
  await page.screenshot({path:`object-jump-${viewport.width}.png`});result.views.push({viewport,build,before,after,seed});
 }
 result.summary=[1440,390].map(width=>{const values=result.samples.filter(s=>s.viewport.width===width).map(s=>s.ms).sort((a,b)=>a-b);return{width,n:values.length,medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1],p99Ms:values[Math.ceil(values.length*.99)-1],maxMs:values.at(-1),under100:values.filter(x=>x<=100).length};});
 result.passed=true;result.latencyPassed=result.summary.every(s=>s.n===30&&s.under100===30);
 }catch(e){result.failure=String(e?.stack??e);}
 finally{result.network=await page.evaluate(()=>window.__readFixtureLog()).catch(()=>null);await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
 return result;
}
