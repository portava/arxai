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
  const toggle=panel.getByLabel('RSI 1 Show labels on scale',{exact:true});check(!(await toggle.isChecked()),'Scale labels are opt-in');await studies.click();await ready();
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();await panel.getByRole('button',{name:'Previous candle',exact:true}).click();
  const before=await ready(),time=before.snapshot.state.inspectionTime;
  const pinnedRaw=await page.evaluate(time=>window.__arxChartQa.studyValues([time])[0].studies[0].values[0].value,time);
  check(Number.isFinite(pinnedRaw),'Pinned historical RSI is available');
  const pinnedValue=String(Number(pinnedRaw.toPrecision(8)));
  await studies.click();await toggle.check();await ready();await studies.click();let current=await ready();
  check(current.snapshot.state.inspectionPinned&&current.snapshot.state.inspectionTime===time,'Scale preference preserves historical inspection');
  check(JSON.stringify(current.layout)===JSON.stringify(before.layout)&&JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical),'Scale preference preserves geometry and candles');
  report.latestObservation=await page.evaluate(time=>window.__arxChartQa.studyValues([time]),current.snapshot.last.time);
  check(current.config.studies[0].showOnScale===true&&current.config.studies[0].showInStatusLine!==true,'Scale visibility is independent of status line');
  const canvas=panel.locator('canvas').first();await canvas.scrollIntoViewIfNeeded();await shot('desktop-scale');
  await studies.click();
  const status=panel.getByLabel('RSI 1 Show values in status line',{exact:true});await status.check();await ready();
  const globalScale=panel.getByLabel('Allow study scale labels',{exact:true}),globalStatus=panel.getByLabel('Allow study status values',{exact:true});
  await globalScale.uncheck();await globalStatus.uncheck();current=await ready();
  check(current.config.studies[0].showOnScale===true&&current.config.studies[0].showInStatusLine===true,'Global overrides preserve individual choices');
  const output=panel.getByLabel('Study status line',{exact:true});check((await output.textContent())==='','Global status override removes status values');
  check(await panel.getByText('Scale labels are hidden by this chart’s readout setting.',{exact:true}).isVisible(),'Scale override is explained beside the saved choice');
  await studies.click();await canvas.scrollIntoViewIfNeeded();await shot('global-hidden');
  await studies.click();await globalScale.check();await globalStatus.check();await ready();await studies.click();
  await output.filter({hasText:'RSI '+pinnedValue}).waitFor({state:'visible'});const restored=await ready();check(restored.snapshot.state.inspectionPinned&&restored.snapshot.state.inspectionTime===time&&(await output.textContent()).includes('Pinned candle'),'Restoring global readouts preserves the exact pinned observation');
  await canvas.scrollIntoViewIfNeeded();await shot('global-restored');
  await studies.click();await globalScale.uncheck();await globalStatus.uncheck();await ready();await studies.click();
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();await ready();await studies.click();
  check(!(await globalScale.isChecked())&&!(await globalStatus.isChecked())&&await toggle.isChecked()&&await status.isChecked(),'Reload preserves global overrides and individual choices');
  await globalScale.check();await globalStatus.check();await ready();
  await toggle.uncheck();await ready();check((await ready()).config.studies[0].showOnScale===false,'Scale labels can be disabled');await toggle.check();await ready();await studies.click();
  await panel.getByRole('button',{name:'Simplify chart',exact:true}).click();await ready();await shot('simplified');
  await panel.getByRole('button',{name:'Restore tools',exact:true}).click();await ready();
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();current=await ready();
  check(current.config.studies[0].showOnScale===true,'Scale visibility survives reload');
  await page.setViewportSize({width:390,height:844});await ready();await canvas.scrollIntoViewIfNeeded();await shot('mobile-scale');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
