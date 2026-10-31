async page=>{
 const r={passed:false,views:[],failure:null,limitations:['Offline synthetic historical data; resized desktop Chromium, not physical touch.','Read-only geometry observer; no broker calls. No competitor or physical-paint timing claim.']};
 const check=(v,m)=>{if(!v)throw Error(m);};
 const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  function installNoteObserver() {
    if(window.__arxNotesQa)throw Error('Use a fresh note observer/session');
    const clicks=[],textDraws=new Map();
    const canvasPrototype=CanvasRenderingContext2D.prototype,originalFillText=canvasPrototype.fillText;
    function observedFillText(...args) {
      const result=originalFillText.apply(this,args);
      if(this.canvas?.closest?.('[data-testid="scanner-chart-panel"] [data-testid="arx-native-canvas"]')) {
        const text=String(args[0]);
        if(!textDraws.has(text)&&textDraws.size>=4096)textDraws.delete(textDraws.keys().next().value);
        textDraws.set(text,(textDraws.get(text)??0)+1);
      }
      return result;
    }
    canvasPrototype.fillText=observedFillText;
    function engine() {
      const container=document.querySelector('[data-testid="scanner-chart-panel"] [data-testid="arx-native-canvas"]');
      if(!container)throw Error('Scanner native canvas absent');
      const key=Object.keys(container).find(key=>key.startsWith('__reactFiber$'));
      let fiber=container[key],steps=0;
      while(fiber&&!fiber.memoizedProps?.externalFeed&&steps++<100)fiber=fiber.return;
      let hook=fiber?.memoizedState,adapter;steps=0;
      while(hook&&steps++<100){if(hook.memoizedState?.current?.getScannerOverlaySurface){adapter=hook.memoizedState.current;break;}hook=hook.next;}
      if(!adapter||adapter.container!==container)throw Error('Active Scanner adapter binding unavailable');
      const surface=adapter.getScannerOverlaySurface();
      if(!surface||surface.chart!==adapter.chart||surface.series!==adapter.series||surface.container!==container)throw Error('Scanner surface binding differs');
      return {adapter,container};
    }
    const down=event=>{
      if(!(event.target instanceof HTMLCanvasElement))return;
      const {adapter,container}=engine();
      if(!container.contains(event.target))return;
      const bounds=container.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
      clicks.push({trusted:event.isTrusted,pointerType:event.pointerType,button:event.button,x,y,time:adapter.chart.timeScale().coordinateToTime(x),price:adapter.series.coordinateToPrice(y)});
    };
    document.addEventListener('pointerdown',down,true);
    const api={
      read(){
        const {adapter}=engine(),primitive=adapter.analysis?.drawingPrimitive;
        if(primitive&&(primitive.attachment?.chart!==adapter.chart||primitive.attachment?.series!==adapter.series))throw Error('Drawing primitive detached from active price series');
        return {drawings:primitive?.drawings??[],notes:primitive?.notes??[],dirty:primitive?.dirty??false,
          projected:(primitive?.drawings??[]).filter(d=>d.kind==='text').map(d=>({id:d.id,x:adapter.chart.timeScale().timeToCoordinate(d.start.time),y:adapter.series.priceToCoordinate(d.start.price)})),
          pane:{width:adapter.chart.timeScale().width(),height:adapter.series.getPane().getHeight()},clicks:[...clicks],textDraws:Object.fromEntries(textDraws)};
      },
      target(){
        const {adapter}=engine(),range=adapter.chart.timeScale().getVisibleLogicalRange();
        if(!range||!adapter.candles.length)throw Error('No current chart range');
        const candle=adapter.candles[Math.max(0,Math.min(adapter.candles.length-1,Math.round((range.from+range.to)/2)))];
        return {x:adapter.chart.timeScale().timeToCoordinate(candle.time),y:adapter.series.priceToCoordinate(candle.close),time:candle.time,price:candle.close};
      },
      resetTextDraws(){textDraws.clear();},
      stop(){
        document.removeEventListener('pointerdown',down,true);if(window.__arxNotesQa===api)delete window.__arxNotesQa;
        if(canvasPrototype.fillText!==observedFillText)throw Error('Canvas text observer ownership changed before restoration');
        canvasPrototype.fillText=originalFillText;
      },
    };
    window.__arxNotesQa=api;
  }

 try{
 for(const viewport of [{width:1440,height:1100},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  await page.evaluate(()=>localStorage.removeItem('arx.chart.drawings.v1:EURUSD:M15'));
  await page.goto('http://127.0.0.1:4199/market-scanner');await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  await page.evaluate(installNoteObserver);
  const chart=page.getByTestId('scanner-chart-panel').getByTestId('arx-native-chart').first();
  const canvas=chart.getByTestId('arx-native-canvas');
  const tools=chart.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible())await tools.click();
  const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
  const place=async()=>{await canvas.scrollIntoViewIfNeeded();await frames();const target=await page.evaluate(()=>window.__arxNotesQa.target());const box=await canvas.boundingBox();check(box&&target.x>0&&target.y>0,'No placement target');await page.mouse.click(box.x+target.x,box.y+target.y);await frames();};
  await chart.getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');await place();
  await chart.getByLabel('Drawing tool',{exact:true}).selectOption('text');await chart.getByLabel('New user note',{exact:true}).fill('Wait for retest');await place();
  const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')||'[]'));
  const original=await stored();check(original.length===2,'Two drawings not created');
  const read=async()=>{await canvas.scrollIntoViewIfNeeded();await frames();return page.evaluate(()=>window.__arxNotesQa.read());};
  check((await read()).drawings.length===2,'Drawings not attached');
  await chart.getByLabel('Hide drawing 1',{exact:true}).click();const hidden=await read();check(hidden.drawings.length===1&&hidden.drawings[0].id===original[1].id,'Hidden level still drawn');
  check((await stored())[0].hidden===true,'Hide not persisted');
  await chart.getByRole('button',{name:'Hide drawings',exact:true}).click();check((await read()).drawings.length===0,'Global hide failed');
  await chart.getByRole('button',{name:'Show drawings',exact:true}).click();check((await read()).drawings.length===1,'Global show lost individual preference');
  await chart.getByLabel('Find drawing',{exact:true}).fill('retest');check(await chart.getByTestId('chart-drawing-object').count()===1,'Search did not filter');check(await chart.getByLabel('Select drawing 2',{exact:true}).count()===1,'Search renumbered object');
  check((await read()).drawings.length===1,'Search changed geometry');
  await chart.getByLabel('Hide drawing 2',{exact:true}).click();check((await read()).drawings.length===0,'Hidden note still drawn');
  await chart.getByRole('button',{name:'Undo',exact:true}).click();check((await read()).notes.length===1,'Undo did not restore note');
  await chart.getByRole('button',{name:'Redo',exact:true}).click();check((await read()).notes.length===0,'Redo failed');
  await chart.getByRole('button',{name:'Clear search',exact:true}).click();
  const after=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),overflow:document.documentElement.scrollWidth>innerWidth+1}));
  check(before.state.chartId===after.state.chartId&&before.state.seriesId===after.state.seriesId&&JSON.stringify(before.data)===JSON.stringify(after.data),'Object controls changed engine or market data');check(!after.overflow,'Page overflow');
  await page.evaluate(()=>window.__arxNotesQa.stop());await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);await page.evaluate(installNoteObserver);
  check((await read()).drawings.length===0,'Reload lost hidden state');
  if(await tools.isVisible())await tools.click();await chart.getByRole('button',{name:'Objects (2)',exact:true}).click();
  await chart.getByLabel('Show drawing 1',{exact:true}).click();await chart.getByLabel('Show drawing 2',{exact:true}).click();
  check(JSON.stringify(await stored())===JSON.stringify(original),'Show/reload changed original geometry');check((await read()).drawings.length===2,'Reload restored objects not drawn');
  await chart.getByLabel('Find drawing',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'objects-'+viewport.width+'.png'});
  r.views.push({viewport,before,after,original,hidden,restored:await stored()});await page.evaluate(()=>window.__arxNotesQa.stop());
 }
 r.passed=true;
 }catch(e){r.failure=String(e?.stack??e);}
 r.network=await page.evaluate(()=>window.__readFixtureLog());return r;
}
