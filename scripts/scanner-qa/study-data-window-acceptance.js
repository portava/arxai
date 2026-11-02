// Actual native Scanner, synthetic source and fully intercepted APIs required.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null,limitations:['Offline synthetic Scanner only; no broker, physical device or performance parity claim.']};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));};
 const values=()=>page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)));
 const numbers=rows=>rows.map(row=>({time:row.time,values:row.studies.map(study=>study.values.map(v=>v.value))}));
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default build');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const openTools=async()=>{const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();};
  await openTools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByRole('button',{name:'Add Relative strength index',exact:true}).click();
  await panel.getByRole('button',{name:'Add Simple moving average',exact:true}).click();
  await panel.getByLabel('SMA 2 Source',{exact:true}).selectOption({label:'1. RSI · RSI'});
  const before=await state(),original=await values();
  await panel.getByLabel('RSI 1 Show in Data Window',{exact:true}).uncheck();
  let current=await state(),raw=await values();
  check(current.config.studies[0].showInDataWindow===false&&current.layout.panes.length===1,'Readout preference saved independently of plotted pane');
  check(JSON.stringify(before.data)===JSON.stringify(current.data)&&JSON.stringify(before.layout)===JSON.stringify(current.layout),'Readout toggle preserves source OHLC and plot geometry');
  check(JSON.stringify(numbers(original))===JSON.stringify(numbers(raw)),'All source and linked calculations unchanged');
  check(raw.every(row=>row.studies[0].dataWindowVisible===false)&&raw.some(row=>row.studies[0].values[0].value!==null),'Hidden readout retains actual calculated evidence');
  const output=panel.getByLabel('Study values at selected candle',{exact:true});
  await panel.locator('summary').filter({hasText:'Data window · study values at the crosshair'}).click();
  const canvas=panel.locator('canvas[data-arx-native-viewport]');
  const inspect=async()=>{await canvas.hover({position:{x:250,y:200}});await state();};
  await inspect();let text=await output.textContent();report.readout=text;
  check(text.includes('SMA')&&!text.includes('RSI (14)'),'Data Window displays selected SMA and omits deselected RSI');
  // Keyboard activation changes the real checkbox without moving the chart pointer.
  const selectedBefore=await panel.getByTestId('chart-candle-inspector').textContent();
  await panel.getByLabel('SMA 2 Show in Data Window',{exact:true}).evaluate(node=>node.focus({preventScroll:true}));
  await page.keyboard.press('Space');await state();
  check((await state()).config.studies[1].showInDataWindow===false,'Keyboard activates the actual readout control');
  check(await panel.getByTestId('chart-candle-inspector').textContent()===selectedBefore,'Readout-only change retains the inspected candle');
  check((await output.textContent()).includes('All study readouts are hidden'),'All-hidden state explains how to restore readouts');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();current=await state();
  check(current.config.studies.every(s=>s.showInDataWindow===false)&&current.layout.panes.length===1,'Reload restores readout choices without removing plots');
  await openTools();await panel.getByRole('button',{name:/^Studies \(/}).click();
  await page.setViewportSize({width:390,height:844});await openTools();
  await panel.getByLabel('SMA 2 Show in Data Window',{exact:true}).check();await state();
  check((await state()).config.studies[1].showInDataWindow===true,'Narrow viewport can restore a single readout');
  await panel.getByLabel('SMA 2 Show in Data Window',{exact:true}).scrollIntoViewIfNeeded();await shot('mobile-controls');
  check(await panel.getByRole('region',{name:'Study settings'}).evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Study controls fit narrow viewport');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native rendering without TradingView embed/logo');
  report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
