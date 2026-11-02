// Actual Scanner, synthetic history and intercepted APIs only.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));};
 const observations=()=>page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)).map(row=>({time:row.time,values:row.studies.map(s=>s.values.map(v=>v.value))})));
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default build');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const tools=async()=>{const b=panel.getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();};
  await tools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();await panel.getByRole('button',{name:/^Studies \(/}).click();
  for(const name of ['Relative strength index','MACD','Simple moving average'])await panel.getByRole('button',{name:'Add '+name,exact:true}).click();
  await panel.getByLabel('SMA 3 Source',{exact:true}).selectOption({label:'1. RSI · RSI'});
  await panel.getByLabel('RSI 1 Pane controls',{exact:true}).locator('summary').click();const weight=panel.getByLabel('RSI 1 Relative pane height',{exact:true});await weight.fill('3');await weight.press('Tab');
  const before=await state(),numbers=await observations();
  await panel.getByRole('button',{name:'RSI 1 Collapse pane',exact:true}).click();let current=await state();
  check(current.config.studies[0].paneCollapsed===true&&current.layout.panes[0].height===24,'Collapsing creates a 24px native pane strip');
  check(current.layout.price.height>before.layout.price.height&&current.layout.panes[1].height>before.layout.panes[1].height,'Price and open indicator reclaim freed space');
  check(JSON.stringify(await observations())===JSON.stringify(numbers),'Collapsed owner and linked overlay preserve every numeric observation');
  check(await page.evaluate(()=>window.__arxChartQa.studyValues([window.__arxChartQa.data().canonical.at(-1).time])[0].studies[2].displayLabel.includes('pane collapsed')),'Linked readout explains collapsed pane');
  await panel.getByRole('button',{name:'MACD 2 Collapse pane',exact:true}).click();current=await state();
  check(current.layout.panes.every(p=>p.height===24)&&current.config.studies.length===3,'All panes collapse without deleting studies');
  check(JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical),'Collapse preserves canonical candles');
  await panel.getByRole('button',{name:/^Studies \(/}).click();await panel.locator('canvas[data-arx-native-viewport]').scrollIntoViewIfNeeded();await shot('desktop-strips');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();current=await state();
  check(current.config.studies[0].paneCollapsed&&current.config.studies[1].paneCollapsed&&current.config.studies[0].paneWeight===3&&current.layout.panes.every(p=>p.height===24),'Reload retains collapsed panes and previous relative height');
  await tools();await panel.getByRole('button',{name:/^Studies \(/}).click();await panel.getByRole('button',{name:'RSI 1 Expand pane',exact:true}).click();await panel.getByRole('button',{name:'MACD 2 Expand pane',exact:true}).click();current=await state();
  check(JSON.stringify(current.layout)===JSON.stringify(before.layout),'Expanding restores the previous weighted geometry');
  check(JSON.stringify(await observations())===JSON.stringify(numbers),'Expand preserves linked numeric observations');
  await panel.getByLabel('RSI 1 Interval visibility',{exact:true}).locator('summary').click();await panel.getByRole('button',{name:'RSI 1 Hide on all',exact:true}).click();await panel.getByRole('button',{name:'RSI 1 Collapse pane',exact:true}).click();current=await state();
  check(current.layout.panes.length===2&&current.layout.panes[0].height===24,'Hidden source still owns collapse state for visible linked overlay');
  await page.setViewportSize({width:390,height:844});await tools();const expand=panel.getByRole('button',{name:'RSI 1 Expand pane',exact:true});await expand.scrollIntoViewIfNeeded();await expand.focus();await page.keyboard.press('Enter');current=await state();
  check(current.config.studies[0].paneCollapsed===false&&current.layout.panes[0].height>24,'Keyboard expansion works in narrow viewport');
  await shot('mobile-controls');check(await panel.getByRole('region',{name:'Study settings'}).evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Study controls fit narrow viewport');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
