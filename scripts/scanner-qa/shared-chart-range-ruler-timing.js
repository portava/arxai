async page=>{
 if(typeof SCANNER_QA_EXPECTED_COMMIT!=="string")throw Error("Provide SCANNER_QA_EXPECTED_COMMIT for exact-source validation");
 const r={passed:false,samples:[],failure:null,planned:20,targetMs:100,limitations:['Cached two-anchor completion, not first navigation, cold data, physical paint, real-device or competitor timing. Five samples per condition; no population p95.']};
 const frames=()=>page.evaluate(()=>new Promise(d=>requestAnimationFrame(()=>requestAnimationFrame(d))));
 const chart=page.getByTestId('arx-native-chart').first(),canvas=chart.getByTestId('arx-native-canvas');
 const cdp=await page.context().newCDPSession(page);
 try{
  await page.goto('http://127.0.0.1:4199/market-scanner');await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);await frames();
  r.build=await page.evaluate(()=>fetch('/arx-scanner-qa-build-info.json').then(r=>r.json()));if(r.build.source.head!==SCANNER_QA_EXPECTED_COMMIT||!r.build.sourceUnchanged||r.build.source.status)throw Error('Wrong or dirty build');
  for(const rate of [1,4])for(const width of [1440,390]){
   await cdp.send('Emulation.setCPUThrottlingRate',{rate});await page.setViewportSize({width,height:width===390?844:1100});await frames();
   for(let attempt=0;attempt<5;attempt++){
    const sample={rate,width,attempt,valid:false};r.samples.push(sample);
    const toggle=chart.getByRole('button',{name:'Chart tools',exact:true});if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
    await chart.getByLabel('Drawing tool',{exact:true}).selectOption('measure');await canvas.scrollIntoViewIfNeeded();await frames();
    const points=await page.evaluate(()=>{const q=window.__arxChartQa,s=q.snapshot(),bars=q.data().canonical;return [.4,.6].map(f=>{const b=bars[Math.floor(s.range.from+(s.range.to-s.range.from)*f)];return q.anchorCoordinates(b.time,b.close);});});
    await page.mouse.click(points[0].x,points[0].y);await frames();
    await page.evaluate(()=>{
     const q=window.__arxChartQa, before=q.snapshot();window.__rulerTiming={before,data:JSON.stringify(q.data()),count:q.drawingGeometry().drawings.length,done:false};
     document.addEventListener('pointerdown',function start(e){const s=window.__rulerTiming;s.started=performance.now();s.trusted=e.isTrusted;
      let stable=0;function observe(){const q=window.__arxChartQa,g=q.drawingGeometry(),current=q.snapshot(),d=g.drawings.at(-1),stroke=g.strokes.find(x=>x.id===d?.id&&x.measurement);const b=document.querySelector('[data-testid="arx-native-canvas"]').getBoundingClientRect();const x=Math.max(0,b.left)+Math.min(innerWidth,b.right)/2-Math.max(0,b.left)/2,y=(Math.max(0,b.top)+Math.min(innerHeight,b.bottom))/2;const hit=document.elementFromPoint(x,y),el=document.querySelector('[data-testid="arx-native-canvas"]');const visible=Math.min(b.right,innerWidth)-Math.max(0,b.left)>=100&&Math.min(b.bottom,innerHeight)-Math.max(0,b.top)>=100&&(hit===el||el.contains(hit));const correct=!g.dirty&&g.drawings.length===s.count+1&&d?.kind==='measure'&&stroke?.measurement?.length===2&&current.adapterId===s.before.adapterId&&JSON.stringify(q.data())===s.data&&visible;
       stable=correct?stable+1:0;if(stable===2){s.done=true;s.ms=performance.now()-s.started;s.after=current;s.drawing=d;s.labels=stroke.measurement;return;}if(performance.now()-s.started>5000){s.done=true;s.failure='No source-correct visible measurement before deadline';return;}requestAnimationFrame(observe);
      }requestAnimationFrame(observe);
     },{capture:true,once:true});
    });
    await page.mouse.click(points[1].x,points[1].y);await page.waitForFunction(()=>window.__rulerTiming?.done,null,{timeout:7000});
    const observed=await page.evaluate(()=>window.__rulerTiming);Object.assign(sample,{valid:observed.trusted===true&&!observed.failure,ms:observed.ms,failure:observed.failure??null,labels:observed.labels,drawing:observed.drawing});sample.meetsTarget=sample.valid&&sample.ms<=100;
    if(!sample.valid)throw Error('Invalid sample '+JSON.stringify(sample));
    await canvas.focus();await page.keyboard.press('Delete');await frames();
   }
  }
  r.passed=r.samples.length===20&&r.samples.every(s=>s.meetsTarget);
 }catch(e){r.failure=String(e.stack??e);}finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
 return r;
}
