async page => {
  const report={passed:false,checks:[],snapshots:[],screenshots:[],failure:null,
    limitations:['Actual dashboard route in an isolated production fixture with an adapter observer; not the deployable bundle.',
      'Synthetic historical OHLC with unavailable AI truth. Active automatic analysis is not covered.',
      'Rendering opportunities and real series data are observed; hardware paint and latency targets are not measured.',
      'No broker tests and no matched TradingView or MT5 comparison.']};
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/scanner-shared-chart';
  function matchesExecutedBuild(runtimeId,metadata) {
    return typeof runtimeId==='string'&&runtimeId.length>0&&runtimeId===metadata?.buildId;
  }
  function matchesCompletedSeries(current,expected,context) {
    const {state,data}=current??{};
    if(!expected||!state||!data||state.symbol!==context.symbol||state.intervalSeconds!==context.intervalSeconds
      ||state.style!=='candles'||state.feed?.source!==expected.source||state.barCount!==expected.canonical.length
      ||!Array.isArray(data.canonical)||!Array.isArray(data.display))return false;
    const bar=point=>({time:point.time,open:point.open,high:point.high,low:point.low,close:point.close});
    return JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)
      &&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
  }
  async function waitForExpectedResponse(page,symbol,timeframe,deadline) {
    while(Date.now()<deadline) {
      const log=await page.evaluate(()=>window.__readFixtureLog());
      const expected=log.candleResponses.filter(item=>item.symbol===symbol&&item.timeframe===timeframe).at(-1);
      if(expected)return expected;
      const remaining=deadline-Date.now();
      if(remaining>0)await page.waitForTimeout(Math.min(25,remaining));
    }
    throw Error('No expected candle response before deadline: '+symbol+' '+timeframe);
  }
  // Classification changes the report, never the route barrier: every write
  // receives 503. Only these exact POSTs are known non-trading background work.
  function classifyWrite(request) {
    if(request.method==='GET'||request.method==='HEAD')return 'read';
    if(request.method==='POST'&&['/api/me/activity-ping','/api/me/chart/ai-alerts/scan'].includes(request.path))return 'background';
    // RubyScalpFocusCard requests this read on symbol/mode changes. Its route
    // evaluates scalpService analysis (including advisory traces), not orders.
    // It is still blocked: this is classification, not permission to execute it.
    if(request.method==='POST'&&request.path==='/api/me/scalp/focus')return 'analysis';
    // Scanner order/management routes, including preparation and confirmation.
    // Unknown writes still fail separately, so this list is not an allowlist.
    if(/^\/api\/(?:trades?(?:\/|$)|orders?(?:\/|$)|positions?(?:\/|$)|execution-confirmations(?:\/|$)|trade-actions?(?:-center)?(?:\/|$)|live-ops(?:\/|$)|(?:me\/)?(?:live|paper)\/(?:commands?|orders?|drafts?|positions?|execute|confirm|close|modify|cancel|reverse)(?:\/|$)|me\/(?:pending-order-drafts?(?:\/|$)|assistant\/instant-trade-command(?:\/|$)|chart\/decision-receipt(?:\/|$)))/.test(request.path))return 'trade';
    return 'unclassified';
  }
  const check=(condition,message)=>{if(!condition)throw Error(message);report.checks.push(message);};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const snapshot=()=>page.evaluate(()=>({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()}));
  const save=async label=>{const item=await snapshot();report.snapshots.push({label,...item});return item;};
  const screenshot=async label=>{const file=prefix+'-'+label+'.png';await page.screenshot({path:file,fullPage:false});report.screenshots.push(file);};
  const rangeWidth=state=>state.range.to-state.range.from;
  const waitSeries=async(symbol,timeframe,intervalSeconds)=>{
    // The response is the expected authority. Button state, query completion and
    // a nonempty canvas cannot satisfy this check without the actual series.
    const deadline=Date.now()+15000;
    const expected=await waitForExpectedResponse(page,symbol,timeframe,deadline);
    // Keep this predicate synchronous. The installed browser runner tests a
    // returned Promise's truthiness before awaiting it, so async false can end
    // polling immediately. Await response acquisition on the runner side.
    await page.waitForFunction(({symbol,timeframe,intervalSeconds,expected})=>{
      const state=window.__arxChartQa?.snapshot(),data=window.__arxChartQa?.data();
      if(!expected||!state||!data||state.symbol!==symbol||state.intervalSeconds!==intervalSeconds||state.style!=='candles'||state.feed.source!==expected.source)return false;
      const bar=point=>({time:point.time,open:point.open,high:point.high,low:point.low,close:point.close});
      return state.barCount===expected.canonical.length&&JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)
        &&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
    },{symbol,timeframe,intervalSeconds,expected},{timeout:Math.max(1,deadline-Date.now())});
    await frames();
    const current=await save(symbol+'-'+timeframe);
    const latestExpected=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.filter(item=>item.symbol===symbol&&item.timeframe===timeframe).at(-1);
    check(matchesCompletedSeries(current,latestExpected,{symbol,intervalSeconds}),'Full context, canonical and displayed bars match after a rendering opportunity: '+symbol+' '+timeframe);
    check(current.state.canvasIds.length>0&&current.state.bounds.width>0&&current.state.bounds.height>0,'Mounted canvas has dimensions: '+symbol+' '+timeframe);
    check(await page.locator('#tv-attr-logo').count()===0,'Completed chart renders without a TradingView logo: '+symbol+' '+timeframe);
    return current;
  };
  try {
    check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route is open');
    report.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('Build metadata unavailable');return r.json();});
    report.executedBuildId=await page.evaluate(()=>window.__arxScannerQaBuildId);
    check(matchesExecutedBuild(report.executedBuildId,report.build),'Executed fixture build matches fetched metadata');
    check(report.build.minified&&report.build.productionRuntimeChecked&&report.build.sourceUnchanged&&!report.build.source.status,'Clean unchanged production fixture source');
    check(report.build.dashboardUtilityCss?.source==='artifacts/trading-dashboard/src','Build checked real dashboard utility CSS');
    if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(report.build.source.head===SCANNER_QA_EXPECTED_COMMIT,'Build matches requested commit');
    const panel=page.getByTestId('scanner-chart-panel');
    check(await panel.getByTestId('arx-native-chart').count()===1,'Scanner owns exactly one shared Smart Chart');
    check(await panel.getByTestId('scanner-chart-canvas').count()===0,'Retired Scanner renderer is absent');
    check(await page.locator('iframe,embed,object,script[src*="tradingview.com"]').count()===0,'No embedded chart or TradingView widget');
    await panel.getByTestId('arx-native-tf-M15').click();
    const initial=await waitSeries('EURUSD','M15',900);
    await panel.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();
    report.desktopPlotIntersection=await panel.getByTestId('arx-native-canvas').evaluate(element=>{const b=element.getBoundingClientRect();return{width:Math.max(0,Math.min(b.right,innerWidth)-Math.max(b.left,0)),height:Math.max(0,Math.min(b.bottom,innerHeight)-Math.max(b.top,0))};});
    check(report.desktopPlotIntersection.width>=100&&report.desktopPlotIntersection.height>=100,'Desktop screenshot has a chart viewport intersection of at least 100 by 100 pixels');
    await screenshot('desktop');
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
    // Exercise a real price-series replacement while Scanner owns the overlay
    // bridge; canonical prices must survive and HA must use its exact formula.
    await panel.getByLabel('Chart style',{exact:true}).selectOption('heikinAshi');
    await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.style==='heikinAshi');await frames();
    const transformed=await save('scanner-heikin-ashi');let previousHa=null;
    const expectedHa=interval.data.canonical.map(bar=>{
      const close=(bar.open+bar.high+bar.low+bar.close)/4;
      const open=previousHa?(previousHa.open+previousHa.close)/2:(bar.open+bar.close)/2;
      const next={time:bar.time,open,high:Math.max(bar.high,open,close),low:Math.min(bar.low,open,close),close};previousHa=next;return next;
    });
    check(JSON.stringify(transformed.data.canonical)===JSON.stringify(interval.data.canonical),'Scanner style switch preserves original OHLC');
    check(JSON.stringify(transformed.data.display.map(bar=>({time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close})))===JSON.stringify(expectedHa),'Scanner displays formula-correct Heikin Ashi');
    check(transformed.state.seriesId!==interval.state.seriesId&&transformed.state.adapterId===interval.state.adapterId,'Scanner replaces the price series without replacing its chart engine');
    await panel.getByLabel('Chart style',{exact:true}).selectOption('candles');await waitSeries('GBPUSD','M5',300);
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
    await tools.click();await panel.getByLabel('Chart style',{exact:true}).waitFor({state:'visible'});await frames();
    check(await tools.getAttribute('aria-expanded')==='true'&&await panel.getByRole('button',{name:/^Studies \(/}).isVisible(),'Mobile tools expand and reveal style and study controls');
    await tools.click();await frames();
    const mobileAfter=await save('mobile-closed');
    check(mobileAfter.state.adapterId===mobileBefore.state.adapterId&&mobileAfter.state.candlesId===mobileBefore.state.candlesId&&JSON.stringify(mobileAfter.data.canonical)===JSON.stringify(mobileBefore.data.canonical),'Mobile tools preserve engine and exact canonical bars');
    check(!await panel.getByLabel('Chart style',{exact:true}).isVisible()&&!await panel.getByRole('button',{name:/^Studies \(/}).isVisible(),'Mobile tools close and hide style and study controls');
    check(await panel.getByRole('button',{name:'Zoom in chart',exact:true}).isVisible()&&await panel.getByRole('button',{name:'Zoom out chart',exact:true}).isVisible()
      &&await panel.getByRole('button',{name:'Pan to earlier candles',exact:true}).isVisible()&&await panel.getByRole('button',{name:'Pan to later candles',exact:true}).isVisible(),'Mobile zoom and pan remain visible with advanced tools closed');
    report.passed=true;
  } catch(error) {report.failure=String(error?.stack??error);try{await save('failure');await screenshot('failure');}catch(snapshotError){report.failureCaptureError=String(snapshotError);}}
  finally {
    try {
      report.network=await page.evaluate(()=>window.__readFixtureLog());
      const writes=report.network.blocked.filter(x=>x.kind==='mutation');
      report.blockedBackgroundRequests=writes.filter(x=>classifyWrite(x)==='background');
      report.blockedAnalysisRequests=writes.filter(x=>classifyWrite(x)==='analysis');
      report.tradeRequests=writes.filter(x=>classifyWrite(x)==='trade');
      report.unclassifiedWriteRequests=writes.filter(x=>classifyWrite(x)==='unclassified');
      const external=report.network.blocked.filter(x=>x.kind==='external'||x.kind==='websocket');
      if(report.tradeRequests.length||report.unclassifiedWriteRequests.length||external.length||report.network.errors.length){report.passed=false;report.networkFailure={tradeRequests:report.tradeRequests,unclassifiedWriteRequests:report.unclassifiedWriteRequests,external,pageErrors:report.network.errors};}
      report.noTradeRequests=report.tradeRequests.length===0;
      report.noWritesBeyondKnownNonTradingRequests=report.tradeRequests.length===0&&report.unclassifiedWriteRequests.length===0;
      report.allMutationRequestsBlocked=writes.every(x=>x.status===503)&&report.network.requests.filter(x=>x.method!=='GET').every(x=>x.status===503);
      if(!report.allMutationRequestsBlocked)report.passed=false;
    }catch(error){report.passed=false;report.logFailure=String(error);}
  }
  return report; // A successful CLI invocation is not acceptance; inspect passed.
}
