// Diagnostic instrumentation: counts unchanged work, not input latency or physical paint.
async page => {
 const canvas=page.getByTestId('arx-native-canvas');
 await page.getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');
 await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
 await page.mouse.click(box.x+box.width*.45,box.y+box.height*.45);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')||'[]').length===1);
 await page.mouse.move(10,10);
 return await page.evaluate(async()=>{
  const el=document.querySelector('[data-testid="arx-native-canvas"]');let fiber=el[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))];
  while(fiber&&!fiber.memoizedProps?.externalFeed)fiber=fiber.return;
  let hook=fiber?.memoizedState,engine;
  while(hook){if(hook.memoizedState?.current?.getScannerOverlaySurface){engine=hook.memoizedState.current;break;}hook=hook.next;}
  if(!engine)throw Error('Adapter not found');
  const series=engine.getScannerOverlaySurface().series,primitive=engine.analysis.drawingPrimitive;
  if(!primitive||primitive.drawings.length!==1)throw Error('Expected one actual drawing primitive');
  const notesBefore=series.priceLines().filter(line=>line.options().title==='S OFFLINE QA');
  if(notesBefore.length!==1)throw Error('Expected one actual synthetic note line');
  const noteBefore=notesBefore[0],noteOptionsBefore=noteBefore.options();
  const dataBefore=window.__arxChartQa.data(),counts={createPriceLine:0,removePriceLine:0,setSelection:0,updateAllViews:0,requestUpdate:0},calls=[],restores=[];
  const wrap=(obj,key,label)=>{const original=obj[key];obj[key]=function(...args){counts[label]++;calls.push({at:performance.now(),method:label,selected:primitive.selected});return original.apply(this,args)};restores.push(()=>{obj[key]=original});};
  wrap(series,'createPriceLine','createPriceLine');wrap(series,'removePriceLine','removePriceLine');wrap(primitive,'setSelection','setSelection');wrap(primitive,'updateAllViews','updateAllViews');wrap(primitive.attachment,'requestUpdate','requestUpdate');
  const before=window.__arxChartQa.snapshot(),start=performance.now();
  try{await new Promise(resolve=>setTimeout(resolve,18000));return {durationMs:performance.now()-start,counts,calls,note:{optionsBefore:noteOptionsBefore,optionsAfter:series.priceLines().filter(line=>line.options().title==='S OFFLINE QA').map(line=>line.options()),sameHandle:series.priceLines().includes(noteBefore)},before,after:window.__arxChartQa.snapshot(),unchangedData:JSON.stringify(dataBefore)===JSON.stringify(window.__arxChartQa.data()),drawings:JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')),buildId:window.__arxScannerQaBuildId,scope:'Idle instrumentation only: one synthetic note, one actual user drawing, 200 fixture bars, all APIs intercepted; counts are not input latency.'};}
  finally{for(const restore of restores)restore();}
 });
}
