async page=>{
 if(typeof SCANNER_QA_EXPECTED_COMMIT!=="string")throw Error("Provide SCANNER_QA_EXPECTED_COMMIT for exact-source validation");
 const r={passed:false,checks:[],failure:null}, check=(ok,label)=>{r.checks.push({label,pass:!!ok});if(!ok)throw Error(label);};
 const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 const state=()=>page.evaluate(()=>({snapshot:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),drawing:window.__arxChartQa.drawingGeometry()}));
 const chart=page.getByTestId('arx-native-chart').first(), canvas=chart.getByTestId('arx-native-canvas');
 const tools=async()=>{const b=chart.getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();};
 async function ready(){await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);await frames();}
 async function place(vertical=false,touch=false){
  await tools();await chart.getByLabel('Drawing tool',{exact:true}).selectOption('measure');await canvas.scrollIntoViewIfNeeded();await frames();
  const points=await page.evaluate(vertical=>{const q=window.__arxChartQa,s=q.snapshot(),bars=q.data().canonical;const i=Math.max(1,Math.floor(s.range.from+(s.range.to-s.range.from)*.4)),j=Math.min(bars.length-1,Math.floor(s.range.from+(s.range.to-s.range.from)*.65));const a=bars[i],b=bars[j];const p=q.anchorCoordinates(a.time,a.close),other=q.anchorCoordinates(b.time,b.close);return [p,vertical?{x:p.x,y:p.y+22}:other];},vertical);
  if(touch){const c=await page.context().newCDPSession(page);for(const p of points){await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await frames();}await c.detach();}
  else for(const p of points){await page.mouse.click(p.x,p.y);await frames();}
 }
 try{
  await page.setViewportSize({width:1440,height:1100});await page.goto('http://127.0.0.1:4199/market-scanner');await ready();
  r.build=await page.evaluate(()=>fetch('/arx-scanner-qa-build-info.json').then(r=>r.json()));check(r.build.sourceUnchanged&&!r.build.source.status&&r.build.source.head===SCANNER_QA_EXPECTED_COMMIT,'Exact clean source');
  const original=await state();const response=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(x=>x.symbol==='EURUSD'&&x.timeframe==='M15'&&new URLSearchParams(x.requestQuery).get('limit')==='200').at(-1);const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});check(response&&JSON.stringify(original.data.canonical)===JSON.stringify(response.canonical)&&JSON.stringify(original.data.display.map(bar))===JSON.stringify(response.canonical),'Initial actual Scanner canonical/display OHLC equals exact source response');await place();let s=await state();
  check(s.drawing.drawings.length===1&&s.drawing.drawings[0].kind==='measure','Two pointer clicks create a ruler');
  const d=s.drawing.drawings[0],labels=s.drawing.strokes.find(x=>x.measurement)?.measurement;
  const delta=d.end.price-d.start.price,pct=delta/d.start.price*100,format=v=>(v>0?'+':'')+Number(v.toPrecision(8));
  check(labels?.[0]===`Price ${format(delta)} (${format(pct)}%)`,'Rendered label uses signed canonical anchor-price arithmetic');
  check(labels?.[1].includes('elapsed')&&!labels.join(' ').includes('bars'),'Calendar duration is not presented as a bar count');
  check(s.drawing.strokes.length===3&&s.drawing.handles.length===2,'Actual rendered ruler has three segments and two editable handles');
  await tools();await chart.getByRole('button',{name:'Objects (1)',exact:true}).click();
  check((await chart.getByLabel('Drawing 1 measurement',{exact:true}).innerText()).includes(labels[0]),'Accessible object readout matches canvas measurement');
  const input=chart.getByLabel('Drawing 1 end price',{exact:true});await input.fill(String(d.start.price+0.001));await input.press('Tab');await frames();
  check(Math.abs((await state()).drawing.drawings[0].end.price-(d.start.price+0.001))<1e-12,'Exact endpoint editing updates the drawing');
  await chart.getByRole('button',{name:'Undo',exact:true}).click();await frames();check(JSON.stringify((await state()).drawing.drawings[0])===JSON.stringify(d),'Undo restores original measurement');
  await chart.getByLabel('Hide drawing 1',{exact:true}).click();await frames();check((await state()).drawing.strokes.length===0,'Hide removes measurement geometry');
  await chart.getByLabel('Show drawing 1',{exact:true}).click();await chart.getByLabel('Lock drawing 1',{exact:true}).click();await frames();check((await state()).drawing.handles.length===0,'Lock removes editing handles');
  await chart.getByLabel('Unlock drawing 1',{exact:true}).click();await chart.getByRole('button',{name:'Objects (1)',exact:true}).click();
  for(const scale of ['log','percent','indexed','linear']) {await chart.getByLabel('Price scale',{exact:true}).selectOption(scale);await frames();check(JSON.stringify((await state()).drawing.strokes.find(x=>x.measurement)?.measurement)===JSON.stringify(labels),'Ruler values remain original prices on '+scale+' scale');}
  await chart.getByLabel('Chart style',{exact:true}).selectOption('heikinAshi');await frames();check(JSON.stringify((await state()).drawing.strokes.find(x=>x.measurement)?.measurement)===JSON.stringify(labels),'Heikin Ashi does not alter ruler prices');
  await chart.getByLabel('Chart style',{exact:true}).selectOption('candles');await page.reload();await ready();s=await state();check(JSON.stringify(s.drawing.drawings[0])===JSON.stringify({...d,locked:false}),'Full reload restores saved ruler, anchors and explicitly unlocked state');
  await canvas.scrollIntoViewIfNeeded();if(typeof SCANNER_QA_OUTPUT_DIR==='string')await page.screenshot({path:SCANNER_QA_OUTPUT_DIR+'/desktop.png'});
  const reloadedAdapter=s.snapshot.adapterId;await page.setViewportSize({width:390,height:844});await frames();await place(true,true);s=await state();
  const second=s.drawing.drawings[1];check(second?.kind==='measure'&&second.start.time===second.end.time&&second.start.price!==second.end.price,'Phone touch supports vertical same-candle measurement');
  check(s.drawing.strokes.some(x=>x.measurement?.[1]==='0s elapsed'),'Same-candle range accurately reports zero elapsed time');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Phone page has no horizontal overflow');
  await canvas.scrollIntoViewIfNeeded();if(typeof SCANNER_QA_OUTPUT_DIR==='string')await page.screenshot({path:SCANNER_QA_OUTPUT_DIR+'/mobile.png'});
  check(JSON.stringify(s.data.canonical)===JSON.stringify(original.data.canonical)&&s.snapshot.adapterId===reloadedAdapter,'Phone ruler preserves reloaded engine and original canonical candles');
  r.final=s;r.network=await page.evaluate(()=>window.__readFixtureLog());check(!r.network.errors.length,'No page exceptions');check(!r.network.requests.some(x=>!['GET','HEAD'].includes(x.method)&&/orders|execute|confirm|live-intent/.test(x.path)),'No order or confirmation attempts');r.passed=true;
 }catch(e){r.failure=String(e.stack??e);try{r.last=await state();}catch{}}
 return r;
}
