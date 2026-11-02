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
  const summary=panel.getByText('Pane scale and reference levels',{exact:true});await summary.click();
  await value.fill('50');await percent.fill('25');
  const before=await ready();check(before.config.studies[0].paneScale===undefined,'Draft values do not commit prematurely');
  await panel.getByRole('button',{name:'RSI 1 Apply anchored scale',exact:true}).click();
  let current=await ready();check(JSON.stringify(current.config.studies[0].paneScale)===JSON.stringify({mode:'line',value:50,percent:25}),'Numeric anchor commits to the native chart');
  await percent.fill('101');await panel.getByRole('button',{name:'RSI 1 Apply anchored scale',exact:true}).click();
  check((await ready()).config.studies[0].paneScale.percent===25,'Invalid percentage preserves the last valid scale');
  await percent.fill('25');await studies.click();current=await ready();
  check(JSON.stringify(before.data.canonical)===JSON.stringify(current.data.canonical)&&JSON.stringify(before.layout)===JSON.stringify(current.layout),'Anchoring leaves candles and pane geometry unchanged');
  report.rawBefore=await page.evaluate(time=>window.__arxChartQa.studyValues([time]),current.snapshot.last.time);
  const canvas=panel.locator('canvas').first();await canvas.scrollIntoViewIfNeeded();await shot('anchor-25');
  await studies.click();await percent.fill('75');await panel.getByRole('button',{name:'RSI 1 Apply anchored scale',exact:true}).click();await ready();await studies.click();current=await ready();
  report.rawAfter=await page.evaluate(time=>window.__arxChartQa.studyValues([time]),current.snapshot.last.time);
  check(JSON.stringify(report.rawBefore)===JSON.stringify(report.rawAfter),'Moving the anchor leaves exact indicator observations unchanged');
  await canvas.scrollIntoViewIfNeeded();await shot('anchor-75');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();current=await ready();
  check(current.config.studies[0].paneScale.percent===75&&current.config.studies[0].paneScale.value===50,'Anchor survives reload');
  await studies.click();await summary.click();await value.fill('1e200');await panel.getByRole('button',{name:'RSI 1 Apply anchored scale',exact:true}).click();await ready();await studies.click();await canvas.scrollIntoViewIfNeeded();await shot('unrepresentable');
  await studies.click();await panel.getByRole('button',{name:'RSI 1 Auto scale',exact:true}).click();await ready();await studies.click();
  check((await ready()).config.studies[0].paneScale.mode==='auto','Auto releases the scale anchor');
  await studies.click();await value.fill('50');await percent.fill('50');await panel.getByRole('button',{name:'RSI 1 Apply anchored scale',exact:true}).click();await ready();await studies.click();
  await panel.getByRole('button',{name:'Simplify chart',exact:true}).click();await ready();await shot('simplified');
  await panel.getByRole('button',{name:'Restore tools',exact:true}).click();await ready();
  await page.setViewportSize({width:390,height:844});await ready();await canvas.scrollIntoViewIfNeeded();await shot('mobile-anchor');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
