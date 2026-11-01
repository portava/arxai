async page => {
 const r={passed:false,checks:[],failure:null,limitations:['Synthetic historical candles; all API writes blocked. No broker, physical paint or competitor runtime acceptance.']};
 const check=(ok,message)=>{r.checks.push({message,pass:!!ok});if(!ok)throw Error(message);};
 const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 const state=()=>page.evaluate(()=>Array.from(document.querySelectorAll('[data-testid="arx-native-canvas"]'),(_,i)=>({state:window.__arxChartQa.snapshot(i),data:window.__arxChartQa.data(i),drawing:window.__arxChartQa.drawingGeometry(i)})));
 const chart=i=>page.getByTestId('arx-native-chart').nth(i);
 async function ready(count){await page.waitForFunction(count=>Array.from({length:count},(_,i)=>window.__arxChartQa?.snapshot(i)?.barCount>0).every(Boolean),count,{timeout:15000});await frames();}
 async function tools(i){const b=chart(i).getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();}
 async function draw(i){await tools(i);await chart(i).getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');await chart(i).getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();const target=await page.evaluate(i=>{const q=window.__arxChartQa,s=q.snapshot(i),data=q.data(i),c=data.canonical[Math.min(data.canonical.length-1,Math.max(0,Math.floor((s.range.from+s.range.to)/2)))];return q.anchorCoordinates(c.time,c.close,i);},i);if(!target)throw Error('No drawing target '+i);await page.mouse.click(target.x,target.y);await frames();}
 try{
  await page.setViewportSize({width:1600,height:1100});await page.goto('http://127.0.0.1:4199/market-scanner');await ready(1);
  r.build=await page.evaluate(()=>fetch('/arx-scanner-qa-build-info.json').then(r=>r.json()));
  check(r.build.sourceUnchanged&&!r.build.source.status&&r.build.productionRuntimeChecked&&!r.build.diagnosticOnly,'Clean unchanged production fixture');
  const original=(await state())[0];
  check(await page.getByTestId('arx-native-chart').count()===1,'Scanner initially mounts only its primary chart');
  await page.getByRole('button',{name:'Two charts',exact:true}).click();await ready(2);
  const pair=await state();check(pair[0].state.adapterId===original.state.adapterId&&JSON.stringify(pair[0].data)===JSON.stringify(original.data),'Adding comparison preserves primary engine and every canonical/display candle');
  check(pair[0].state.intervalSeconds===900&&pair[1].state.intervalSeconds===3600,'Comparison starts independently on H1 while primary remains M15');
  const responses=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses;
  for(let i=0;i<2;i++){const expected=responses.filter(x=>x.symbol==='EURUSD'&&x.timeframe===(i===0?'M15':'H1')&&new URLSearchParams(x.requestQuery).get('limit')===String(i===0?200:300)).at(-1);const actual=pair[i].data;const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});check(expected&&JSON.stringify(actual.canonical)===JSON.stringify(expected.canonical)&&JSON.stringify(actual.display.map(bar))===JSON.stringify(expected.canonical),'Chart '+i+' displays exact source OHLC for its own requested interval');}
  await draw(0);await draw(1);
  check((await state()).every(c=>c.drawing.drawings.length===1),'Each chart owns a drawing in its independent interval');
  await page.keyboard.press('Delete');await frames();let now=await state();check(now[0].drawing.drawings.length===1&&now[1].drawing.drawings.length===0,'Delete affects only focused comparison');
  await page.keyboard.press('Control+z');await frames();now=await state();check(now.every(c=>c.drawing.drawings.length===1),'Comparison undo restores its own drawing without altering primary');
  await chart(0).getByTestId('arx-native-canvas').focus();await page.keyboard.press('Backspace');await frames();now=await state();check(now[0].drawing.drawings.length===0&&now[1].drawing.drawings.length===1,'Backspace affects only focused primary');
  await page.keyboard.press('Meta+z');await frames();check((await state()).every(c=>c.drawing.drawings.length===1),'Primary undo restores its own drawing');
  await page.getByLabel('Link time range',{exact:true}).check();
  await chart(0).getByRole('button',{name:'Zoom in chart',exact:true}).click();await frames();await frames();now=await state();
  check(JSON.stringify(now[1].state.linkedView.requestedRange)===JSON.stringify(now[0].state.visibleTimeRange),'Comparison receives primary UTC range rather than primary logical indices');
  const desired=now[0].state.visibleTimeRange,cs=now[1].data.canonical;
  const from=cs.findIndex((c,i)=>c.time>=desired.from||(c.time<=desired.from&&desired.from<c.time+3600));
  const to=cs.findLastIndex(c=>c.time<=desired.to);
  check(now[1].state.range.from===from&&now[1].state.range.to===to,'H1 visible range maps to its own loaded bars');
  await page.getByLabel('Link crosshair',{exact:true}).check();await chart(0).getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();
  const cursor=await page.evaluate(()=>{const q=window.__arxChartQa,s=q.snapshot(),data=q.data(),c=data.canonical[Math.floor((s.range.from+s.range.to)/2)];return {time:c.time,...q.anchorCoordinates(c.time,c.close)};});await page.mouse.move(cursor.x-12,cursor.y,{steps:3});await page.mouse.move(cursor.x,cursor.y,{steps:3});await page.waitForFunction(time=>window.__arxChartQa.snapshot(1)?.linkedView.requestedCursor===time,cursor.time,{timeout:2000});await frames();now=await state();
  const matching=now[1].data.canonical.find(c=>c.time<=cursor.time&&cursor.time<c.time+3600);
  check(now[1].state.linkedView.requestedCursor===cursor.time&&JSON.stringify(now[1].state.linkedView.hoveredCandle)===JSON.stringify(matching),'Linked crosshair uses containing H1 candle and its own close');
  await page.getByLabel('Link time range',{exact:true}).uncheck();await page.getByLabel('Link crosshair',{exact:true}).uncheck();await frames();now=await state();check(now.every(c=>c.state.linkedView.requestedRange===null&&c.state.linkedView.requestedCursor===null),'Unlink clears received range and crosshair');
  await page.getByRole('button',{name:'Four charts',exact:true}).click();await ready(4);now=await state();check(now.map(c=>c.state.intervalSeconds).join(',')==='900,3600,14400,86400','Four independent intervals are available on Scanner');
  check(now.every(c=>!c.state.feed.livePriceAffordance),'No synthetic comparison is labelled live');
  await page.setViewportSize({width:390,height:844});await frames();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Four-chart mobile layout has no horizontal document overflow');
  await tools(1);await chart(1).getByRole('button',{name:'Objects (1)',exact:true}).click();await chart(1).getByLabel('Select drawing 1',{exact:true}).click();await chart(1).getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await chart(1).getByTestId('arx-native-canvas').focus();await page.keyboard.press('Delete');await frames();now=await state();check(now[0].drawing.drawings.length===1&&now[1].drawing.drawings.length===0,'Mobile comparison keyboard focus stays isolated');
  await page.getByRole('button',{name:'One chart',exact:true}).click();await frames();now=await state();check(now.length===1&&now[0].state.adapterId===original.state.adapterId,'Returning to one chart removes comparisons without remounting primary');
  check(JSON.stringify(now[0].data)===JSON.stringify(original.data),'All layout/drawing/link actions preserve primary candle values');
  r.network=await page.evaluate(()=>window.__readFixtureLog());check(r.network.errors.length===0,'No page exceptions');
  check(!r.network.requests.some(x=>!['GET','HEAD'].includes(x.method)&&/orders|execute|confirm|live-intent/.test(x.path)),'No order or confirmation request attempted');
  r.passed=true;
 }catch(e){r.failure=String(e.stack??e);try{r.last=await state();}catch{}}
 return r;
}
