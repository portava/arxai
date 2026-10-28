async page => {
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/scanner-templates';
  const report={passed:false,checks:[],screenshots:[],failure:null,limitations:[
    'Actual Scanner route in isolated production fixture, synthetic historical candles and unavailable AI truth.',
    'Programmatic selectOption is used for functional style/list selection, not trusted-input latency.',
    'No timing, physical-paint, cross-browser, broker or competitor parity claim.']};
  function matchesSeries(current,expected,style) {
    const {state,data}=current??{};
    if(!expected?.canonical?.length||!state||!data||state.symbol!=='EURUSD'||state.intervalSeconds!==900||state.style!==style||state.feed?.source!==expected.source||state.barCount!==expected.canonical.length||!Array.isArray(data.canonical)||!Array.isArray(data.display))return false;
    const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
    return JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)&&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
  }
  function matchesSma(configuration,candles,period,scaleMode) {
    if(configuration?.scale?.mode!==scaleMode||configuration.studies?.length!==1)return false;
    const study=configuration.studies[0],line=study.lines?.[0];
    if(study.config.kind!=='sma'||study.config.period!==period||study.lines.length!==1||line?.length!==candles.length-period+1||line.at(-1).time!==candles.at(-1).time)return false;
    // LWC series.data() omits whitespace warm-up rows. Require every mature
    // timestamp in order, not a partial set of points or cached calculator data.
    return line.every((point,index)=>{
      const i=index+period-1;
      if(point.time!==candles[i].time)return false;
      const mean=candles.slice(i-period+1,i+1).reduce((sum,c)=>sum+c.close,0)/period;
      return Number.isFinite(point.value)&&Math.abs(point.value-mean)<1e-10;
    });
  }
  const check=(value,label)=>{if(!value)throw Error(label);report.checks.push(label);};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const screenshot=async label=>{const path=prefix+'-'+label+'.png';await page.screenshot({path,fullPage:false});report.screenshots.push(path);};
  const button=name=>page.getByRole('button',{name,exact:true});
  const open=async()=>{await button('Templates').click();await page.getByRole('dialog',{name:'Chart templates',exact:true}).waitFor();};
  const close=async()=>{await button('Close').click();await page.getByRole('dialog',{name:'Chart templates',exact:true}).waitFor({state:'hidden'});};
  const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('arx.chart.templates.v1')??'null'));
  const save=async name=>{await page.getByLabel('Template name',{exact:true}).fill(name);await button('Save new').click();await page.getByText('Template saved in this browser.',{exact:true}).waitFor();};
  const select=async name=>{await page.getByRole('listbox').selectOption({label:name});};
  try {
    check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route is open');
    report.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('Missing build metadata');return r.json();});
    const executedBuild=await page.evaluate(()=>window.__arxScannerQaBuildId);
    check(typeof executedBuild==='string'&&executedBuild.length>0&&report.build.buildId===executedBuild,'Executed build matches metadata');
    check(report.build.dashboardUtilityCss?.source==='artifacts/trading-dashboard/src','Actual dashboard utility CSS is included');
    check(report.build.minified&&report.build.productionRuntimeChecked&&report.build.sourceUnchanged&&!report.build.source.status,'Clean unchanged production fixture');
    if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(report.build.source.head===SCANNER_QA_EXPECTED_COMMIT,'Exact requested source commit');
    const panel=page.getByTestId('scanner-chart-panel');
    await page.setViewportSize({width:1600,height:1100});
    await panel.getByTestId('arx-native-tf-M15').click();
    await page.waitForFunction(()=>{const s=window.__arxChartQa?.snapshot(),d=window.__arxChartQa?.data();return s?.symbol==='EURUSD'&&s.intervalSeconds===900&&s.barCount===200&&d?.canonical.length===200;});
    const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
    const responses=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses;
    const expected=responses.filter(row=>row.requestPath==='/api/chart/candles'&&row.symbol==='EURUSD'&&row.timeframe==='M15'&&new URLSearchParams(row.requestQuery).get('limit')==='200'&&row.canonical.length===200).at(-1);
    await frames();
    const initial=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
    check(matchesSeries(initial,expected,'candles'),'Full context, source and displayed/canonical series match the exact Scanner request after rendering opportunities');
    const tools=panel.getByRole('button',{name:'Chart tools',exact:true});
    if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
    await panel.getByLabel('Chart style',{exact:true}).selectOption('bars');
    await panel.getByLabel('Price scale',{exact:true}).selectOption('log');
    await panel.getByLabel('Display time zone',{exact:true}).selectOption('Asia/Tokyo');
    await button('Studies (0)').click();await button('Add Simple moving average').click();
    await page.getByLabel('SMA 1 Period',{exact:true}).fill('10');await page.getByLabel('SMA 1 Period',{exact:true}).blur();await button('Studies (1)').click();
    await open();await save('Trend study');
    const library=await saved(),entry=library.entries[0];
    check(entry.name==='Trend study'&&entry.settings.style==='bars'&&entry.settings.studies[0].period===10&&!Object.hasOwn(entry.settings,'timeZone'),'Saved template contains configured study/style but no display zone');
    await page.getByLabel('Template name',{exact:true}).fill('trend study');await button('Save new').click();
    await page.getByText(/That name is already used/).waitFor();check((await saved()).entries.length===1,'Case-insensitive duplicate cannot overwrite the original');
    await close();await panel.getByLabel('Chart style',{exact:true}).selectOption('candles');
    await panel.getByLabel('Price scale',{exact:true}).selectOption('indexed');
    await button('Studies (1)').click();await page.getByLabel('SMA 1 Period',{exact:true}).fill('37');await page.getByLabel('SMA 1 Period',{exact:true}).blur();await button('Studies (1)').click();
    await frames();
    check(matchesSma(await page.evaluate(()=>window.__arxChartQa.configuration()),expected.canonical,37,3),'Distinct current SMA37 is installed with indexed scale before restore');
    await panel.getByLabel('Display time zone',{exact:true}).selectOption('America/New_York');
    await open();check(await page.getByRole('listbox').inputValue()===''&&await button('Apply selected').isDisabled(),'Reopened library has an honest empty selection');
    await select('Trend study');await button('Apply selected').click();await close();
    await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.style==='bars');await frames();
    check(await panel.getByLabel('Display time zone',{exact:true}).inputValue()==='America/New_York','Applying preserves current display time zone');
    const restored=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),configuration:window.__arxChartQa.configuration()}));
    check(matchesSeries(restored,expected,'bars')&&restored.state.adapterId===before.state.adapterId,'Applying restores actual bars on the same engine and preserves source-bound OHLC');
    check(matchesSma(restored.configuration,expected.canonical,10,1),'Applying replaces SMA37/indexed with formula-correct SMA10/logarithmic series');
    await button('Studies (1)').click();check(await page.getByLabel('SMA 1 Period',{exact:true}).inputValue()==='10','Applying restores the configured study period');await button('Studies (1)').click();
    // Keep current chart different from the file so an accidental import apply is observable.
    await panel.getByLabel('Price scale',{exact:true}).selectOption('indexed');
    await button('Studies (1)').click();await page.getByLabel('SMA 1 Period',{exact:true}).fill('37');await page.getByLabel('SMA 1 Period',{exact:true}).blur();await button('Studies (1)').click();
    await frames();
    check(matchesSma(await page.evaluate(()=>window.__arxChartQa.configuration()),expected.canonical,37,3),'Distinct SMA37/indexed state is installed before import');
    await open();await select('Trend study');
    const downloadPromise=page.waitForEvent('download');await button('Export selected').click();const download=await downloadPromise;
    report.exportFile=prefix+'-export.chart-template.json';await download.saveAs(report.exportFile);
    check(download.suggestedFilename()==='ARX-Trend-study.chart-template.json','Export uses an ARX template filename');
    await page.getByLabel('Import chart template file',{exact:true}).setInputFiles(report.exportFile);
    await page.getByText(/File checked/).waitFor();check((await saved()).entries.length===1,'File validation stages import without saving');
    await button('Save imported').click();await page.getByText(/That name is already used/).waitFor();
    await page.getByLabel('Template name',{exact:true}).fill('Imported study');await button('Save imported').click();
    await page.getByText(/Template imported/).waitFor();const importedLibrary=await saved();
    check(importedLibrary.entries.length===2&&JSON.stringify(importedLibrary.entries[1].settings)===JSON.stringify(entry.settings),'Exported file roundtrip preserves exact saved settings and allows a new name');
    await frames();
    check(matchesSma(await page.evaluate(()=>window.__arxChartQa.configuration()),expected.canonical,37,3),'Checking and saving an imported SMA10/log template does not apply it over current SMA37/indexed chart');
    // Hold the real browser-wide lock briefly. This does not fake storage or writes.
    await page.evaluate(()=>{window.__templateLockHeld=false;window.__templateLockPromise=navigator.locks.request('arx.chart.templates.v1',()=>new Promise(resolve=>{window.__releaseTemplateLock=resolve;window.__templateLockHeld=true;}));});
    await page.waitForFunction(()=>window.__templateLockHeld);
    try {await page.getByLabel('Template name',{exact:true}).fill('Busy save');await button('Save new').click();await page.getByText('Another chart is saving templates. Try again.',{exact:true}).waitFor();check((await saved()).entries.length===2,'Native browser lock prevents concurrent library mutation');}
    finally {await page.evaluate(async()=>{window.__releaseTemplateLock();await window.__templateLockPromise;});}
    await select('Imported study');await button('Delete selected').click();check((await saved()).entries.length===2,'Delete waits for explicit confirmation');
    await button('Confirm delete').click();await page.getByText('Template deleted. The chart is unchanged.',{exact:true}).waitFor();check((await saved()).entries.length===1,'Confirmed delete changes only the selected saved template');
    await screenshot('desktop');await close();
    await button('Fullscreen').click();await open();await page.keyboard.press('Escape');
    await page.getByRole('dialog',{name:'Chart templates',exact:true}).waitFor({state:'hidden'});
    check(await button('Exit fullscreen').isVisible(),'First Escape closes the dialog and preserves fullscreen');
    await page.keyboard.press('Escape');check(await button('Fullscreen').isVisible(),'Second Escape exits fullscreen');
    // Start with a wide toolbar and closed compact disclosure, then hide trigger by resize.
    if(await tools.getAttribute('aria-expanded')==='true')await tools.click();
    await open();await page.setViewportSize({width:390,height:844});await frames();
    const dialog=page.getByRole('dialog',{name:'Chart templates',exact:true});
    check(await dialog.evaluate(element=>{const b=element.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&element.scrollWidth<=element.clientWidth;}),'Mobile templates dialog fits viewport and has no horizontal clipping');
    await screenshot('mobile');await close();await frames();
    check(await tools.evaluate(element=>document.activeElement===element),'Closing after resize returns focus to visible Tools');
    // Saved records survive keyed chart remount without reload/storage reseeding.
    await panel.getByTestId('arx-native-tf-M5').click();await page.waitForFunction(()=>window.__arxChartQa.snapshot()?.intervalSeconds===300);
    if(await tools.getAttribute('aria-expanded')!=='true')await tools.click();
    await open();await select('Trend study');check((await saved()).entries[0].id===entry.id,'Named template survives chart-context remount');await close();
    check(await page.locator('#tv-attr-logo,iframe,embed,object,script[src*="tradingview.com"]').count()===0,'No TradingView logo or embedded chart is introduced');
    report.passed=true;
  } catch(error) {report.failure=String(error?.stack??error);try{await screenshot('failure');}catch(capture){report.captureFailure=String(capture);}}
  finally {
    try {await page.evaluate(()=>window.__releaseTemplateLock?.());}catch{}
    try {
      report.network=await page.evaluate(()=>window.__readFixtureLog());
      const writes=report.network.blocked.filter(item=>item.kind==='mutation');
      const known=new Set(['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus']);
      report.unclassifiedOrTradeWrites=writes.filter(item=>item.method!=='POST'||!known.has(item.path));
      report.external=report.network.blocked.filter(item=>item.kind==='external'||item.kind==='websocket');
      report.allMutationsBlocked=writes.every(item=>item.status===503)&&report.network.requests.filter(item=>item.method!=='GET').every(item=>item.status===503);
      if(report.unclassifiedOrTradeWrites.length||report.external.length||report.network.errors.length||!report.allMutationsBlocked)report.passed=false;
    }catch(error){report.passed=false;report.networkFailure=String(error);}
  }
  return report;
}
