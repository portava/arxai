// Actual Scanner reach-start and /live-chart position-picker parent acceptance.
// Use native-parent-history-hooks.js with the existing shared setup boundary.
async page => {
  const out={passed:false,checks:[],limitations:['Synthetic HTTP fixtures, not broker/history-provider validation.','Position rows are read-only DEMO-shaped fixtures; no order, close or modify control is used.','No first-navigation or physical-paint timing claim.']};
  const check=(ok,label)=>{if(!ok)throw Error(label);out.checks.push(label);};
  const frame=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const snapshot=()=>page.evaluate(()=>Array.from({length:window.__arxChartQa.count()},(_,i)=>window.__arxChartQa.snapshot(i)));
  const ready=async count=>page.waitForFunction(count=>window.__arxChartQa?.count()===count&&Array.from({length:count},(_,i)=>window.__arxChartQa.snapshot(i)).every(s=>s?.engineId==='arx-native'&&s.renderVerified===true&&s.barCount>0&&!s.state.pendingPaint),count);
  try {
    out.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');return r.json();});
    check(out.build.productDefaultEngineId==='arx-native'&&out.build.qaOnlyDefaultEngineOverride===false&&out.build.productionRuntimeChecked===true&&out.build.sourceUnchanged&&!out.build.source.status&&await page.evaluate(()=>window.__arxScannerQaBuildId)===out.build.buildId,'Exact executed production native default without source override');
    await page.setViewportSize({width:1440,height:1100});await ready(1);
    const initial=(await snapshot())[0];out.initial=initial;
    const original=await page.evaluate(()=>window.__arxChartQa.data().canonical);
    const canvas=page.getByTestId('arx-native-canvas');await canvas.scrollIntoViewIfNeeded();await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(count=>window.__arxChartQa.snapshot()?.barCount===count&&window.__arxChartQa.snapshot()?.renderVerified===true&&!window.__arxChartQa.snapshot()?.state.pendingPaint,original.length+60);
    const histories=await page.evaluate(()=>window.__readNativeHistoryFixture());
    const current=(await snapshot())[0],loaded=await page.evaluate(()=>window.__arxChartQa.data().canonical);
    check(histories.length===1,'Actual reach-start requests one source-bound history page');
    check(JSON.stringify(loaded)===JSON.stringify([...histories[0].canonical,...original]),'Native completed series equals exact older page plus unchanged current candles');
    check(current.adapterId===initial.adapterId,'History prepend retains the renderer');
    await page.keyboard.press('Home');await frame();
    check((await page.evaluate(()=>window.__readNativeHistoryFixture())).length===1,'Provider ceiling prevents repeated history requests');
    check(await page.getByTestId('chart-library-credit').count()===0,'Scanner uses native credit, not TradingView renderer credit');
    await page.goto('http://127.0.0.1:4199/live-chart');await ready(1);
    check(await page.evaluate(()=>window.__arxScannerQaBuildId)===out.build.buildId,'Position parent page executes same pinned build');
    await page.getByTestId('btn-select-position-demo-fixture-eur').click();await ready(2);
    let snapshots=await snapshot(),index=snapshots.findIndex(s=>s.testId==='position-mini-chart');
    check(index>=0,'Actual position selection mounts a native 100-bar preview');
    const eur=snapshots[index],expected=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(r=>r.symbol==='EURUSD'&&new URLSearchParams(r.requestQuery).get('limit')==='100').at(-1);
    check(expected&&JSON.stringify(await page.evaluate(i=>window.__arxChartQa.data(i).canonical,index))===JSON.stringify(expected.canonical),'Position parent preserves exact request-bound EURUSD OHLC');
    check(eur.state.scannerOverlays.markerCount===0&&eur.state.livePriceAffordance===false,'Historical position preview invents no entry-time marker or live price');
    await page.getByTestId('btn-select-position-demo-fixture-gbp').click();await ready(2);
    await page.waitForFunction(()=>Array.from({length:window.__arxChartQa.count()},(_,i)=>window.__arxChartQa.snapshot(i)).some(s=>s.symbol==='GBPUSD'&&s.barCount===100&&s.renderVerified===true));
    snapshots=await snapshot();index=snapshots.findIndex(s=>s.symbol==='GBPUSD'&&s.barCount===100);
    const gbpExpected=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(r=>r.symbol==='GBPUSD'&&new URLSearchParams(r.requestQuery).get('limit')==='100').at(-1);
    check(JSON.stringify(await page.evaluate(i=>window.__arxChartQa.data(i).canonical,index))===JSON.stringify(gbpExpected.canonical),'Switching position uses exact GBPUSD source, no EURUSD carryover');
    await page.setViewportSize({width:390,height:844});await ready(2);
    out.mobileSizes=[];
    for(let i=0;i<6;i++){
      out.mobileSizes.push(await snapshot());
      await page.waitForTimeout(150);
    }
    check(out.mobileSizes.every(views=>views.every(s=>s.bounds.width>0&&s.bounds.x>=-1&&s.bounds.x+s.bounds.width<=391)),'Both actual-parent charts remain inside mobile viewport across resize observations');
    check(out.mobileSizes.every(views=>views.every((s,i)=>Math.abs(s.bounds.width-out.mobileSizes.at(-1)[i].bounds.width)<1)),'Position selection causes no progressive canvas/parent width growth');
    const mini=page.getByTestId('position-mini-chart');await mini.scrollIntoViewIfNeeded();await frame();
    const bounds=await mini.boundingBox();check(bounds&&bounds.width>0&&bounds.x>=-1&&bounds.x+bounds.width<=391,'Actual parent position preview fits mobile viewport');
    await page.getByTestId('btn-close-side-card').click();await ready(1);
    check(await page.getByTestId('position-mini-chart').count()===0,'Closing preview disposes its native renderer');
    check(await page.getByTestId('chart-library-credit').count()===0&&await page.locator('#tv-attr-logo').count()===0,'Parent route has no active TradingView chart credit or logo');
    out.fixture=await page.evaluate(()=>window.__readFixtureLog());
    check(out.fixture.errors.length===0,'No page exceptions');
    check(!out.fixture.blocked.some(x=>x.kind==='external'||x.kind==='websocket'),'No external feed or broker requests');
    check(!out.fixture.requests.some(r=>r.method!=='GET'&&/positions.*(?:close|modify)|live-intent|\/execute|\/orders|\/commands/.test(r.path)),'No trade action request attempted');
    out.final=await snapshot();out.passed=true;
  } catch(error){out.failure=String(error);out.fixture=await page.evaluate(()=>window.__readFixtureLog());}
  return out;
}
