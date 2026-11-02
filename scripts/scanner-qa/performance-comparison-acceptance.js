// Run after shared-chart-setup.js with qualified synthetic candleResponse hooks.
async page => {
 const report={passed:false,checks:[],failure:null,screenshots:[],limitations:["Synthetic offline Scanner; no live-source, broker, performance or parity evidence."]};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const data=()=>page.evaluate(()=>window.__arxChartQa.data());
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try {
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;
  check(m.buildId===report.build.runtime&&m.nativeEngine&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Executing native fixture matches clean committed source');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');
  await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const tools=panel.getByRole('button',{name:'Chart tools',exact:true});
  if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
  await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();
  const before=await data();
  await panel.getByRole('button',{name:'Compare price change',exact:true}).click();
  const comparison=panel.getByRole('region',{name:'Percentage comparison'});
  await comparison.getByText('Compare EURUSD with another instrument',{exact:true}).click();
  await comparison.getByPlaceholder('Search comparison charts — AAPL, Apple, EURUSD…').fill('GBPUSD');
  await comparison.getByRole('button',{name:/GBPUSD/}).first().click();
  await comparison.getByRole('img').waitFor();
  await comparison.locator('summary').first().click();
  const source=await page.evaluate(()=>window.__readFixtureLog());
  const a=source.candleResponses.filter(r=>r.symbol==='EURUSD'&&r.timeframe==='M15').at(-1).canonical;
  const b=source.candleResponses.filter(r=>r.symbol==='GBPUSD'&&r.timeframe==='M15').at(-1).canonical;
  check(JSON.stringify(a)===JSON.stringify(before.canonical)&&JSON.stringify(before.display)===JSON.stringify(before.canonical),'Primary source, canonical and displayed OHLC agree before comparison');
  const table=await comparison.locator('tbody tr').allTextContents();
  const pct=v=>`${v>0?'+':''}${Number(v.toPrecision(5))}%`;
  check(table.length===a.length&&a.every((bar,i)=>b[i]?.time===bar.time&&table[i].includes(pct((bar.close-a[0].close)/a[0].close*100))&&table[i].includes(pct((b[i].close-b[0].close)/b[0].close*100))),'Every displayed relative value matches independent source arithmetic');
  check(await comparison.locator('[data-comparison-series="primary"] circle').count()===a.length&&await comparison.locator('[data-comparison-series="comparison"] circle').count()===b.length,'Both observed line series are plotted');
  check(!/NaN|Infinity/.test(await comparison.getByRole('img').innerHTML()),'SVG coordinates are finite');
  const baseline=await comparison.getByText(/^Baseline:/).textContent();
  await comparison.scrollIntoViewIfNeeded();await shot('desktop');
  await panel.getByRole('button',{name:'Zoom in',exact:true}).click();await frames();
  await comparison.scrollIntoViewIfNeeded();
  check(await comparison.getByText(/^Baseline:/).textContent()!==baseline,'Native zoom rebases the shared comparison origin');
  check(JSON.stringify((await data()).canonical)===JSON.stringify(before.canonical),'Comparison and zoom preserve primary OHLC');
  await page.setViewportSize({width:390,height:844});await frames();await comparison.scrollIntoViewIfNeeded();
  check(await comparison.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Comparison pane fits a narrow viewport');await shot('mobile');
  await page.evaluate(()=>window.__setComparisonClock(false));
  await comparison.getByRole('status').filter({hasText:'UTC timestamps are unverified'}).waitFor({timeout:20000});
  check(await comparison.getByRole('img').count()===0,'Unverified source clock withdraws previously plotted percentages');
  await shot('withheld');
  await comparison.getByRole('button',{name:'Close comparison',exact:true}).click();
  check(await comparison.count()===0,'Close removes comparison pane');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'No embedded chart or TradingView logo');
  report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{
  report.network=await page.evaluate(()=>window.__readFixtureLog());
  const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];
  report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);
  if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;
 }
 return report;
}
