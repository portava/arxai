async page=>{
 const report={passed:false,samples:[],failure:null,limitations:['Offline synthetic 200 bars, no active market analysis or broker.','1440x1600 browser viewport chosen to keep plot and object controls visible together; not laptop/mobile acceptance.','Two animation frames prove source-correct rendered geometry, not hardware paint.','No matched competitor timing; no first-navigation speedup claim.']};
 const check=(v,m)=>{if(!v)throw Error(m);};
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const read=()=>page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),geometry:window.__arxChartQa.drawingGeometry()}));
 const cdp=await page.context().newCDPSession(page);
 try{
  report.build=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());
  check(report.build.sourceUnchanged&&!report.build.source.status&&report.build.productionRuntimeChecked&&report.build.buildId===await page.evaluate(()=>window.__arxScannerQaBuildId),'Invalid build');
  await page.setViewportSize({width:1440,height:1600});await frames();
  report.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,viewport:{width:innerWidth,height:innerHeight}}));
  const panel=page.getByTestId('scanner-chart-panel'),canvas=panel.getByTestId('arx-native-canvas');
  const tool=panel.getByLabel('Drawing tool',{exact:true});
  const initial=await read();const authority=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(r=>r.symbol===initial.state.symbol&&r.timeframe==='M15').at(-1);
  check(JSON.stringify(initial.data.canonical)===JSON.stringify(authority.canonical),'Canonical source mismatch');
  check(initial.geometry.drawings.length===0,'Fresh drawing workspace required');
  await tool.selectOption('channel');await canvas.scrollIntoViewIfNeeded();await frames();
  const canonical=initial.data.canonical;
  for(const a of [{time:canonical[90].time,price:canonical[90].close},{time:canonical[135].time,price:canonical[135].close},{time:canonical[110].time,price:canonical[110].close+.0006}]){
   const p=await page.evaluate(a=>window.__arxChartQa.anchorCoordinates(a.time,a.price),a);check(p,'Anchor not projected');
   check(await canvas.evaluate((e,p)=>e.contains(document.elementFromPoint(p.x,p.y)),p),'Anchor obscured');
   await page.mouse.click(p.x,p.y);await frames();
  }
  check((await read()).geometry.drawings.length===1,'Channel not created');
  await panel.getByRole('button',{name:'Objects (1)',exact:true}).click();
  const fields=[['extendLeft','extend left'],['extendRight','extend right'],['middleLine','middle line']];
  await panel.getByLabel('Drawing 1 middle line').scrollIntoViewIfNeeded();await frames();
  const before=await read();report.before=before;
  const measure=async(property,label,cpu,rep)=>{
   const input=panel.getByLabel('Drawing 1 '+label);await input.scrollIntoViewIfNeeded();await frames();
   const expected=!(await input.isChecked());
   await page.evaluate(({property,expected,before})=>{
    const t=window.__channelOptionTiming={done:false,failure:null};
    const capture=e=>{
     if(!e.isTrusted||!(e.target instanceof HTMLInputElement)||e.target.type!=='checkbox')return;
     document.removeEventListener('click',capture,true);const start=e.timeStamp;t.trusted=e.isTrusted;t.start=start;
     const timer=setTimeout(()=>{t.failure='completion timeout';t.done=true;},5000);let prev=false;
     const tick=()=>{
      if(t.done)return;
      const w=window.__arxChartQa,s=w.snapshot(),d=w.data(),g=w.drawingGeometry(),o=g.drawings[0],lines=g.strokes;
      const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      const b=s.bounds;const x=b.x+Math.min(b.width-70,100),y=Math.max(0,b.y)+70;
      const canvas=document.querySelector('[data-testid="arx-native-canvas"]');
      const visible=b.width>=170&&Math.min(b.y+b.height,innerHeight)-Math.max(b.y,0)>=140&&[[x,y],[x-49,y-49],[x+49,y-49],[x-49,y+49],[x+49,y+49]].every(([x,y])=>canvas.contains(document.elementFromPoint(x,y)));
      let correct=!!o&&!g.dirty&&(o[property]===true)===expected&&lines.length===(o.middleLine?3:2)&&same(d,before.data)&&s.chartId===before.state.chartId&&s.seriesId===before.state.seriesId&&same(s.range,before.state.range)&&same([o.start,o.end,o.offset],[before.geometry.drawings[0].start,before.geometry.drawings[0].end,before.geometry.drawings[0].offset]);
      if(correct){const l=lines[0],r=lines[1];correct=Math.abs((l.end.y-l.start.y)-(r.end.y-r.start.y))<1e-7;if(o.extendLeft)correct=correct&&Math.min(l.start.x,l.end.x)<=0;if(o.middleLine){const m=lines[2];correct=correct&&m.dashed&&Math.abs(m.start.y-(l.start.y+r.start.y)/2)<1e-7&&Math.abs(m.end.y-(l.end.y+r.end.y)/2)<1e-7;}}
      t.last={correct,visible,bounds:b,drawings:g.drawings,strokes:lines};
      if(correct&&visible&&prev){t.ms=performance.now()-start;t.done=true;clearTimeout(timer);return;}prev=correct&&visible;requestAnimationFrame(tick);
     };requestAnimationFrame(tick);
    };document.addEventListener('click',capture,true);
   },{property,expected,before});
   await input.click();await page.waitForFunction(()=>window.__channelOptionTiming?.done,null,{timeout:6500});
   const sample=await page.evaluate(()=>window.__channelOptionTiming);report.samples.push({...sample,property,expected,cpu,rep});check(!sample.failure,'Option did not complete visibly: '+property);
  };
  for(const cpu of [1,4]){await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});for(let rep=0;rep<4;rep++)for(const [key,label] of fields)await measure(key,label,cpu,rep);}
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  for(const [,label] of fields)await panel.getByLabel('Drawing 1 '+label).check();await frames();
  report.allEnabled=await read();await page.screenshot({path:'channel-options.png'});
  await panel.getByRole('button',{name:'Undo',exact:true}).click();await frames();check(!(await read()).geometry.drawings[0].middleLine,'Undo failed');
  await panel.getByRole('button',{name:'Redo',exact:true}).click();await frames();check((await read()).geometry.drawings[0].middleLine,'Redo failed');
  await panel.getByLabel('Lock drawing 1').click();for(const [,label] of fields)check(await panel.getByLabel('Drawing 1 '+label).isDisabled(),'Locked edit available');
  await panel.getByLabel('Unlock drawing 1').click();
  await panel.getByLabel('Price scale',{exact:true}).selectOption('log');await frames();const log=await read();report.logarithmic=log;
  check(log.geometry.strokes.length===3&&!log.geometry.dirty,'Log geometry absent');
  const [a,b,m]=log.geometry.strokes;check(Math.abs(m.start.y-(a.start.y+b.start.y)/2)<1e-7&&Math.abs(m.end.y-(a.end.y+b.end.y)/2)<1e-7,'Log midpoint incorrect');
  await page.reload();await page.waitForFunction(expected=>{const w=window.__arxChartQa,g=w?.drawingGeometry();return g?.drawings.length===1&&g.strokes.length===3&&!g.dirty&&JSON.stringify(w.data())===JSON.stringify(expected);},before.data,{timeout:15000});
  report.reloaded=await read();check(JSON.stringify(report.reloaded.geometry.drawings)===JSON.stringify(log.geometry.drawings),'Reload lost options');
  report.summary=[1,4].map(cpu=>{const ts=report.samples.filter(s=>s.cpu===cpu).map(s=>s.ms).sort((a,b)=>a-b);return{cpu,n:ts.length,medianMs:ts[Math.floor(ts.length/2)],p95Ms:ts[Math.ceil(ts.length*.95)-1],maxMs:ts.at(-1),under100:ts.filter(t=>t<=100).length};});
  report.functionalPassed=true;report.passed=report.samples.length===24&&report.summary.every(s=>s.under100===12);
 }catch(error){report.failure=String(error?.stack??error);}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog()).catch(()=>null);if(report.network?.errors.length)report.passed=false;await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.detach().catch(()=>{});}
 return report;
}
