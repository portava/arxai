async page => {
  const report={passed:false,checks:[],snapshots:[],screenshots:[],failure:null,
    limitations:['Actual dashboard route in an isolated production fixture with an adapter observer; not the deployable bundle.',
      'Synthetic historical OHLC with unavailable AI truth. Active automatic analysis is not covered.',
      'Rendering opportunities and real series data are observed; hardware paint and latency targets are not measured.',
      'No broker tests and no matched TradingView or MT5 comparison.']};
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/scanner-shared-chart';
  const check=(condition,message)=>{if(!condition)throw Error(message);report.checks.push(message);};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const snapshot=()=>page.evaluate(()=>({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()}));
  const save=async label=>{const item=await snapshot();report.snapshots.push({label,...item});return item;};
  const screenshot=async label=>{const file=prefix+'-'+label+'.png';await page.screenshot({path:file,fullPage:false});report.screenshots.push(file);};
  const rangeWidth=state=>state.range.to-state.range.from;
  const waitSeries=async(symbol,timeframe,intervalSeconds)=>{
    // The response is the expected authority. Button state, query completion and
    // a nonempty canvas cannot satisfy this check without the actual series.
    await page.waitForFunction(async({symbol,timeframe,intervalSeconds})=>{
      const log=await window.__readFixtureLog();
      const expected=log.candleResponses.filter(item=>item.symbol===symbol&&item.timeframe===timeframe).at(-1);
      const state=window.__arxChartQa?.snapshot(),data=window.__arxChartQa?.data();
      if(!expected||!state||!data||state.symbol!==symbol||state.intervalSeconds!==intervalSeconds||state.style!=='candles'||state.feed.source!==expected.source)return false;
      const bar=point=>({time:point.time,open:point.open,high:point.high,low:point.low,close:point.close});
      return state.barCount===expected.canonical.length&&JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)
        &&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
    },{symbol,timeframe,intervalSeconds},{timeout:15000});
    await frames();
    const current=await save(symbol+'-'+timeframe);
    const expected=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(item=>item.symbol===symbol&&item.timeframe===timeframe).at(-1);
    check(JSON.stringify(current.data.canonical)===JSON.stringify(expected.canonical),'Canonical bars match response after a rendering opportunity: '+symbol+' '+timeframe);
    check(current.state.canvasIds.length>0&&current.state.bounds.width>0&&current.state.bounds.height>0,'Real visible canvas: '+symbol+' '+timeframe);
    return current;
  };
  try {
    check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route is open');
    report.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('Build metadata unavailable');return r.json();});
    check(report.build.minified&&report.build.productionRuntimeChecked&&report.build.sourceUnchanged&&!report.build.source.status,'Clean unchanged production fixture source');
    if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(report.build.source.head===SCANNER_QA_EXPECTED_COMMIT,'Build matches requested commit');
    const panel=page.getByTestId('scanner-chart-panel');
    check(await panel.getByTestId('arx-native-chart').count()===1,'Scanner owns exactly one shared Smart Chart');
    check(await panel.getByTestId('scanner-chart-canvas').count()===0,'Retired Scanner renderer is absent');
    check(await page.locator('iframe,embed,object,script[src*="tradingview.com"]').count()===0,'No embedded chart or TradingView widget');
    await panel.getByTestId('arx-native-tf-M15').click();
    const initial=await waitSeries('EURUSD','M15',900);
    await panel.scrollIntoViewIfNeeded();await screenshot('desktop');
    const pick=async symbol=>{
      const selected=page.getByTestId('selected-market-panel');
      const chip=selected.getByTestId('chip-symbol-'+symbol);
      if(!await chip.isVisible())await selected.getByTestId('category-chip-forex').click();
      await chip.click();
      await page.waitForFunction(symbol=>document.querySelector('[data-testid="badge-active-symbol"]')?.textContent===symbol,symbol);
    };
    await pick('GBPUSD');const selected=await waitSeries('GBPUSD','M15',900);
    check(selected.state.adapterId===initial.state.adapterId&&JSON.stringify(selected.state.canvasIds)===JSON.stringify(initial.state.canvasIds),'Symbol selection retains the shared chart engine and canvas');
    await panel.getByTestId('arx-native-tf-M5').click();
    const interval=await waitSeries('GBPUSD','M5',300);
    check(interval.state.adapterId===initial.state.adapterId,'Timeframe selection retains the shared engine');
    const tools=panel.getByRole('button',{name:'Chart tools',exact:true});
    if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
    await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();
    let before=(await save('fit')).state;
    await panel.getByRole('button',{name:'Zoom in chart',exact:true}).click();
    await page.waitForFunction(width=>{const s=window.__arxChartQa.snapshot();return s?.range&&s.range.to-s.range.from<width-.01;},rangeWidth(before));
    await frames();let after=(await save('zoom-in')).state;
    check(rangeWidth(after)<rangeWidth(before),'Zoom in reduces actual visible logical range');
    before=after;await panel.getByRole('button',{name:'Zoom out chart',exact:true}).click();
    await page.waitForFunction(width=>{const s=window.__arxChartQa.snapshot();return s?.range&&s.range.to-s.range.from>width+.01;},rangeWidth(before));
    await frames();after=(await save('zoom-out')).state;check(rangeWidth(after)>rangeWidth(before),'Zoom out expands actual visible logical range');
    // Zoom once more so both pan directions have room inside the loaded window.
    await panel.getByRole('button',{name:'Zoom in chart',exact:true}).click();await frames();before=(await snapshot()).state;
    await panel.getByRole('button',{name:'Pan to earlier candles',exact:true}).click();
    await page.waitForFunction(from=>window.__arxChartQa.snapshot()?.range?.from<from-.01,before.range.from);await frames();
    after=(await save('pan-earlier')).state;check(after.range.from<before.range.from,'Earlier pan changes the actual range toward older bars');
    before=after;await panel.getByRole('button',{name:'Pan to later candles',exact:true}).click();
    await page.waitForFunction(from=>window.__arxChartQa.snapshot()?.range?.from>from+.01,before.range.from);await frames();
    after=(await save('pan-later')).state;check(after.range.from>before.range.from,'Later pan changes the actual range toward newer bars');
    const canvas=panel.getByTestId('arx-native-canvas');await canvas.scrollIntoViewIfNeeded();
    before=(await snapshot()).state;await canvas.focus();await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(from=>window.__arxChartQa.snapshot()?.range?.from<from-.01,before.range.from);await frames();
    check((await save('keyboard-pan')).state.range.from<before.range.from,'Keyboard pan reaches the real chart');
    const box=await canvas.boundingBox();check(!!box,'Canvas has a pointer target');before=(await snapshot()).state;
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.5);await page.mouse.down();
    try{await page.mouse.move(box.x+box.width*.55+65,box.y+box.height*.5,{steps:8});}finally{await page.mouse.up();}
    await page.waitForFunction(from=>Math.abs(window.__arxChartQa.snapshot().range.from-from)>.01,before.range.from);await frames();
    check(Math.abs((await save('drag-pan')).state.range.from-before.range.from)>.01,'Pointer drag changes the real chart range');
    await waitSeries('GBPUSD','M5',300);
    const reader=panel.getByTestId('smart-chart-reader');
    check(await reader.count()===1&&await reader.getAttribute('data-analysis-status')!=='ready','Synthetic unavailable truth is not promoted to ready analysis');
    check((await panel.getByTestId('chart-reader-explanation').textContent()).trim().length>0,'Reader explains its unavailable state');
    await page.setViewportSize({width:390,height:844});await frames();await panel.scrollIntoViewIfNeeded();
    const mobileBefore=await snapshot();
    await tools.waitFor({state:'visible'});
    if(await tools.getAttribute('aria-expanded')==='true')await tools.click();
    await frames();await screenshot('mobile-closed');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile page has no horizontal overflow');
    await tools.click();await panel.getByRole('button',{name:'Zoom in chart',exact:true}).waitFor({state:'visible'});await frames();
    check(await tools.getAttribute('aria-expanded')==='true','Mobile tools expand and reveal real chart controls');
    await tools.click();await frames();
    const mobileAfter=await save('mobile-closed');
    check(mobileAfter.state.adapterId===mobileBefore.state.adapterId&&mobileAfter.state.candlesId===mobileBefore.state.candlesId&&JSON.stringify(mobileAfter.data.canonical)===JSON.stringify(mobileBefore.data.canonical),'Mobile tools preserve engine and exact canonical bars');
    check(!await panel.getByRole('button',{name:'Zoom in chart',exact:true}).isVisible(),'Mobile tools close and hide advanced controls');
    report.passed=true;
  } catch(error) {report.failure=String(error?.stack??error);try{await save('failure');await screenshot('failure');}catch(snapshotError){report.failureCaptureError=String(snapshotError);}}
  finally {
    try {
      report.network=await page.evaluate(()=>window.__readFixtureLog());
      // The app presence hook may attempt this write. It must be blocked too;
      // recording it separately is not an exemption permitting any mutation.
      report.blockedPresenceRequests=report.network.blocked.filter(x=>x.kind==='mutation'&&x.path==='/api/me/activity-ping');
      const otherMutations=report.network.blocked.filter(x=>x.kind==='mutation'&&x.path!=='/api/me/activity-ping');
      const external=report.network.blocked.filter(x=>x.kind==='external'||x.kind==='websocket');
      if(otherMutations.length||external.length||report.network.errors.length){report.passed=false;report.networkFailure={otherMutations,external,pageErrors:report.network.errors};}
      report.noTradeRequests=otherMutations.length===0;
      report.allMutationRequestsBlocked=report.network.requests.filter(x=>x.method!=='GET').every(x=>x.status===503);
      if(!report.allMutationRequestsBlocked)report.passed=false;
    }catch(error){report.passed=false;report.logFailure=String(error);}
  }
  return report; // A successful CLI invocation is not acceptance; inspect passed.
}
