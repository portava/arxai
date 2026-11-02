// Run on the committed native production Scanner fixture with all APIs intercepted.
async page => {
 const report={passed:false,checks:[],screenshots:[],failure:null,limitations:['Synthetic offline Scanner; no broker, production-feed, latency parity or physical-touch claim.']};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));};
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 const values=()=>page.evaluate(()=>{const rows=window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time));return rows.map(row=>row.studies.map(study=>study.values.map(value=>value.value)));});
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean committed native production fixture');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');
  await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const openTools=async()=>{const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();};
  await openTools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();const initial=await state();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByRole('button',{name:'Add Relative strength index',exact:true}).click();
  await panel.getByRole('button',{name:'Add Simple moving average',exact:true}).click();
  await panel.getByLabel('SMA 2 Source',{exact:true}).selectOption({label:'1. RSI · RSI'});await frames();
  const before=await values();
  await panel.getByLabel('RSI 1 Interval visibility',{exact:true}).locator('summary').click();
  await panel.getByRole('button',{name:'RSI 1 Hide on all',exact:true}).click();await frames();
  let current=await state();check(current.config.studies[0].visibleIntervals.length===0&&current.layout.panes.length===1,'Hidden source keeps the visible linked overlay and shared pane');
  check(JSON.stringify(before)===JSON.stringify(await values()),'Hiding the source preserves every calculated source and linked value');
  check((await panel.getByLabel('Saved studies (interval visibility)',{exact:true}).textContent()).includes('hidden on'),'Legend names interval-hidden source');
  await panel.getByLabel('SMA 2 Interval visibility',{exact:true}).locator('summary').click();
  await panel.getByRole('button',{name:'SMA 2 Hide on all',exact:true}).click();await frames();
  current=await state();check(current.layout.panes.length===0&&current.config.studies.length===2,'Hiding both studies removes empty pane without removing settings');
  check(JSON.stringify(initial.data)===JSON.stringify(current.data),'Visibility changes preserve canonical and displayed OHLC');
  await panel.getByLabel('SMA 2 Visible on M30',{exact:true}).check();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByRole('button',{name:'M30 timeframe',exact:true}).click();
  await page.waitForFunction(()=>window.__arxChartQa.layout()?.panes.length===1);await frames();
  current=await state();check(current.config.studies[0].visibleIntervals.length===0&&current.config.studies[1].visibleIntervals.join(',')==='M30','Interval switch respects exact restrictions');
  check(current.data.canonical.length>2&&current.data.canonical[1].time-current.data.canonical[0].time===1800,'M30 view contains M30 source bars, not relabeled old candles');
  await shot('desktop-hidden-source');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await frames();
  current=await state();check(current.layout.panes.length===1&&current.config.studies[1].visibleIntervals.join(',')==='M30','Reload restores interval and visibility restrictions');
  await openTools();await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByLabel('SMA 2 Interval visibility',{exact:true}).locator('summary').click();
  await page.setViewportSize({width:390,height:844});await frames();await openTools();
  await panel.getByRole('button',{name:'SMA 2 Current and above',exact:true}).click();await frames();
  current=await state();check(current.config.studies[1].visibleIntervals.includes('M30')&&current.config.studies[1].visibleIntervals.includes('D1')&&!current.config.studies[1].visibleIntervals.includes('M15'),'Narrow viewport quick visibility uses duration order');
  await panel.getByLabel('SMA 2 Visible on M30',{exact:true}).scrollIntoViewIfNeeded();await shot('mobile-visibility');
  check(await panel.getByRole('region',{name:'Study settings'}).evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Study settings fit narrow viewport');
  await panel.getByRole('button',{name:'SMA 2 All intervals',exact:true}).click();check((await state()).config.studies[1].visibleIntervals===undefined,'All intervals restores unrestricted display');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed or logo');
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
