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
  const toggle=panel.getByLabel('RSI 1 Show values in status line',{exact:true});check(!(await toggle.isChecked()),'Status values are opt-in for a new study');await studies.click();await ready();
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();
  for(let i=0;i<3;i++)await panel.getByRole('button',{name:'Previous candle',exact:true}).click();
  const before=await ready(),time=before.snapshot.state.inspectionTime;
  const raw=await page.evaluate(time=>window.__arxChartQa.studyValues([time])[0].studies[0].values[0].value,time);
  check(before.snapshot.state.inspectionPinned&&Number.isFinite(raw),'Historical candle is pinned with an available RSI observation');
  await studies.click();await toggle.check();let current=await ready();
  const output=panel.getByLabel('Study status line',{exact:true});const value=String(Number(raw.toPrecision(8)));
  await output.filter({hasText:'RSI '+value}).waitFor({state:'visible'});
  check(current.snapshot.state.inspectionPinned&&current.snapshot.state.inspectionTime===time,'Enabling the status readout preserves the exact historical pin');
  check((await output.textContent()).includes('Pinned candle')&&await output.getAttribute('aria-live')==='off','Readout labels selected observations without a hover live-region');
  check(JSON.stringify(current.layout)===JSON.stringify(before.layout)&&JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical),'Readout control preserves chart geometry and candles');
  await panel.getByLabel('RSI 1 Show in Data Window',{exact:true}).uncheck();await ready();await studies.click();
  const dataWindow=panel.getByLabel('Study values at selected candle',{exact:true});await panel.getByText('Data window · study values at the crosshair',{exact:true}).click();
  await dataWindow.filter({hasText:'All study readouts are hidden'}).waitFor({state:'visible'});
  check((await dataWindow.textContent()).includes('All study readouts are hidden')&&(await output.textContent()).includes('RSI '+value),'Status readout stays available when Data Window hides the same study');
  await output.scrollIntoViewIfNeeded();await shot('desktop-selected');
  await studies.click();await toggle.uncheck();await ready();check((await output.textContent())==='','Disabling the status readout removes its values');await toggle.check();await ready();await studies.click();
  await panel.getByRole('button',{name:'Simplify chart',exact:true}).click();await ready();check(!(await output.textContent()).includes('RSI '+value),'Simplified view withdraws numeric status values');
  await panel.getByRole('button',{name:'Restore tools',exact:true}).click();await ready();
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();current=await ready();
  check(current.config.studies[0].showInStatusLine===true&&current.config.studies[0].showInDataWindow===false,'Independent readout settings survive reload');
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();await ready();
  await panel.getByRole('button',{name:'M30 timeframe',exact:true}).click();current=await ready();
  await output.filter({hasText:'Latest loaded candle'}).waitFor({state:'visible'});current=await ready();
  const latestRaw=await page.evaluate(time=>window.__arxChartQa.studyValues([time])[0].studies[0].values[0].value,current.snapshot.last.time);
  report.intervalObservation={state:current.snapshot.state,text:await output.textContent(),latestTime:current.snapshot.last.time,latestRaw};
  check(current.snapshot.state.timeframe==='M30'&&current.snapshot.state.inspectionTime===null&&!current.snapshot.state.inspectionPinned&&(await output.textContent()).includes('RSI '+String(Number(latestRaw.toPrecision(8)))),'Interval replacement labels the new latest-loaded observation without a false selected-candle claim');
  await page.setViewportSize({width:390,height:844});await tools();await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();await ready();await output.scrollIntoViewIfNeeded();
  check(await output.isVisible()&&await output.evaluate(n=>n.scrollWidth<=n.clientWidth),'Narrow-screen status readout wraps without horizontal overflow');await shot('mobile-selected');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
