async page => {
  const report={passed:false,build:null,samples:[],failure:null,limitations:['Offline actual Scanner;synthetic historical OHLC;no real provider or broker.','Five placements per input/CPU combination;small-sample timing is not a stable percentile/SLA.','Emulated touch is not physical-device certification;two frames are not physical paint.','Finite parallel boundaries only;extensions,fills,extra levels remain gaps.']};
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/chart-channel';
  const check=(v,m)=>{if(!v)throw Error(m);};
  const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const read=()=>page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),geometry:window.__arxChartQa.drawingGeometry()}));
  const cdp=await page.context().newCDPSession(page);
  try{
    check(new URL(page.url()).origin==='http://127.0.0.1:4199','Offline setup required');
    report.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');return r.json();});
    check(report.build.sourceUnchanged&&!report.build.source.status&&report.build.productionRuntimeChecked&&report.build.buildId===await page.evaluate(()=>window.__arxScannerQaBuildId),'Unverified fixture');
    report.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},visibility:document.visibilityState}));
    const panel=page.getByTestId('scanner-chart-panel'),canvas=panel.getByTestId('arx-native-canvas'),tool=panel.getByLabel('Drawing tool',{exact:true});
    const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
    const before=await read();report.before=before;check(before.geometry.drawings.length===0,'Fresh drawing workspace required');
    const authority=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(r=>r.symbol===before.state.symbol&&r.timeframe==='M15').at(-1);
    const canonical=before.data.canonical;check(JSON.stringify(canonical)===JSON.stringify(authority.canonical),'Initial source mismatch');
    const range=Math.max(...canonical.map(c=>c.high))-Math.min(...canonical.map(c=>c.low));
    let count=0;
    for(const cpu of [1,4])for(const input of ['mouse','touch']){
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:input==='touch'});
      for(let rep=0;rep<5;rep++){
        await tool.selectOption('channel');await canvas.evaluate(e=>e.scrollIntoView({block:'center'}));await frames();
        const anchors=[{time:canonical[80].time,price:canonical[80].close},{time:canonical[140].time,price:canonical[140].close},{time:canonical[110].time,price:canonical[110].close+.0008+rep*.00005}];
        const tap=async anchor=>{
          const point=await page.evaluate(a=>window.__arxChartQa.anchorCoordinates(a.time,a.price),anchor);
          check(point&&Number.isFinite(point.x)&&Number.isFinite(point.y),'Anchor not projected');
          check(await canvas.evaluate((e,p)=>e.contains(document.elementFromPoint(p.x,p.y)),point),'Placement point obscured');
          if(input==='mouse')await page.mouse.click(point.x,point.y);
          else{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
        };
        await tap(anchors[0]);await frames();await tap(anchors[1]);await frames();
        check((await read()).geometry.drawings.length===count,'Partial channel was committed');
        await page.evaluate(({count,before,anchors,range})=>{
          const state=window.__channelTiming={done:false,failure:null};
          const capture=e=>{
            if(!e.isTrusted||!e.target.closest?.('[data-testid="arx-native-canvas"]'))return;
            window.removeEventListener('pointerdown',capture,true);
            const start=e.timeStamp;if(!Number.isFinite(start)||start<0||start>performance.now())throw Error('Invalid clock');
            state.trusted=true;state.start=start;state.pointerType=e.pointerType;
            let previous=false;const timer=setTimeout(()=>{state.failure='completion deadline';state.done=true;},5000);
            const tick=()=>{
              if(state.done)return;
              const w=window.__arxChartQa,geometry=w.drawingGeometry(),s=w.snapshot(),data=w.data();
              const drawing=geometry.drawings.at(-1),lines=geometry.strokes.filter(l=>l.id===drawing?.id);
              const a=drawing?[drawing.start,drawing.end,drawing.offset]:[],equal=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
              const tolerance=range/s.bounds.height*2;
              const correct=!geometry.dirty&&geometry.drawings.length===count+1&&a.length===3&&a.every((p,i)=>p?.time===anchors[i].time&&Math.abs(p.price-anchors[i].price)<tolerance)&&lines.length===2&&Math.abs((lines[0].end.y-lines[0].start.y)-(lines[1].end.y-lines[1].start.y))<1e-6&&equal(data,before.data)&&equal(s.range,before.state.range)&&s.chartId===before.state.chartId&&s.seriesId===before.state.seriesId;
              state.last={correct,geometry};
              if(correct&&previous){state.ms=performance.now()-start;state.done=true;clearTimeout(timer);return;}previous=correct;requestAnimationFrame(tick);
            };requestAnimationFrame(tick);
          };window.addEventListener('pointerdown',capture,true);
        },{count,before,anchors,range});
        await tap(anchors[2]);await page.waitForFunction(()=>window.__channelTiming?.done,null,{timeout:6500});
        const sample=await page.evaluate(()=>window.__channelTiming);report.samples.push({...sample,cpu,input,rep});check(!sample.failure,'Channel did not render correctly');count++;
        if(count===1)await page.screenshot({path:prefix+'-first.png'});
      }
    }
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
    const saved=await read();report.afterPlacements=saved;
    // Drag the selected width handle; one undo must restore all three anchors.
    const last=saved.geometry.drawings.at(-1),point=await page.evaluate(a=>window.__arxChartQa.anchorCoordinates(a.time,a.price),last.offset);
    await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y-20,{steps:4});await page.mouse.up();await frames();
    const moved=await read();check(moved.geometry.drawings.at(-1).offset.price!==last.offset.price&&JSON.stringify(moved.geometry.drawings.at(-1).start)===JSON.stringify(last.start)&&JSON.stringify(moved.geometry.drawings.at(-1).end)===JSON.stringify(last.end),'Width handle did not edit independently');
    await panel.getByRole('button',{name:'Undo',exact:true}).click();await frames();check(JSON.stringify((await read()).geometry.drawings)===JSON.stringify(saved.geometry.drawings),'Single undo did not restore channel');
    await panel.getByLabel('Price scale',{exact:true}).selectOption('log');await canvas.evaluate(e=>e.scrollIntoView({block:'center'}));await frames();
    const log=await read();check(log.geometry.strokes.length===count*2&&!log.geometry.dirty,'Log channel geometry absent');
    for(const d of log.geometry.drawings){const l=log.geometry.strokes.filter(s=>s.id===d.id);check(Math.abs((l[0].end.y-l[0].start.y)-(l[1].end.y-l[1].start.y))<1e-6,'Log boundaries not parallel');}
    report.logarithmic=log;
    await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.drawingGeometry()?.drawings.length===20);await canvas.evaluate(e=>e.scrollIntoView({block:'center'}));await frames();
    report.reloaded=await read();check(JSON.stringify(report.reloaded.geometry.drawings)===JSON.stringify(saved.geometry.drawings)&&report.reloaded.geometry.strokes.length===40,'Channel reload differs');
    report.summary=[1,4].flatMap(cpu=>['mouse','touch'].map(input=>{const values=report.samples.filter(s=>s.cpu===cpu&&s.input===input).map(s=>s.ms).sort((a,b)=>a-b);return{cpu,input,n:values.length,medianMs:values[2],maxMs:values.at(-1),allUnder100:values.length===5&&values.every(v=>Number.isFinite(v)&&v>=0&&v<=100)};}));
    report.passed=report.samples.length===20&&report.summary.every(s=>s.allUnder100);
  }catch(error){report.failure=String(error?.stack??error);}
  finally{report.network=await page.evaluate(()=>window.__readFixtureLog()).catch(()=>null);if(report.network?.errors.length)report.passed=false;await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false}).catch(()=>{});await cdp.detach().catch(()=>{});}
  return report;
}
