async page=>{
 const check=(v,m)=>{if(!v)throw Error(m);};const r={passed:false,failure:null};
 try{
  await page.setViewportSize({width:1440,height:1100});await page.goto('http://127.0.0.1:4199/live-chart');await page.getByRole('button',{name:'Two charts',exact:true}).click();
  const comparison=page.getByTestId('comparison-chart').first();await comparison.getByTestId('arx-native-canvas').waitFor();
  await page.waitForFunction(()=>window.__arxChartQa?.snapshot(1)?.barCount>0);
  const primaryChart=page.getByTestId('arx-native-chart').first();
  await primaryChart.getByTestId('arx-native-tf-M15').click();await comparison.getByTestId('arx-native-tf-M15').click();
  await page.waitForFunction(()=>[0,1].every(i=>{const s=window.__arxChartQa?.snapshot(i);return s?.barCount===300&&s.intervalSeconds===900;}));
  await page.getByLabel('Link time range',{exact:true}).check();
  const rangeBefore=await page.evaluate(()=>window.__arxChartQa.snapshot(0).range);
  await primaryChart.getByRole('button',{name:'Zoom in chart',exact:true}).click();
  await page.waitForFunction(before=>{const a=window.__arxChartQa.snapshot(0)?.range,b=window.__arxChartQa.snapshot(1)?.range;return a&&b&&(a.to-a.from)<(before.to-before.from)&&(b.to-b.from)<(before.to-before.from)&&Math.abs(a.from-b.from)<=1&&Math.abs(a.to-b.to)<=1;},rangeBefore);
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  r.rangeBefore=rangeBefore;
  r.linked=await page.evaluate(()=>[0,1].map(i=>window.__arxChartQa.snapshot(i)));
  r.before=await page.evaluate(()=>[0,1].map(i=>({state:window.__arxChartQa.snapshot(i),data:window.__arxChartQa.data(i)})));
  await comparison.getByRole('button',{name:'Fullscreen',exact:true}).click();await comparison.getByTestId('arx-assistant-trigger').waitFor();
  for(const id of ['arx-assistant-trigger','fab-toggle','cmdk-trigger'])check(await comparison.getByTestId(id).count()===1,'Fullscreen comparison missing '+id);
  await comparison.getByTestId('cmdk-trigger').click();await page.getByTestId('cmdk-dialog').waitFor();await page.keyboard.press('Escape');await page.getByTestId('cmdk-dialog').waitFor({state:'hidden'});
  check(await comparison.getByTestId('arx-native-chart').getAttribute('aria-modal')==='true','Escape closed fullscreen chart behind command palette');
  await comparison.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
  check(await comparison.getByTestId('arx-assistant-trigger').count()===0,'Launcher retained by closed comparison');
  const primary=page.getByTestId('arx-native-chart').first();for(const id of ['arx-assistant-trigger','fab-toggle','cmdk-trigger'])check(await primary.getByTestId(id).count()===1,'Primary lost '+id);
  r.after=await page.evaluate(()=>[0,1].map(i=>({state:window.__arxChartQa.snapshot(i),data:window.__arxChartQa.data(i)})));
  check(r.before.every((b,i)=>b.state.chartId===r.after[i].state.chartId&&b.state.seriesId===r.after[i].state.seriesId&&JSON.stringify(b.data)===JSON.stringify(r.after[i].data)),'Comparison changed engines/data');r.passed=true;
 }catch(e){r.failure=String(e?.stack??e);}
 r.network=await page.evaluate(()=>window.__readFixtureLog());return r;
}
