// Run only with the intercepted, synthetic-history Scanner fixture.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>window.__arxChartQa.snapshot().state);};
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default build');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const openTools=async()=>{const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();};
  await openTools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();
  await panel.getByRole('button',{name:/^Studies \(/}).click();await panel.getByRole('button',{name:'Add Relative strength index',exact:true}).click();await panel.getByRole('button',{name:/^Studies \(/}).click();
  const original=await page.evaluate(()=>window.__arxChartQa.data());
  const bars=original.canonical;
  await panel.locator('summary').filter({hasText:'Data window · study values at the crosshair'}).click();
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();
  let s=await state();check(s.inspectionPinned&&s.inspectionTime===bars.at(-1).time,'Button pins latest visible actual candle');
  const output=panel.getByLabel('Study values at selected candle',{exact:true});
  await output.filter({hasText:'RSI'}).waitFor({state:'visible'});await state();
  check((await output.textContent()).includes('RSI'),'Pinned Data Window displays study values');
  const canvas=panel.locator('canvas[data-arx-native-viewport]');
  const text=await panel.getByTestId('chart-candle-inspector').textContent();
  await canvas.hover({position:{x:250,y:150}});await state();
  await panel.getByRole('button',{name:'Previous candle',exact:true}).hover();await state();
  check((await panel.getByTestId('chart-candle-inspector').textContent())===text&&(await state()).inspectionPinned,'Pointer can leave canvas without losing pinned values');
  await panel.getByRole('button',{name:'Previous candle',exact:true}).click();s=await state();
  check(s.inspectionTime===bars.at(-2).time,'Previous control selects the preceding observed timestamp');
  await canvas.focus();await page.keyboard.press('Shift+ArrowLeft');s=await state();
  check(s.inspectionTime===bars.at(-3).time,'Focused Shift+Left selects another loaded candle');
  await page.keyboard.press('Shift+Home');s=await state();check(s.inspectionTime===bars[0].time,'Shift+Home reveals first loaded candle');
  await page.keyboard.press('Shift+End');s=await state();check(s.inspectionTime===bars.at(-1).time,'Shift+End reveals last loaded candle');
  await page.keyboard.press('Escape');s=await state();check(!s.inspectionPinned&&await panel.getByRole('button',{name:'Exit fullscreen',exact:true}).isVisible(),'Escape releases inspection without closing fullscreen');
  check(JSON.stringify(await page.evaluate(()=>window.__arxChartQa.data().canonical))===JSON.stringify(bars),'Inspection does not modify canonical OHLC');
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();await state();
  await openTools();await panel.getByRole('button',{name:'M30 timeframe',exact:true}).click();s=await state();
  check(!s.inspectionPinned,'Timeframe change withdraws the pinned selection');
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();await state();
  await page.reload();await state();check(!(await state()).inspectionPinned,'Reload does not resurrect historical inspection');
  await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.setViewportSize({width:390,height:844});await state();
  await panel.getByRole('button',{name:'Inspect latest visible candle',exact:true}).click();await state();
  await panel.getByRole('button',{name:'Previous candle',exact:true}).click();await state();
  const group=panel.getByRole('group',{name:'Candle inspection',exact:true});await group.scrollIntoViewIfNeeded();await shot('mobile-inspection');
  check(await group.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Inspection controls fit narrow viewport');
  await panel.getByRole('button',{name:'Release candle',exact:true}).click();check(!(await state()).inspectionPinned,'Narrow viewport can release inspection');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native rendering without TradingView embed/logo');
  report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
