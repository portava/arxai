// Actual Scanner, synthetic history and intercepted APIs only.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({snapshot:window.__arxChartQa.snapshot(),config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));};
 const numbers=()=>page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)).map(row=>({time:row.time,values:row.studies.map(s=>s.values.map(v=>v.value))})));
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default build');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const tools=async()=>{const b=panel.getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();};
  await tools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();await panel.getByRole('button',{name:/^Studies \(/}).click();
  for(const name of ['Relative strength index','MACD'])await panel.getByRole('button',{name:'Add '+name,exact:true}).click();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  const before=await state(),observations=await numbers();
  await panel.getByLabel('Drawing tool',{exact:true}).selectOption('trend');
  const canvas=panel.locator('canvas[data-arx-native-viewport]');await canvas.click({position:{x:140,y:100}});
  const maximize=panel.getByRole('button',{name:/^Maximize pane 1:/});await maximize.scrollIntoViewIfNeeded();
  const b=await maximize.boundingBox();await page.mouse.click(b.x+b.width/2,b.y+2);let current=await state();
  check(current.snapshot.state.maximizedStudyPane===current.config.studies[0].id,'Upper edge click maximizes instead of grabbing the divider');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('select[aria-label="Drawing tool"]')).some(select=>select.value===''));
  await state();
  check(await panel.getByLabel('Drawing tool',{exact:true}).inputValue()==='', 'Unfinished price drawing is retired on maximization');
  check(await panel.getByRole('separator').count()===0,'Divider controls are unavailable in maximized view');
  check(await panel.getByRole('button',{name:/^Restore layout from pane 1:/}).isVisible(),'Restore button remains reachable');
  check(current.layout.panes[0].height>before.layout.panes[0].height*2,'Selected indicator receives the full plot height');
  check(JSON.stringify(current.config.studies)===JSON.stringify(before.config.studies),'Maximization does not rewrite saved studies');
  check(JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical)&&JSON.stringify(await numbers())===JSON.stringify(observations),'Canonical candles and every indicator observation are unchanged');
  const hiddenCaption=panel.getByLabel('Saved studies (temporarily hidden)',{exact:true});await hiddenCaption.scrollIntoViewIfNeeded();await hiddenCaption.waitFor({state:'visible'});
  check(await panel.getByLabel('Saved studies (visibility unverified)',{exact:true}).count()===0,'Completed indicator paint updates toolbar visibility caption');await shot('hidden-caption');
  check((await panel.getByTestId('chart-maximized-pane').textContent()).includes('trade overlays'),'Shell explicitly reports hidden price and trade layers');
  const annotation=panel.getByRole('button',{name:'Show automatic chart annotations',exact:true});
  check((await annotation.textContent()).includes('hidden')|| (await annotation.textContent()).includes('off'),'Reader never claims annotations on in indicator-only view');
  await panel.getByRole('button',{name:/^Restore layout from pane 1:/}).scrollIntoViewIfNeeded();await state();await shot('desktop-maximized');
  const restore=panel.getByRole('button',{name:/^Restore layout from pane 1:/});await restore.focus();await page.keyboard.press('Enter');current=await state();
  check(current.snapshot.state.maximizedStudyPane===null&&JSON.stringify(current.layout)===JSON.stringify(before.layout),'Keyboard restore returns the exact saved geometry');
  const activeCaption=panel.getByLabel('Active studies',{exact:true});await activeCaption.scrollIntoViewIfNeeded();await activeCaption.waitFor({state:'visible'});
  check(await panel.getByLabel('Saved studies (visibility unverified)',{exact:true}).count()===0,'Restored price view updates toolbar caption without another user action');await shot('restored-caption');
  check(await maximize.evaluate(n=>document.activeElement===n),'Restore preserves keyboard focus on the same control');
  await maximize.click();await state();await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();current=await state();
  check(current.snapshot.state.maximizedStudyPane===null&&JSON.stringify(current.config.studies)===JSON.stringify(before.config.studies),'Temporary maximization does not replace saved layout on reload');
  await page.setViewportSize({width:390,height:844});await state();await tools();await maximize.scrollIntoViewIfNeeded();await maximize.focus();await page.keyboard.press('Enter');current=await state();
  check(current.snapshot.state.maximizedStudyPane!==null&&JSON.stringify(await numbers())===JSON.stringify(observations),'Narrow keyboard maximization preserves all calculations');
  await panel.getByRole('button',{name:/^Restore layout from pane 1:/}).scrollIntoViewIfNeeded();await state();await shot('mobile-maximized');await panel.getByRole('button',{name:/^Restore layout from pane 1:/}).click();await state();
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
