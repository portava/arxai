async page=>{
 const r={passed:false,checks:[],failure:null};
 const check=(ok,text)=>{r.checks.push({text,pass:!!ok});if(!ok)throw Error(text);};
 const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 const state=i=>page.evaluate(i=>({s:window.__arxChartQa.snapshot(i),d:window.__arxChartQa.data(i)}),i);
 const chart=i=>page.getByTestId('arx-native-chart').nth(i);
 const compare=page.getByRole('region',{name:'Comparison chart 1',exact:true});
 const follow=compare.getByLabel('Follow primary interval',{exact:true});
 async function settings(){const details=compare.locator('details').first();if(await details.evaluate(el=>el.open))await details.locator('summary').click();}
 async function ready(i,tf,sec,limit){
  await page.waitForFunction(({i,sec,limit})=>{const q=window.__arxChartQa,s=q?.snapshot(i);return s?.intervalSeconds===sec&&s?.barCount===limit;},{i,sec,limit},{timeout:10000});await frames();
  const data=await state(i),log=await page.evaluate(()=>window.__readFixtureLog()),expected=log.candleResponses.filter(x=>x.symbol==='EURUSD'&&x.timeframe===tf&&new URLSearchParams(x.requestQuery).get('limit')===String(limit)).at(-1);
  const bar=c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close});
  check(expected&&JSON.stringify(data.d.canonical)===JSON.stringify(expected.canonical)&&JSON.stringify(data.d.display.map(bar))===JSON.stringify(expected.canonical),'Exact source/display candles: chart '+i+' '+tf+' '+limit);
  check(data.s.feed.livePriceAffordance===false,'Historical fixture remains non-live: chart '+i+' '+tf);return data;
 }
 try{
  await page.setViewportSize({width:1600,height:1100});await page.goto('http://127.0.0.1:4199/market-scanner');
  r.build=await page.evaluate(()=>fetch('/arx-scanner-qa-build-info.json').then(r=>r.json()));check(r.build.sourceUnchanged&&!r.build.source.status&&r.build.productionRuntimeChecked&&!r.build.diagnosticOnly,'Clean ordinary production fixture');
  const initial=await ready(0,'M15',900,200);
  await page.getByRole('button',{name:'Two charts',exact:true}).click();await ready(1,'H1',3600,300);await settings();await follow.check();
  const followed=await ready(1,'M15',900,300);check((await state(0)).s.adapterId===initial.s.adapterId&&JSON.stringify((await state(0)).d)===JSON.stringify(initial.d),'Following leaves primary engine and candle authority unchanged');
  await chart(0).getByTestId('arx-native-tf-M5').click();await ready(0,'M5',300,200);const changed=await ready(1,'M5',300,300);check(changed.s.adapterId===followed.s.adapterId,'Following primary interval preserves comparison engine');
  await settings();await follow.uncheck();await chart(0).getByTestId('arx-native-tf-M30').click();await ready(0,'M30',1800,200);await ready(1,'M5',300,300);check(!await follow.isChecked(),'Turning follow off freezes the current comparison interval');
  await follow.check();await ready(1,'M30',1800,300);await chart(1).getByTestId('arx-native-tf-H1').click();await ready(1,'H1',3600,300);check(!await follow.isChecked(),'Selecting a comparison interval ends following');await ready(0,'M30',1800,200);
  await follow.check();await ready(1,'M30',1800,300);await page.reload();await ready(0,'M30',1800,200);await ready(1,'M30',1800,300);await settings();check(await follow.isChecked(),'Follow preference survives full reload');
  await page.setViewportSize({width:390,height:844});await chart(0).getByTestId('arx-native-tf-M15').click();await ready(0,'M15',900,200);await ready(1,'M15',900,300);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Linked mobile charts fit viewport');
  await compare.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await page.screenshot({path:'/Users/areyouok/arx-tier1-release/chart-follow-interval-20261101/mobile-follow.png'});
  r.network=await page.evaluate(()=>window.__readFixtureLog());check(r.network.errors.length===0,'No page exceptions');check(!r.network.requests.some(x=>!['GET','HEAD'].includes(x.method)&&/orders|execute|confirm|live-intent/.test(x.path)),'No order or confirmation request');r.passed=true;
 }catch(e){r.failure=String(e.stack??e);}return r;
}
