// Actual native Scanner with synthetic candles and intercepted APIs only.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));};
 const values=()=>page.evaluate(()=>{const configs=window.__arxChartQa.configuration().studies;return window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)).map(row=>({time:row.time,studies:Object.fromEntries(configs.map((c,i)=>[c.id,row.studies[i].values.map(v=>v.value)]).sort((a,b)=>a[0].localeCompare(b[0])))}));});
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default build');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const openTools=async()=>{const b=panel.getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();};
  await openTools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();await panel.getByRole('button',{name:/^Studies \(/}).click();
  for(const name of ['Relative strength index','MACD','Simple moving average'])await panel.getByRole('button',{name:'Add '+name,exact:true}).click();
  await panel.getByLabel('SMA 3 Source',{exact:true}).selectOption({label:'1. RSI · RSI'});
  const before=await state(),originalValues=await values(),rsiId=before.config.studies[0].id;
  check(before.layout.panes.length===2,'RSI and MACD own two panes; linked SMA shares RSI');
  const paneControls=label=>panel.getByLabel(label+' Pane controls',{exact:true});
  await paneControls('RSI 1').locator('summary').click();
  const weight=panel.getByLabel('RSI 1 Relative pane height',{exact:true});await weight.fill('3');await weight.press('Tab');
  let current=await state();check(current.config.studies[0].paneWeight===3&&current.layout.panes[0].height>before.layout.panes[0].height,'Height control resizes the actual native pane');
  check(current.layout.price.height>=100&&current.layout.panes.every(p=>p.height>=40),'Minimum readable pane sizes retained');
  check(JSON.stringify(await values())===JSON.stringify(originalValues),'Sizing preserves all original and linked calculations');
  await panel.getByRole('button',{name:'Move study 3 up',exact:true}).click();await panel.getByRole('button',{name:'Move study 2 up',exact:true}).click();await panel.getByRole('button',{name:'Move study 2 down',exact:true}).click();
  current=await state();check(current.config.studies.map(s=>s.kind).join(',')==='sma,macd,rsi'&&current.config.studies[0].studySource.studyId===rsiId,'Reordering preserves exact source instance identity');
  check(current.layout.panes[1].height>current.layout.panes[0].height,'Owner pane order follows configuration despite earlier linked overlay');
  check(JSON.stringify(await values())===JSON.stringify(originalValues),'Reordering preserves per-instance numeric observations');
  await panel.getByLabel('RSI 3 Interval visibility',{exact:true}).locator('summary').click();await panel.getByRole('button',{name:'RSI 3 Hide on all',exact:true}).click();current=await state();
  check(current.layout.panes.length===2&&current.layout.panes[1].height>current.layout.panes[0].height,'Hidden source retains weighted pane for visible linked overlay');
  check(JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical),'Layout changes preserve canonical OHLC');
  await panel.getByRole('button',{name:/^Studies \(/}).click();await panel.locator('canvas[data-arx-native-viewport]').scrollIntoViewIfNeeded();await shot('desktop-panes');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();current=await state();
  check(current.config.studies[2].paneWeight===3&&current.config.studies.map(s=>s.kind).join(',')==='sma,macd,rsi','Reload restores height, order and source settings');
  await openTools();await panel.getByRole('button',{name:/^Studies \(/}).click();await paneControls('RSI 3').locator('summary').click();
  const finalWeight=panel.getByLabel('RSI 3 Relative pane height',{exact:true});await finalWeight.fill('0');await finalWeight.press('Tab');current=await state();check(current.config.studies[2].paneWeight===3&&await finalWeight.inputValue()==='3','Invalid height leaves previous study and layout intact');
  await page.setViewportSize({width:390,height:844});await openTools();await panel.getByRole('button',{name:'RSI 3 Reset pane height',exact:true}).click();current=await state();
  check(current.config.studies[2].paneWeight===undefined&&Math.abs(current.layout.panes[0].height-current.layout.panes[1].height)<1e-6,'Narrow-screen reset restores equal pane sizes');
  await finalWeight.scrollIntoViewIfNeeded();await shot('mobile-controls');
  check(await panel.getByRole('region',{name:'Study settings'}).evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Study controls fit narrow screen');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
