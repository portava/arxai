async page => {
  // Run shared-chart-setup.js first in a fresh isolated session. Its route
  // barrier and log persist across full navigations; every write remains 503.
  const report={passed:false,checks:[],pages:[],screenshots:[],failure:null,limitations:[
    'Actual routes/providers in an isolated production fixture; not the deployable bundle.',
    'Synthetic historical candles and unavailable truth; no active analysis or broker acceptance.',
    'No order, confirmation, approval or test-loop control is clicked. Server gates are not exercised.',
    'Enabled review/test controls are not claimed to be disabled trading gates.',
    'Unknown API reads and their console errors remain recorded; no latency or hardware paint claim.',
  ]};
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/shared-chart-pages';
  const routes=['/live-chart','/live-manual','/live-ai-assist','/live-ai-auto-test'];
  const check=(condition,message)=>{if(!condition)throw Error(message);report.checks.push(message);};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const log=()=>page.evaluate(()=>window.__readFixtureLog());
  const snapshot=()=>page.evaluate(()=>({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()}));
  function completedSeries(current,expected,context) {
    const {state,data}=current??{};
    if(!state||!data||!expected?.canonical?.length||state.symbol!==context.symbol||state.intervalSeconds!==context.intervalSeconds
      ||state.style!=='candles'||state.feed?.source!==expected.source||state.barCount!==expected.canonical.length
      ||!Array.isArray(data.canonical)||!Array.isArray(data.display))return false;
    const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
    return JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)
      &&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
  }
  async function expectedResponse(page,symbol,timeframe,offset,deadline) {
    while(Date.now()<deadline) {
      const value=await page.evaluate(()=>window.__readFixtureLog());
      const expected=value.candleResponses.slice(offset).filter(x=>x.symbol===symbol&&x.timeframe===timeframe).at(-1);
      if(expected)return expected;
      const remaining=deadline-Date.now();
      if(remaining>0)await page.waitForTimeout(Math.min(25,remaining));
    }
    throw Error('No current-page candle response: '+symbol+' '+timeframe);
  }
  function classifyWrite(request) {
    if(request.method==='GET'||request.method==='HEAD')return 'read';
    if(request.method==='POST'&&['/api/me/activity-ping','/api/me/chart/ai-alerts/scan'].includes(request.path))return 'background';
    if(request.method==='POST'&&request.path==='/api/me/scalp/focus')return 'analysis';
    // The secondary pages also contain tester intent routes. Even an audit-only
    // attempt is a failure here: this acceptance never starts their workflows.
    if(/^\/api\/(?:live-intent(?:\/|$)|(?:tester|ai-live-test)(?:\/|$)|trades?(?:\/|$)|orders?(?:\/|$)|positions?(?:\/|$)|execution-confirmations(?:\/|$)|trade-actions?(?:-center)?(?:\/|$)|live-ops(?:\/|$)|(?:me\/)?(?:live|paper)\/(?:commands?|orders?|drafts?|positions?|execute|confirm|close|modify|cancel|reverse)(?:\/|$)|me\/(?:pending-order-drafts?(?:\/|$)|assistant\/instant-trade-command(?:\/|$)|chart\/decision-receipt(?:\/|$)))/.test(request.path))return 'trade';
    return 'unclassified';
  }
  async function waitSeries(symbol,timeframe,intervalSeconds,offset,entry) {
    const deadline=Date.now()+15000;
    const expected=await expectedResponse(page,symbol,timeframe,offset,deadline);
    // Primitive synchronous result only. The installed runner can treat a
    // Promise returned by an async predicate as an immediate truthy success.
    await page.waitForFunction(({symbol,intervalSeconds,expected})=>{
      const state=window.__arxChartQa?.snapshot(),data=window.__arxChartQa?.data();
      if(!state||!data||!expected?.canonical?.length||state.symbol!==symbol||state.intervalSeconds!==intervalSeconds||state.style!=='candles'
        ||state.feed?.source!==expected.source||state.barCount!==expected.canonical.length
        ||!Array.isArray(data.canonical)||!Array.isArray(data.display))return false;
      const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
      return JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)
        &&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
    },{symbol,intervalSeconds,expected},{timeout:Math.max(1,deadline-Date.now())});
    await frames();
    const current=await snapshot();
    const latest=(await log()).candleResponses.slice(offset).filter(x=>x.symbol===symbol&&x.timeframe===timeframe).at(-1);
    check(completedSeries(current,latest,{symbol,intervalSeconds}),entry.route+': exact context, canonical and displayed bars after two frames: '+symbol+' '+timeframe);
    check(current.state.canvasIds.length>0&&current.state.bounds.width>0&&current.state.bounds.height>0,entry.route+': native canvas is mounted with dimensions');
    check(await page.locator('#tv-attr-logo').count()===0,entry.route+': completed chart has no TradingView logo');
    entry.snapshots.push({label:symbol+'-'+timeframe,...current});
    return current;
  }
  async function screenshot(entry,label) {
    const canvas=page.getByTestId('arx-native-canvas');await canvas.scrollIntoViewIfNeeded();await frames();
    const intersection=await canvas.evaluate(element=>{const b=element.getBoundingClientRect();return{width:Math.max(0,Math.min(b.right,innerWidth)-Math.max(b.left,0)),height:Math.max(0,Math.min(b.bottom,innerHeight)-Math.max(b.top,0))};});
    check(intersection.width>=100&&intersection.height>=100,entry.route+': '+label+' screenshot includes at least 100 by 100 pixels of the chart');
    const path=prefix+'-'+entry.route.slice(1)+'-'+label+'.png';await page.screenshot({path,fullPage:false});
    entry.screenshots.push({path,intersection});report.screenshots.push(path);
  }
  try {
    const origin=new URL(page.url()).origin;
    check(new URL(origin).hostname==='127.0.0.1','Page acceptance is loopback only');
    const initialLog=await log();check(Array.isArray(initialLog.candleResponses),'Offline interception and response log are installed');
    for(const route of routes) {
      const entry={route,snapshots:[],screenshots:[],passed:false};report.pages.push(entry);
      const before=await log(),offset=before.candleResponses.length;entry.requestOffset=before.requests.length;entry.responseOffset=offset;
      await page.setViewportSize({width:1440,height:1100});await page.goto(origin+route);
      await page.getByTestId('arx-native-chart').waitFor({timeout:15000});
      check(new URL(page.url()).pathname===route,route+': real dashboard route loaded');
      const build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('Missing build metadata');return r.json();});
      const runtimeId=await page.evaluate(()=>window.__arxScannerQaBuildId);
      check(typeof runtimeId==='string'&&runtimeId===build.buildId,route+': executing bundle matches metadata');
      check(build.minified&&build.productionRuntimeChecked&&build.sourceUnchanged&&!build.source.status&&build.dashboardUtilityCss?.source==='artifacts/trading-dashboard/src',route+': clean unchanged production fixture with dashboard CSS');
      if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(build.source.head===SCANNER_QA_EXPECTED_COMMIT,route+': expected source commit');
      if(report.build)check(report.build.buildId===build.buildId,route+': same build across all pages');else report.build=build;
      check(await page.getByTestId('arx-native-chart').count()===1,route+': exactly one shared native chart');
      check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],script[src*="tradingview-widget.com"]').count()===0,route+': no embedded external chart');
      check(await page.getByText('OFFLINE QA — synthetic historical candles; all APIs intercepted; trading disabled',{exact:true}).isVisible(),route+': offline fixture label remains visible');
      const chart=page.getByTestId('arx-native-chart');
      await chart.getByTestId('arx-native-tf-M15').click();
      const initial=await waitSeries('EURUSD','M15',900,offset,entry);
      const selector=route==='/live-ai-assist'?page.getByTestId('ai-symbol-select'):page.getByLabel('Chart market',{exact:true});
      await selector.selectOption('GBPUSD');
      const selected=await waitSeries('GBPUSD','M15',900,offset,entry);
      check(initial.state.adapterId===selected.state.adapterId&&JSON.stringify(initial.state.canvasIds)===JSON.stringify(selected.state.canvasIds),route+': market selection retains engine and canvas');
      await chart.getByTestId('arx-native-tf-M5').click();
      const changed=await waitSeries('GBPUSD','M5',300,offset,entry);
      check(changed.state.adapterId===initial.state.adapterId,route+': interval selection retains engine');
      const reader=chart.getByTestId('smart-chart-reader');
      check(await reader.count()===1&&await reader.getAttribute('data-analysis-status')!=='ready',route+': synthetic unavailable evidence cannot become ready analysis');
      check((await chart.getByTestId('chart-reader-explanation').textContent()).trim().length>0,route+': unavailable analysis is explained');
      if(route==='/live-chart') {
        check((await page.getByTestId('text-chart-trade-symbol').textContent()).trim()==='GBPUSD',route+': unopened ticket shares selected symbol');
        check(await page.getByText(/Read-only chart\. Check the chart's feed status/).isVisible(),route+': review and confirmation warning remains');
        check(await page.getByTestId('chart-engine-label').isVisible(),route+': native engine label remains');
      } else if(route==='/live-manual') {
        check(await page.getByTestId('ticket-symbol').inputValue()==='GBPUSD',route+': manual ticket shares selected symbol');
        check(await page.getByText('Review required before any order',{exact:true}).isVisible(),route+': manual review warning remains');
        check(await page.getByTestId('ticket-confirm-dialog').count()===0&&await page.getByTestId('ticket-response').count()===0,route+': confirmation stays closed and no submission result appears');
        entry.reviewControlEnabled=await page.getByTestId('ticket-submit').isEnabled();
      } else if(route==='/live-ai-assist') {
        check(await page.getByText('AI Trade Card · M15',{exact:true}).isVisible(),route+': fixed M15 analysis is explicitly labelled');
        const beforeRead=(await log()).requests.length;
        await page.getByTestId('generate-card').click(); // GET-only analysis, not approve/submit.
        await page.getByTestId('ai-neutral').waitFor({timeout:15000});
        const analysis=(await log()).requests.slice(beforeRead).filter(x=>x.path==='/api/market-scanner/selected-market');
        check(analysis.some(x=>x.method==='GET'&&new URLSearchParams(x.query).get('symbol')==='GBPUSD'&&new URLSearchParams(x.query).get('timeframe')==='M15'),route+': analysis keeps explicit M15 while chart is M5');
        check(await page.getByTestId('approve-card').count()===0&&await page.getByTestId('ai-assist-response').count()===0,route+': unavailable WAIT fixture exposes no approval or submission result');
        await waitSeries('GBPUSD','M5',300,offset,entry);
      } else {
        check(await page.getByText('LOOP STOPPED',{exact:true}).isVisible(),route+': audit loop remains stopped');
        check(await page.getByTestId('auto-pause').isDisabled()&&await page.getByTestId('auto-stop').isDisabled(),route+': stopped-loop pause and stop remain disabled');
        check((await page.getByTestId('audit-only-banner').textContent()).includes('not AI decisions'),route+': synthetic audit-only disclaimer remains');
        check(await page.getByText(/The audit-only test above still uses its fixed EURUSD input/).isVisible(),route+': chart symbol is explicitly independent from fixed audit input');
        entry.startControlEnabled=await page.getByTestId('auto-start').isEnabled();
      }
      check(await page.getByRole('dialog').count()===0,route+': no trading or confirmation dialog was opened');
      await screenshot(entry,'desktop');
      await page.setViewportSize({width:390,height:844});await frames();
      const tools=chart.getByRole('button',{name:'Chart tools',exact:true});await tools.waitFor({state:'visible'});
      if(await tools.getAttribute('aria-expanded')==='true')await tools.click();
      const preDisclosure=await snapshot();await tools.click();
      await chart.getByLabel('Chart style',{exact:true}).waitFor({state:'visible'});await tools.click();await frames();
      const postDisclosure=await snapshot();
      check(postDisclosure.state.adapterId===preDisclosure.state.adapterId&&postDisclosure.state.candlesId===preDisclosure.state.candlesId&&JSON.stringify(postDisclosure.data)===JSON.stringify(preDisclosure.data),route+': mobile disclosure preserves engine and all series data');
      check(!await chart.getByLabel('Chart style',{exact:true}).isVisible()&&await chart.getByRole('button',{name:'Zoom in chart',exact:true}).isVisible()&&await chart.getByRole('button',{name:'Pan to earlier candles',exact:true}).isVisible(),route+': mobile navigation stays visible with advanced controls closed');
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route+': mobile has no horizontal overflow');
      await screenshot(entry,'mobile');await waitSeries('GBPUSD','M5',300,offset,entry);
      entry.requests=(await log()).requests.slice(entry.requestOffset);entry.passed=true;
    }
    report.passed=true;
  } catch(error) {
    report.failure=String(error?.stack??error);
    try {report.failureSnapshot=await snapshot();const path=prefix+'-failure.png';await page.screenshot({path,fullPage:false});report.screenshots.push(path);}catch(captureError){report.captureFailure=String(captureError);}
  } finally {
    try {
      report.network=await log();
      const writes=report.network.blocked.filter(x=>x.kind==='mutation');
      report.tradeRequests=writes.filter(x=>classifyWrite(x)==='trade');
      report.unclassifiedWrites=writes.filter(x=>classifyWrite(x)==='unclassified');
      report.blockedBackground=writes.filter(x=>classifyWrite(x)==='background'||classifyWrite(x)==='analysis');
      report.external=report.network.blocked.filter(x=>x.kind==='external'||x.kind==='websocket');
      report.allMutationsBlocked=writes.every(x=>x.status===503)&&report.network.requests.filter(x=>x.method!=='GET').every(x=>x.status===503);
      if(report.tradeRequests.length||report.unclassifiedWrites.length||report.external.length||report.network.errors.length||!report.allMutationsBlocked)report.passed=false;
    } catch(error) {report.passed=false;report.logFailure=String(error);}
  }
  return report; // Process success is not acceptance. Inspect passed and every failure.
}
