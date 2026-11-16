async qaPage => {
 // Most chart controls live in the Tools popup and its collapsed sections. Before
 // an action on a hidden control, open each closed ancestor through the button
 // that controls it (aria-controls), outermost first. Visibility checks
 // (isVisible, waitFor, count) are never altered, so hidden-state assertions hold.
 const revealing=raw=>{
  const ACT=new Set(['click','dblclick','selectOption','fill','check','uncheck','setChecked','press','pressSequentially','type','hover','focus','inputValue','setInputFiles','dragTo','tap','clear','selectText']);
  const CHAIN=new Set(['first','last','nth','locator','filter','getByLabel','getByRole','getByTestId','getByText','getByPlaceholder','getByTitle','getByAltText','and','or']);
  const openAncestor=el=>{
   const chain=[];for(let e=el;e;e=e.parentElement)if(e.id||/^arx-details-section-/.test(e.dataset?.testid??''))chain.unshift(e);
   const shown=e=>!e.hidden&&getComputedStyle(e).display!=='none';
   // The tools window shows one section at a time (Tools, Forecast, Chart read);
   // open the window on the section that holds the control.
   const section=chain.find(e=>/^arx-details-section-/.test(e.dataset?.testid??'')), popup=chain.find(e=>e.id==='arx-advanced-chart-content');
   if(popup&&(!shown(popup)||(section&&!shown(section)))){
    const name=section?section.dataset.testid.replace('arx-details-section-',''):'tools';
    const b=popup.closest('[data-testid="arx-native-chart"]')?.querySelector(`[data-testid="arx-native-open-${name}"]`);
    if(b){b.click();return true;}
   }
   for(const e of chain){
    if(shown(e)||e===popup||e===section)continue;
    const b=document.querySelector(`[aria-controls="${CSS.escape(e.id)}"]`);
    if(b&&b.getAttribute('aria-expanded')!=='true'){b.click();return true;}
   }
   return false;
  };
  // `hidden` matches the same element even while collapsed (role queries skip hidden nodes).
  const reveal=async(loc,hidden)=>{for(let i=0;i<6;i++){
   if(await loc.first().isVisible().catch(()=>false))return;
   if(!await hidden.first().evaluate(openAncestor,undefined,{timeout:5000}).catch(()=>false))return;
   await raw.waitForTimeout(60);
  }};
  const twin=(base,p,a)=>p==='getByRole'?base[p](a[0],{...a[1],includeHidden:true}):base[p](...a);
  const wrap=(loc,hidden)=>new Proxy(loc,{get(t,p){const v=t[p];if(typeof v!=='function')return v;
   if(CHAIN.has(p))return(...a)=>wrap(v.apply(t,a),twin(hidden,p,a));
   if(ACT.has(p))return async(...a)=>{await reveal(t,hidden);return v.apply(t,a);};
   // Waiting for a control to become visible opens its section first.
   if(p==='waitFor')return async(o)=>{if(!o?.state||o.state==='visible')await reveal(t,hidden);return v.call(t,o);};
   return v.bind(t);}});
  return new Proxy(raw,{get(t,p){const v=t[p];if(typeof v!=='function')return v;
   if(CHAIN.has(p))return(...a)=>wrap(v.apply(t,a),twin(t,p,a));return v.bind(t);}});
 };
 const page=revealing(qaPage);
  // The same script runs against the isolated development or production fixture.
  // It verifies behavior, not latency: selectOption is not a trusted human click.
  const base = typeof CHART_QA_BASE_URL === 'string' ? CHART_QA_BASE_URL : 'http://127.0.0.1:4178';
  const errors = [], external = [];
  const onError = error => errors.push(error.message);
  const blockExternal = route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) return route.continue();
    external.push(url.origin); return route.abort();
  };
  const check = (ok, message) => { if (!ok) throw Error(message); };
  page.on('pageerror', onError);
  await page.route('**/*', blockExternal);
  try {
    await page.goto(base);
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.setViewportSize({ width: 1600, height: 1100 });
    const chart = page.getByTestId('arx-native-canvas');
    await chart.waitFor();
    await chart.hover({ position: { x: 300, y: 120 } });
    const legend = page.getByTestId('chart-candle-inspector');
    await page.waitForFunction(() => document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent.includes('UTC'));
    const canonical = await legend.textContent();
    // OHLC is followed by range and volume fields in the current inspector.
    const ohlc = canonical.match(/  ·  O -?\d+\.\d+  H -?\d+\.\d+  L -?\d+\.\d+  C -?\d+\.\d+(?=  ·  |$)/);
    check(ohlc, `No complete canonical OHLC in legend: ${canonical}`);
    const stamp = canonical.slice(0, 16), prices = ohlc[0];
    const millis = Date.parse(stamp.replace(' ', 'T') + ':00Z');
    check(Number.isFinite(millis), 'No original candle timestamp');
    const canvas = await chart.locator('canvas').first().elementHandle();
    const canvasCount = await chart.locator('canvas').count();
    const style = page.getByLabel('Chart style', { exact: true });
    for (const value of ['heikinAshi', 'baseline', 'hollow']) {
      await style.selectOption(value);
      const note = page.getByTestId('chart-style-note');
      check(await note.isVisible(), `${value}: explanation hidden`);
      check(await style.getAttribute('aria-describedby') === await note.getAttribute('id'), `${value}: description not associated`);
      check(!(await note.evaluate(el => !!el.closest('details'))), `${value}: explanation requires expansion`);
    }
    await style.selectOption('candles');
    check(await page.getByTestId('chart-style-note').count() === 0, 'Obsolete style explanation');
    const zone = page.getByLabel('Display time zone', { exact: true });
    await page.getByLabel('Go to UTC date and time', { exact: true }).fill(stamp.replace(' ', 'T'));
    const zones = ['Asia/Tokyo', 'America/New_York', 'Europe/London', 'UTC'];
    for (const value of zones) {
      await zone.selectOption(value);
      // Independent expectation from the original UTC instant; never parse an
      // already-relabelled timestamp or call the application's formatting code.
      const expected = new Intl.DateTimeFormat('sv-SE', {
        timeZone: value, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(millis));
      await page.waitForFunction(([time, ohlc]) => {
        const text = document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? '';
        return text.startsWith(time) && text.includes(ohlc);
      }, [expected, prices]);
      const input = page.getByLabel(`Go to ${value} date and time`, { exact: true });
      check(await input.inputValue() === expected.replace(' ', 'T'), `${value}: go-to changed the instant`);
      check(await canvas.evaluate(el => el.isConnected), `${value}: replaced chart canvas`);
      check(await chart.locator('canvas').count() === canvasCount, `${value}: leaked canvas`);
    }
    // The wall-clock conversion rejects a spring-forward time that never existed.
    await zone.selectOption('America/New_York');
    await page.getByLabel('Go to America/New_York date and time', { exact: true }).fill('2026-03-08T02:30');
    await page.getByRole('button', { name: 'Go to America/New_York', exact: true }).click();
    await page.getByText('That time does not exist in America/New_York (clock change). Choose another time.', { exact: true }).waitFor();
    await page.getByLabel('Chart timeframe', { exact: true }).selectOption('D1');
    await page.getByTestId('chart-daily-zone-note').waitFor();
    await page.getByLabel('Go to UTC date and time', { exact: true }).waitFor();
    check(await zone.inputValue() === 'America/New_York', 'Daily view discarded the chosen zone');
    await chart.hover({ position: { x: 300, y: 120 } });
    await page.waitForFunction(() => /^\d{4}-\d{2}-\d{2} 00:00 UTC  ·  O /.test(document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? ''));
    await page.getByLabel('Chart timeframe', { exact: true }).selectOption('M15');
    await page.getByLabel('Go to America/New_York date and time', { exact: true }).waitFor();
    await chart.hover({ position: { x: 300, y: 120 } });
    await page.waitForFunction(() => / (EDT|EST)  ·  O /.test(document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? ''));
    await style.selectOption('heikinAshi');
    await page.reload();
    check(await zone.inputValue() === 'America/New_York' && await style.inputValue() === 'heikinAshi', 'Style or zone did not persist');
    await page.getByTestId('chart-style-note').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const tools = page.getByRole('button', { name: 'Chart tools', exact: true });
    for (const value of ['heikinAshi', 'baseline', 'hollow']) {
      await tools.click();
      await style.selectOption(value);
      await tools.click();
      check(await page.getByTestId('chart-style-note').isVisible(), `${value}: mobile explanation hidden`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${value}: mobile overflow`);
    }
    check(errors.length === 0, `Browser exceptions: ${errors}`);
    check(external.length === 0, `Unexpected external requests (blocked): ${external}`);
    return { base, fixture: 'synthetic offline, no broker', transformedStyleNotes: 3,
      canonicalPricesAcrossZones: zones, goToInstantPreserved: true, dstGapRejected: true,
      dailyUtcAndIntradayRestore: true, persistedStyleAndZone: true, canvasRetained: true,
      mobileNoOverflow: true, errors, externalRequests: external,
      scope: 'functional acceptance only; no latency, feed or competitor parity claim' };
  } finally {
    page.off('pageerror', onError); await page.unroute('**/*', blockExternal);
  }
}
