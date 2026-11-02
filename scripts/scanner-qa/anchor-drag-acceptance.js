// Actual Scanner page, synthetic candles and intercepted APIs only.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const ready=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({snapshot:window.__arxChartQa.snapshot(),config:window.__arxChartQa.configuration(),data:window.__arxChartQa.data(),layout:window.__arxChartQa.layout()}));};
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));const m=report.build.metadata;
  check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default source');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Market Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const tools=async()=>{const b=panel.getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();};await tools();
  await panel.getByRole('button',{name:'Fit history',exact:true}).click();
  const studies=panel.getByRole('button',{name:/^Studies \(/});await studies.click();await panel.getByRole('button',{name:'Add Relative strength index',exact:true}).click();
  const value=panel.getByLabel('RSI 1 Scale anchor value',{exact:true}),percent=panel.getByLabel('RSI 1 Scale anchor percent',{exact:true});
  await panel.getByText('Pane scale and reference levels',{exact:true}).click();await value.fill('50');await percent.fill('50');await panel.getByRole('button',{name:'RSI 1 Apply anchored scale',exact:true}).click();await ready();await studies.click();
  const handle=panel.getByRole('slider',{name:/Move scale anchor for pane 1/});await handle.waitFor({state:'visible'});await handle.scrollIntoViewIfNeeded();
  let before=await ready();const raw=await page.evaluate(time=>window.__arxChartQa.studyValues([time]),before.snapshot.last.time);
  const box=await handle.boundingBox(),delta=before.layout.panes[0].height/4;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2+delta,{steps:5});await ready();
  check(Math.abs(Number(await handle.getAttribute('aria-valuenow'))-25)<.01,'Pointer drag previews the anchor at 25 percent');
  check((await ready()).config.studies[0].paneScale.percent===50,'Pointer preview does not write saved studies');
  await page.mouse.up();let current=await ready();check(Math.abs(current.config.studies[0].paneScale.percent-25)<.01,'Pointer release commits the new anchor');
  check(JSON.stringify(current.layout)===JSON.stringify(before.layout)&&JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical),'Dragging preserves pane geometry and source candles');
  check(JSON.stringify(await page.evaluate(time=>window.__arxChartQa.studyValues([time]),current.snapshot.last.time))===JSON.stringify(raw),'Dragging preserves exact raw indicator values');
  await shot('dragged');
  const cancelBox=await handle.boundingBox();await page.mouse.move(cancelBox.x+cancelBox.width/2,cancelBox.y+cancelBox.height/2);await page.mouse.down();await page.mouse.move(cancelBox.x+cancelBox.width/2,cancelBox.y+cancelBox.height/2-20,{steps:3});await ready();await page.keyboard.press('Escape');await page.mouse.up();await ready();
  check(Math.abs(Number(await handle.getAttribute('aria-valuenow'))-25)<.01&&(await ready()).config.studies[0].paneScale.percent===current.config.studies[0].paneScale.percent,'Escape restores the saved anchor without a write');
  await handle.focus();await page.keyboard.press('ArrowUp');await ready();check(Math.abs((await ready()).config.studies[0].paneScale.percent-26)<.01,'Keyboard Up moves one percent');
  await page.keyboard.press('Shift+ArrowDown');await ready();check(Math.abs((await ready()).config.studies[0].paneScale.percent-25.9)<.01,'Shift Down moves one tenth of a percent');
  await page.keyboard.press('Home');await ready();check((await ready()).config.studies[0].paneScale.percent===0,'Home reaches the bottom boundary');
  await page.keyboard.press('End');await ready();check((await ready()).config.studies[0].paneScale.percent===100,'End reaches the top boundary');
  await page.keyboard.press('ArrowDown');await ready();await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();await ready();
  check((await ready()).config.studies[0].paneScale.percent===99,'Released anchor survives reload');
  await handle.scrollIntoViewIfNeeded();await panel.getByRole('button',{name:/Maximize pane 1/}).click();await ready();check((await ready()).snapshot.state.maximizedStudyPane!==null,'Single pointer click maximizes the pane');await handle.focus();await page.keyboard.press('ArrowDown');await ready();check((await ready()).config.studies[0].paneScale.percent===98&&(await ready()).snapshot.state.maximizedStudyPane!==null,'Anchor remains adjustable without restoring the maximized pane');
  await panel.getByRole('button',{name:/Restore layout from pane 1/}).click();await ready();
  await panel.getByRole('button',{name:/Collapse pane 1/}).click();await ready();check(await handle.count()===0,'Collapsed pane removes the anchor control');
  await panel.getByRole('button',{name:/Expand pane 1/}).click();await ready();await page.setViewportSize({width:390,height:844});await ready();await handle.scrollIntoViewIfNeeded();await handle.focus();await page.keyboard.press('ArrowDown');await ready();
  check((await ready()).config.studies[0].paneScale.percent===97,'Mobile layout retains keyboard anchor control');await shot('mobile');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
