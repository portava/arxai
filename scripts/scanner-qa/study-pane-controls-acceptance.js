// Native production Scanner fixture; synthetic data and network interception required.
async page => {
 const report={passed:false,checks:[],screenshots:[],failure:null,limitations:['Synthetic offline Scanner only; no broker, hardware performance or competitor parity claim.']};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const state=()=>page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean committed native production fixture');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');
  await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const openTools=async()=>{const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();};
  await openTools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();const original=await state();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByRole('button',{name:'Add Relative strength index',exact:true}).click();
  await panel.getByRole('button',{name:'Add Simple moving average',exact:true}).click();
  await panel.getByLabel('SMA 2 Source',{exact:true}).selectOption({label:'1. RSI · RSI'});await frames();
  const before=await page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)));
  await panel.getByLabel('RSI 1 Pane controls',{exact:true}).locator('summary').click();
  await panel.getByLabel('RSI 1 Scale minimum',{exact:true}).fill('80');await panel.getByLabel('RSI 1 Scale maximum',{exact:true}).fill('20');
  await panel.getByRole('button',{name:'RSI 1 Apply fixed scale',exact:true}).click();
  check((await state()).config.studies.length===2&&!(await state()).config.studies[0].paneScale,'Invalid reversed limits preserve both studies and original scale');
  check(await panel.getByRole('alert').isVisible(),'Invalid limit error visible');
  await panel.getByLabel('RSI 1 Scale minimum',{exact:true}).fill('40');await panel.getByLabel('RSI 1 Scale maximum',{exact:true}).fill('60');
  await panel.getByRole('button',{name:'RSI 1 Apply fixed scale',exact:true}).click();
  await panel.getByRole('button',{name:'RSI 1 Clear reference levels',exact:true}).click();
  await panel.getByRole('button',{name:'RSI 1 Add reference level',exact:true}).click();
  await panel.getByLabel('RSI 1 Level 1 value',{exact:true}).fill('50');await panel.getByLabel('RSI 1 Level 1 value',{exact:true}).press('Tab');
  await panel.getByLabel('RSI 1 Level 1 description',{exact:true}).fill('Midpoint');
  await panel.getByLabel('RSI 1 Level 1 color',{exact:true}).fill('#00ff00');
  await panel.getByLabel('RSI 1 Level 1 style',{exact:true}).selectOption('dotted');await frames();
  let current=await state();
  check(current.config.studies[0].paneScale.min===40&&current.config.studies[0].paneScale.max===60&&current.config.studies[0].referenceLevels[0].value===50&&current.config.studies[0].referenceLevels[0].label==='Midpoint','Fixed scale and custom reference saved');
  check(current.layout.panes.length===1,'Linked overlay remains in shared oscillator pane');
  check(JSON.stringify(original.data)===JSON.stringify(current.data),'Canonical and displayed market OHLC unchanged');
  const after=await page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)));
  check(JSON.stringify(before)===JSON.stringify(after),'Every calculated RSI and linked SMA value unchanged by display settings');
  await panel.getByRole('button',{name:/^Studies \(/}).click();await frames();await shot('desktop-fixed');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await frames();
  current=await state();check(current.config.studies[0].paneScale.min===40&&current.config.studies[0].referenceLevels[0].style==='dotted','Reload restores exact fixed limits and guide appearance');
  await openTools();await panel.getByRole('button',{name:/^Studies \(/}).click();await panel.getByLabel('RSI 1 Pane controls',{exact:true}).locator('summary').click();
  await page.setViewportSize({width:390,height:844});await frames();await openTools();
  await panel.getByLabel('RSI 1 Scale minimum',{exact:true}).scrollIntoViewIfNeeded();await shot('mobile-controls');
  check(await panel.getByRole('region',{name:'Study settings'}).evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Study settings fit 390px viewport');
  await panel.getByRole('button',{name:'RSI 1 Auto scale',exact:true}).click();check((await state()).config.studies[0].paneScale.mode==='auto','Auto scale selection applies');
  await panel.getByRole('button',{name:'RSI 1 Default scale',exact:true}).click();await panel.getByRole('button',{name:'RSI 1 Default reference levels',exact:true}).click();
  current=await state();check(!current.config.studies[0].paneScale&&!current.config.studies[0].referenceLevels,'Restore uses catalogue defaults');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart with no TradingView embed or logo');
  report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{
  report.network=await page.evaluate(()=>window.__readFixtureLog());
  const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];
  report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);
  if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;
 }
 return report;
}
