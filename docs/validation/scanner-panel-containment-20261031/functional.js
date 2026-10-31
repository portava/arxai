async page => {
 const results=[];
 await page.addInitScript(()=>{window.__panelVisibility=[];document.addEventListener('contentvisibilityautostatechange',e=>{if(e.target.matches?.('[data-testid="scanner-supporting-panels"]'))window.__panelVisibility.push({skipped:e.skipped,at:performance.now()});},true);});
 for(const viewport of [{width:1440,height:1100},{width:390,height:844}]) {
  await page.setViewportSize(viewport);await page.goto('http://127.0.0.1:4199/market-scanner');
  await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  const before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
  const entry=await page.evaluate(()=>{
   const panel=document.querySelector('[data-testid="scanner-supporting-panels"]');
   const candidates=[...document.querySelectorAll('button,a[href],input,[tabindex="0"]')].filter(el=>!el.disabled&&el.tabIndex>=0&&!!(el.compareDocumentPosition(panel)&Node.DOCUMENT_POSITION_FOLLOWING)&&el.getBoundingClientRect().width>0&&getComputedStyle(el).visibility==='visible');
   const last=candidates.at(-1);if(!last)throw Error('Missing preceding keyboard control');last.focus();return{text:last.textContent,events:window.__panelVisibility.slice(),panelY:panel.getBoundingClientRect().y};
  });
  const traversal=[];let reached=false;
  for(let i=0;i<10;i++) {await page.keyboard.press('Tab');const a=await page.evaluate(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return{text:e.textContent?.slice(0,90),inside:!!e.closest('[data-testid="scanner-supporting-panels"]'),visible:r.top>=0&&r.bottom<=innerHeight&&r.width>0};});traversal.push(a);if(a.inside){reached=a.visible;break;}}
  if(!reached)throw Error('Keyboard entry failed '+JSON.stringify(traversal));
  const focus=page.getByTestId('page-tab-focus');await focus.focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('[data-testid="page-tab-broad-scan"]')?.getAttribute('aria-selected')==='true');
  await page.keyboard.press('End');await page.waitForFunction(()=>document.querySelector('[data-testid="page-tab-symbols"]')?.getAttribute('aria-selected')==='true');
  await page.keyboard.press('Home');await page.waitForFunction(()=>document.querySelector('[data-testid="page-tab-focus"]')?.getAttribute('aria-selected')==='true');
  await page.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const after=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),events:window.__panelVisibility,overflow:document.documentElement.scrollWidth>innerWidth+1,network:null}));
  const dataStable=JSON.stringify(before.data)===JSON.stringify(after.data),engineStable=before.state.chartId===after.state.chartId&&before.state.seriesId===after.state.seriesId;
  if(!dataStable||!engineStable||after.overflow)throw Error('Chart stability or overflow failed');
  await page.screenshot({path:'containment-'+viewport.width+'.png'});
  results.push({viewport,entry,traversal,dataStable,engineStable,overflow:after.overflow,events:after.events});
 }
 const log=await page.evaluate(()=>window.__readFixtureLog());return{passed:true,results,pageErrors:log.errors,blocked:log.blocked};
}
