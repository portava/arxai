// Playwright CLI; actual app native QA build, intercepted synthetic clock
// contract fixture, then an isolated actual PositionMiniChart component.
async page => {
 const result={passed:false,checks:[],screenshots:[],limitations:['Synthetic data and QA-only native override; no live account or broker.','No latency/parity/default-renderer acceptance. Mini route is isolated component acceptance, not its account-page integration.']};
 const check=(yes,label)=>{if(!yes)throw Error(label);result.checks.push(label);};
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const snap=()=>page.evaluate(()=>window.__arxChartQa.snapshot());
 const ready=()=>page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.barCount>0&&s.state.status==='ready'&&!s.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified;});
 const text=()=>page.locator('canvas[data-arx-native-viewport]').first().evaluate(canvas=>canvas.__qaPaintedText??[]);
 const sourceLabels=async()=>{const labels=await text();check(labels.some(l=>/source/.test(l.text)),'Completed canvas contains explicit source-clock label');check(!labels.some(l=>/ UTC$|GMT[+-]| EST$| EDT$/.test(l.text)),'Unqualified canvas does not claim UTC or converted zone');return labels;};
 try{
  result.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');return r.json();});
  check(result.build.nativeEngine&&result.build.qaOnlyDefaultEngineOverride&&result.build.productionRuntimeChecked&&result.build.sourceUnchanged&&!result.build.source.status,'Clean exact-source native QA build');
  check(await page.evaluate(()=>window.__arxScannerQaBuildId)===result.build.buildId,'Executed Scanner entry matches immutable build identity');
  await ready();const chart=page.getByTestId('arx-native-chart').first();
  const tools=chart.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
  const canonical=await page.evaluate(()=>window.__arxChartQa.data().canonical),initial=await snap();
  check(initial.state.utcClockQualified===true,'Synthetic original-UTC contract is forwarded to real native engine');
  await chart.getByLabel('Display time zone',{exact:true}).selectOption('America/New_York');await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.state.effectiveTimeZone==='America/New_York');await ready();
  check((await snap()).state.effectiveTimeZone==='America/New_York','Qualified chart accepts selected New York display zone');
  check((await text()).some(l=>/(?:GMT-5|EST)$/.test(l.text)),'Actual January axis paint uses New York offset');
  await page.evaluate(()=>window.__fixtureSetClockQualified(false));
  await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.state.utcClockQualified===false&&!s.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified;},null,{timeout:20000});
  check((await snap()).adapterId===initial.adapterId,'Evidence withdrawal retains adapter');
  check(JSON.stringify(await page.evaluate(()=>window.__arxChartQa.data().canonical))===JSON.stringify(canonical),'Clock withdrawal does not alter canonical candles');
  result.desktopLabels=await sourceLabels();
  await chart.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();
  await page.screenshot({path:'native-clock-desktop.png',fullPage:false});result.screenshots.push('native-clock-desktop.png');
  const downloading=page.waitForEvent('download');await chart.getByRole('button',{name:'Export PNG',exact:true}).click();
  const download=await downloading;await download.saveAs('native-clock-export.png');result.screenshots.push('native-clock-export.png');
  check(download.suggestedFilename().startsWith('ARX-EURUSD-'),'Source-clock PNG downloaded for selected instrument');
  await page.setViewportSize({width:390,height:844});await ready();await chart.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();
  result.mobileLabels=await sourceLabels();await page.screenshot({path:'native-clock-mobile.png',fullPage:false});result.screenshots.push('native-clock-mobile.png');
  await page.goto('http://127.0.0.1:4199/position-mini-qa');await ready();
  check(await page.evaluate(()=>window.__arxScannerQaBuildId)===result.build.buildId,'Executed mini entry matches the same immutable build');
  const mini=page.getByTestId('position-mini-chart');const before=await snap();
  check(await mini.getAttribute('inert')!==null,'Position preview disables inherited engine interactions');
  check(before.state.utcClockQualified===false,'Position preview cannot qualify clock from numeric timestamps');
  check(before.state.scannerOverlays.priceLineCount===4&&before.state.scannerOverlays.markerCount===0,'Entry/current/SL/TP references exist without fabricated entry-time marker');
  await page.getByRole('button',{name:'Update supplied snapshot',exact:true}).click();await ready();
  check((await snap()).adapterId===before.adapterId&&(await snap()).last.close===1.1082,'Position update retains actual renderer and applies supplied close');
  await page.getByRole('button',{name:'Withdraw live verdict',exact:true}).click();await ready();
  check((await snap()).state.livePriceAffordance===false&&(await snap()).state.scannerOverlays.priceLineCount===3,'Stale verdict removes current line and live-price affordance');
  await page.getByRole('button',{name:'Change symbol',exact:true}).click();await ready();
  check((await snap()).adapterId===before.adapterId&&(await snap()).symbol==='GBPUSD','Symbol reset preserves mini renderer and changes context');
  const range=(await snap()).range;await mini.scrollIntoViewIfNeeded();const box=await mini.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,150);await frames();
  check(JSON.stringify((await snap()).range)===JSON.stringify(range),'Wheel over inert mini preview does not zoom candles');
  await mini.scrollIntoViewIfNeeded();await frames();await sourceLabels();await page.screenshot({path:'native-position-mobile.png',fullPage:false});result.screenshots.push('native-position-mobile.png');
  await page.getByRole('button',{name:'Clear candles',exact:true}).click();
  await page.waitForFunction(()=>window.__arxChartQa.count()===0);check(await page.getByTestId('position-mini-chart-empty').isVisible(),'Empty mini source withdraws renderer');
  await page.getByRole('button',{name:'Restore candles',exact:true}).click();await ready();check((await snap()).adapterId!==before.adapterId,'Restored mini data creates a clean renderer');
  result.fixture=await page.evaluate(()=>window.__readFixtureLog());
  check(result.fixture.errors.length===0,'No browser exceptions');check(!result.fixture.blocked.some(x=>x.kind==='external'||x.kind==='websocket'),'No external data/broker requests');
  result.passed=true;
 }catch(error){result.failure=String(error);result.fixture=await page.evaluate(()=>window.__readFixtureLog());}
 return result;
}
