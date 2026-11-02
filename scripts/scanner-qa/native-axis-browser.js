// Actual app, isolated synthetic fixtures. No order or account mutations.
async page => {
 const out={passed:false,checks:[],limitations:['QA-only native renderer override; not the production default.','Synthetic candles, not broker data. No competitor speed or monetary latency claim.']};
 const check=(value,label)=>{if(!value)throw Error(label);out.checks.push(label);};
 const ready=()=>page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.state.status==='ready'&&!s.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified;});
 const snap=()=>page.evaluate(()=>window.__arxChartQa.snapshot());
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const target=async()=>{await page.getByTestId('arx-native-canvas').first().scrollIntoViewIfNeeded();await frames();return page.evaluate(()=>{const s=window.__arxChartQa.snapshot(),p=window.__arxChartQa.layout?.()?.price;return{x:s.bounds.x+s.bounds.width-25,y:s.bounds.y+(p?p.top+p.height*.35:s.bounds.height*.35)};});};
 const drag=async()=>{const p=await target();check(p.y>140&&p.y+80<await page.evaluate(()=>innerHeight),'Axis gesture uses visible coordinates below sticky header');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x,p.y+80,{steps:5});await page.mouse.up();await ready();return p;};
 try{
  out.build=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());
  check(out.build.nativeEngine&&out.build.productionRuntimeChecked&&out.build.sourceUnchanged&&!out.build.source.status&&await page.evaluate(()=>window.__arxScannerQaBuildId)===out.build.buildId,'Clean exact-source executed native production QA entry');
  await page.setViewportSize({width:1440,height:1200});await ready();
  const chart=page.getByTestId('arx-native-chart').first(),initial=await snap(),canonical=await page.evaluate(()=>window.__arxChartQa.data().canonical);
  const anchor={time:canonical[Math.floor(canonical.length*.7)].time,center:canonical[Math.floor(canonical.length*.7)].close,offset:(Math.max(...canonical.map(c=>c.high))-Math.min(...canonical.map(c=>c.low)))/10};
  const span=()=>page.evaluate(a=>{const p=window.__arxChartQa.anchorCoordinates(a.time,a.center-a.offset),q=window.__arxChartQa.anchorCoordinates(a.time,a.center+a.offset);return p&&q?Math.abs(q.y-p.y):null;},anchor);
  out.beforePriceSpan=await span();const p=await drag();out.afterDrag=await snap();out.afterPriceSpan=await span();
  check(!!out.afterDrag.state.manualPriceRange,'Dragging price axis establishes a manual vertical range');
  check(out.beforePriceSpan>0&&out.afterPriceSpan>0&&Math.abs(out.beforePriceSpan-out.afterPriceSpan)>1,'Actual price-to-pixel span changes after axis drag');
  check(JSON.stringify(out.afterDrag.range)===JSON.stringify(initial.range),'Price-axis drag leaves time range unchanged');
  check(JSON.stringify(await page.evaluate(()=>window.__arxChartQa.data().canonical))===JSON.stringify(canonical),'Price-axis drag does not change canonical OHLC');
  check(out.afterDrag.adapterId===initial.adapterId,'Price-axis drag retains renderer');
  const manual=JSON.stringify(out.afterDrag.state.manualPriceRange);
  await page.evaluate(()=>window.__fixtureSetClockQualified(false));
  await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.state.utcClockQualified===false,null,{timeout:20000});await ready();
  check(JSON.stringify((await snap()).state.manualPriceRange)===manual,'Unrelated clock evidence refresh preserves manual price scale');
  await page.mouse.dblclick(p.x,p.y);await ready();
  check((await snap()).state.manualPriceRange===null,'Double-click price axis restores automatic vertical fitting');
  check(JSON.stringify((await snap()).range)===JSON.stringify(initial.range),'Vertical double-click reset preserves time range');
  await drag();await chart.getByTestId('arx-native-reset-scale').click();await ready();
  check((await snap()).state.manualPriceRange===null,'Existing reset-scale control also restores automatic vertical fitting');
  const tools=chart.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
  await chart.getByLabel('Price scale',{exact:true}).selectOption('log');await ready();await drag();
  check((await snap()).state.scale==='log'&&!!(await snap()).state.manualPriceRange,'Logarithmic view supports finite manual price scaling');
  await chart.getByLabel('Price scale',{exact:true}).selectOption('percent');await ready();
  check((await snap()).state.manualPriceRange===null,'Changing scale mode restores its own automatic price transform');await drag();
  check((await snap()).state.scale==='percent'&&!!(await snap()).state.manualPriceRange,'Percentage view supports manual scaling without changing source candles');
  await chart.getByLabel('Price scale',{exact:true}).selectOption('linear');await ready();
  const cdp=await page.context().newCDPSession(page);
  try{
   await page.setViewportSize({width:390,height:844});await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
   await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});await ready();
   const t=await target();check(t.y>140&&t.y+70<844,'Touch axis target is inside visible mobile chart');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:t.x,y:t.y,id:1}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:t.x,y:t.y+70,id:1}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await ready();
   check(!!(await snap()).state.manualPriceRange&&(await snap()).state.pixelRatio===2,'Native touch axis drag completes at mobile DPR2');
   await page.screenshot({path:'native-axis-mobile.png',fullPage:false});
  }finally{await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.detach();}
  await page.setViewportSize({width:1440,height:1200});await ready();await target();await page.screenshot({path:'native-axis-desktop.png',fullPage:false});
  const badge=await page.getByTestId('live-mode-badge').innerText();out.accountBadge=badge;
  check(!/LIVE\s*·\s*Shared MT5|All systems operational/i.test(badge),'Global account label does not claim live shared-feed health');
  check(JSON.stringify(await page.evaluate(()=>window.__arxChartQa.data().canonical))===JSON.stringify(canonical),'All price-scale interactions preserve canonical OHLC');
  out.fixture=await page.evaluate(()=>window.__readFixtureLog());
  check(out.fixture.errors.length===0,'No page exceptions');check(!out.fixture.blocked.some(x=>x.kind==='external'||x.kind==='websocket'),'No external feed or broker requests');out.passed=true;
 }catch(error){out.failure=String(error);out.fixture=await page.evaluate(()=>window.__readFixtureLog());}
 return out;
}
