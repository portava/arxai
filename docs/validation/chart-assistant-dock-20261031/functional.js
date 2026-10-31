async page=>{
 const r={passed:false,sizes:[],failure:null};const check=(v,m)=>{if(!v)throw Error(m);};const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 try{
  for(const viewport of [{width:390,height:844},{width:1440,height:1100}]){
   await page.setViewportSize(viewport);await page.goto('http://127.0.0.1:4199/market-scanner');await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
   const dock=page.getByTestId('chart-assistant-dock');await page.getByTestId('arx-assistant-trigger').waitFor();
   for(const id of ['arx-assistant-trigger','fab-toggle','cmdk-trigger']){check(await page.getByTestId(id).count()===1,'Duplicate '+id);check(await dock.getByTestId(id).count()===1,'Not docked '+id);}
   const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
   await dock.getByTestId('cmdk-trigger').click();await page.getByTestId('cmdk-dialog').waitFor();await page.keyboard.press('Escape');await page.getByTestId('cmdk-dialog').waitFor({state:'hidden'});
   await dock.getByTestId('fab-toggle').click();await page.getByTestId('fab-action-emergency-kill-switch').waitFor();
   // Only close the menu; no action or execution link is followed.
   await page.getByTestId('fab-toggle').click();await page.getByTestId('fab-action-emergency-kill-switch').waitFor({state:'hidden'});
   await dock.getByTestId('arx-assistant-trigger').click();await page.getByTestId('arx-assistant-panel').waitFor();
   await page.getByTestId('arx-input').fill('Unsent offline draft');
   await page.getByTestId('arx-assistant-panel').getByRole('button',{name:'Close',exact:true}).click();await page.getByTestId('arx-assistant-panel').waitFor({state:'hidden'});
   const chart=page.getByTestId('arx-native-chart').first();await chart.getByRole('button',{name:'Fullscreen',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-testid="arx-native-chart"]')?.getAttribute('aria-modal')==='true');
   check(await chart.getByTestId('arx-assistant-trigger').count()===1,'Fullscreen lost launcher');
   await chart.getByTestId('arx-assistant-trigger').click();await page.getByTestId('arx-assistant-panel').waitFor();check(await page.getByTestId('arx-input').inputValue()==='Unsent offline draft','Fullscreen lost draft');
   await page.getByTestId('arx-assistant-panel').getByRole('button',{name:'Close',exact:true}).click();
   await chart.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await frames();
   const after=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),overflow:document.documentElement.scrollWidth>innerWidth+1}));
   check(before.state.chartId===after.state.chartId&&before.state.seriesId===after.state.seriesId&&JSON.stringify(before.data)===JSON.stringify(after.data),'Dock controls changed chart source/engine');check(!after.overflow,'Page overflows');
   await page.getByTestId('chart-assistant-dock').scrollIntoViewIfNeeded();await page.screenshot({path:'dock-header-'+viewport.width+'.png'});
   r.sizes.push({viewport,before,after});
  }
  // Leaving the chart returns the same launchers to their normal placement.
  await page.locator('aside a[href="/"]').first().click();await page.waitForFunction(()=>location.pathname==='/');await page.waitForFunction(()=>document.querySelector('[data-testid="arx-assistant-trigger"]')?.getAttribute('data-placement')==='floating');
  for(const id of ['arx-assistant-trigger','fab-toggle','cmdk-trigger'])check(await page.getByTestId(id).count()===1,'Lost fallback '+id);
  await page.getByTestId('arx-assistant-trigger').click();await page.getByTestId('arx-assistant-panel').waitFor();check(await page.getByTestId('arx-input').inputValue()==='Unsent offline draft','Route change lost draft');
  await page.getByTestId('arx-assistant-panel').getByRole('button',{name:'Close',exact:true}).click();
  r.passed=true;
 }catch(e){r.failure=String(e?.stack??e);}
 r.network=await page.evaluate(()=>window.__readFixtureLog());return r;
}
