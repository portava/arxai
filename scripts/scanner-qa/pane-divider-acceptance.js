// Actual Scanner, synthetic history and intercepted APIs only.
async page=>{
 const report={passed:false,checks:[],screenshots:[],failure:null};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const state=async()=>{await page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.engineId==='arx-native'&&s.renderVerified===true&&s.state.status==='ready'&&!s.state.pendingPaint;});return page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));};
 const numbers=()=>page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)).map(row=>({time:row.time,values:row.studies.map(s=>s.values.map(v=>v.value))})));
 const near=(a,b)=>Math.abs(a-b)<1e-7;
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try{
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;check(m.buildId===report.build.runtime&&m.nativeEngine&&!m.diagnosticOnly&&!m.qaOnlyDefaultEngineOverride&&m.productDefaultEngineId==='arx-native'&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production-default build');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const tools=async()=>{const b=panel.getByRole('button',{name:'Chart tools',exact:true});if(await b.isVisible()&&await b.getAttribute('aria-expanded')!=='true')await b.click();};
  await tools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();await panel.getByRole('button',{name:/^Studies \(/}).click();
  for(const name of ['Relative strength index','MACD'])await panel.getByRole('button',{name:'Add '+name,exact:true}).click();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  const divider=panel.getByRole('separator',{name:/^Resize pane 1:/});
  const before=await state(),observations=await numbers();
  const drag=async(distance)=>{await divider.scrollIntoViewIfNeeded();const box=await divider.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2+distance,{steps:4});};
  await drag(30);let current=await state();
  check(near(current.layout.price.height,before.layout.price.height+30)&&near(current.layout.panes[0].height,before.layout.panes[0].height-30),'Canvas follows the divider before release');
  check(near(current.layout.panes[1].height,before.layout.panes[1].height),'Unrelated pane height is preserved');
  check(JSON.stringify(current.config.studies)===JSON.stringify(before.config.studies),'Drag preview does not rewrite installed study preferences');
  check(JSON.stringify(await numbers())===JSON.stringify(observations),'Every indicator observation is unchanged during preview');
  await page.keyboard.press('Escape');await page.mouse.up();current=await state();
  check(JSON.stringify(current.layout)===JSON.stringify(before.layout)&&JSON.stringify(current.config.studies)===JSON.stringify(before.config.studies),'Escape restores original layout without saving the drag');
  await drag(25);await page.mouse.up();current=await state();const saved=current;
  check(near(current.layout.price.height,before.layout.price.height+25)&&current.config.studies[0].paneWeight!==before.config.studies[0].paneWeight,'Release commits the resized proportions');
  check(JSON.stringify(current.data.canonical)===JSON.stringify(before.data.canonical),'Resize preserves canonical candles');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await tools();await panel.getByRole('button',{name:'Fit history',exact:true}).click();current=await state();
  check(JSON.stringify(current.config.studies)===JSON.stringify(saved.config.studies)&&near(current.layout.price.height,saved.layout.price.height),'Reload restores the committed pane proportions');
  await divider.focus();await page.keyboard.press('ArrowUp');current=await state();
  check(near(current.layout.price.height,saved.layout.price.height-10),'Keyboard divider adjustment moves ten CSS pixels');
  check(await divider.evaluate(n=>document.activeElement===n),'Keyboard divider adjustment preserves focus');
  await shot('desktop-divider');
  const beforeCancel=current.config.studies;await drag(20);await state();await page.setViewportSize({width:390,height:844});await state();await page.mouse.up();current=await state();
  check(JSON.stringify(current.config.studies)===JSON.stringify(beforeCancel),'Viewport resizing invalidates the unfinished drag instead of saving old geometry');
  await divider.scrollIntoViewIfNeeded();await divider.focus();await page.keyboard.press('Shift+ArrowDown');current=await state();
  check(current.config.studies.length===2&&JSON.stringify(await numbers())===JSON.stringify(observations),'Narrow keyboard interaction preserves both studies and all values');
  await shot('mobile-divider');
  check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'Native chart without TradingView embed/logo');report.passed=true;
 }catch(e){report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
 finally{report.network=await page.evaluate(()=>window.__readFixtureLog());const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;}
 return report;
}
