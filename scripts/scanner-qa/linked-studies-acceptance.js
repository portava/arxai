// Run after shared-chart-setup.js in a fresh isolated native Scanner fixture.
async page => {
 const report={passed:false,checks:[],failure:null,screenshots:[],limitations:['Offline synthetic Scanner only; no broker, platform parity, physical-touch or speed claim.']};
 const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const state=()=>page.evaluate(()=>({config:window.__arxChartQa.configuration(),layout:window.__arxChartQa.layout(),data:window.__arxChartQa.data()}));
 const shot=async name=>{const path=SCANNER_QA_OUTPUT_PREFIX+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
 try {
  report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
  const m=report.build.metadata;
  check(m.buildId===report.build.runtime&&m.nativeEngine&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean committed native production fixture');
  check(new URL(page.url()).pathname==='/market-scanner','Actual Market Scanner route');
  const panel=page.getByTestId('scanner-chart-panel');
  await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
  const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
  await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();
  const before=await state();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByRole('button',{name:'Add Relative strength index',exact:true}).click();
  await panel.getByRole('button',{name:'Add Simple moving average',exact:true}).click();
  await panel.getByLabel('SMA 2 Period',{exact:true}).fill('3');await panel.getByLabel('SMA 2 Period',{exact:true}).press('Tab');
  await panel.getByLabel('SMA 2 Source',{exact:true}).selectOption({label:'1. RSI · RSI'});await frames();
  let current=await state();const rsi=current.config.studies[0],smooth=current.config.studies[1];
  check(smooth.studySource.studyId===rsi.id&&smooth.studySource.channel===0,'Exact source instance and channel selected');
  check(current.layout.panes.length===1,'Moving average shares the RSI pane');
  check(JSON.stringify(before.data)===JSON.stringify(current.data),'Linked calculations preserve canonical and displayed OHLC');
  const values=await page.evaluate(times=>window.__arxChartQa.studyValues(times),current.data.canonical.map(b=>b.time));
  // Independent Wilder RSI reference from original close observations.
  const closes=current.data.canonical.map(b=>b.close),p=rsi.period,reference=[];let gain=0,loss=0;
  for(let i=0;i<closes.length;i++){
   if(i>0){const delta=closes[i]-closes[i-1];if(i<=p){gain+=Math.max(delta,0);loss+=Math.max(-delta,0);if(i===p){gain/=p;loss/=p;}}else{gain+=(Math.max(delta,0)-gain)/p;loss+=(Math.max(-delta,0)-loss)/p;}}
   reference.push(i<p?null:gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss));
  }
  check(values.length===closes.length&&values.every((row,i)=>{
   const actual=row.studies[0].values[0].value,average=row.studies[1].values[0].value;
   const expected=i<p+2?null:(reference[i]+reference[i-1]+reference[i-2])/3;
   return (reference[i]===null?actual===null:Math.abs(actual-reference[i])<1e-9)&&(expected===null?average===null:Math.abs(average-expected)<1e-9);
  }),'Every RSI and linked SMA observation matches independent arithmetic, including warm-up');
  const parentOptions=await panel.getByLabel('RSI 1 Source',{exact:true}).locator('option').evaluateAll(nodes=>nodes.filter(n=>n.textContent.includes('SMA')).map(n=>({disabled:n.disabled,text:n.textContent})));
  check(parentOptions.length===1&&parentOptions[0].disabled,'Cycle-producing source choice is disabled');
  const first=panel.getByTestId('chart-study-instance').first();await first.locator('summary').filter({hasText:'Line appearance'}).click();await first.getByLabel('RSI 1 RSI visible',{exact:true}).uncheck();
  await panel.getByRole('button',{name:/^Studies \(/}).click();await frames();await shot('desktop-hidden-parent');
  await page.reload();await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();await frames();
  current=await state();check(current.config.studies.length===2&&current.config.studies[1].studySource.studyId===current.config.studies[0].id&&current.layout.panes.length===1,'Reload restores linked source and shared pane');
  const toolsAgain=panel.getByRole('button',{name:'Chart tools',exact:true});if(await toolsAgain.isVisible()&&await toolsAgain.getAttribute('aria-expanded')!=='true')await toolsAgain.click();
  await panel.getByRole('button',{name:/^Studies \(/}).click();
  await panel.getByRole('button',{name:'Remove study 1',exact:true}).click();await frames();
  const held=await page.evaluate(()=>window.__arxChartQa.studyValues(window.__arxChartQa.data().canonical.map(b=>b.time)));
  check(held.every(row=>row.studies[0].values[0].value===null&&/unavailable/.test(row.studies[0].reason)),'Removing parent withdraws all child values without price fallback');
  await page.setViewportSize({width:390,height:844});await frames();
  const mobileTools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await mobileTools.isVisible()&&await mobileTools.getAttribute('aria-expanded')!=='true')await mobileTools.click();
  await panel.getByLabel('SMA 1 Source',{exact:true}).scrollIntoViewIfNeeded();await shot('mobile-held');
  check(await panel.getByRole('region',{name:'Study settings'}).evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Study controls fit narrow viewport');
  await panel.getByLabel('SMA 1 Source',{exact:true}).selectOption('close');await frames();
  current=await state();check(!current.config.studies[0].studySource&&current.layout.panes.length===0,'Explicit price selection returns moving average to price pane');
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
