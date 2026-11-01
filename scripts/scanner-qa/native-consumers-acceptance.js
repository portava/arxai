// Playwright CLI run-code. Use the actual-app native QA build and an explicitly
// synthetic replay-qualified payload inside the existing offline API boundary.
// No assertion below is a broker or physical-display latency measurement.
async page => {
 const result={passed:false,checks:[],screenshots:[],limitations:['QA-only native default override; deployed/default engine unchanged.','Synthetic replay-qualified contract fixture; no broker, live data, performance or multi-chart replay acceptance.']};
 const check=(yes,label)=>{if(!yes)throw Error(label);result.checks.push(label);};
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const snap=(index=0)=>page.evaluate(index=>window.__arxChartQa.snapshot(index),index);
 const ready=async(count)=>{await page.waitForFunction(count=>window.__arxChartQa.count()===count&&Array.from({length:count},(_,i)=>window.__arxChartQa.snapshot(i)).every(s=>s?.barCount>0&&s.state.status==='ready'&&!s.state.pendingPaint)&&Array.from({length:count},(_,i)=>window.__arxChartQa.configuration(i)).every(c=>c?.analysisFocus.verified===true),count);};
 const tools=async(container)=>{const button=container.getByRole('button',{name:'Chart tools',exact:true});if(await button.isVisible()&&await button.getAttribute('aria-expanded')!=='true')await button.click();};
 try {
  result.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');return r.json();});
  check(result.build.nativeEngine&&result.build.qaOnlyDefaultEngineOverride&&result.build.sourceUnchanged&&!result.build.source.status,'Clean exact-source actual-app native QA build');
  await page.setViewportSize({width:1800,height:1200});
  await page.getByRole('button',{name:'One chart',exact:true}).click();await ready(1);
  const primary=page.getByTestId('arx-native-chart').first();
  await primary.getByTestId('arx-native-tf-M15').click();await ready(1);
  const original=(await snap()).adapterId;
  await page.getByRole('button',{name:'Two charts',exact:true}).click();await ready(2);
  check((await snap()).adapterId===original,'Opening comparison retains primary adapter');
  const comparison=page.getByTestId('comparison-chart').first();
  await comparison.getByTestId('arx-native-tf-M5').click();await ready(2);
  check((await snap(0)).intervalSeconds===900&&(await snap(1)).intervalSeconds===300,'Comparison M5 remains independent of primary M15');
  await page.getByLabel('Link time range',{exact:true}).check();
  await page.getByLabel('Link crosshair',{exact:true}).check();
  await tools(primary);
  await primary.getByRole('button',{name:'Zoom in chart',exact:true}).click();await ready(2);await frames();
  const a=await snap(0),b=await snap(1);
  check(b.state.linkedCrosshairTime==null,'Link activation invents no crosshair');
  check(a.visibleTimeRange&&b.visibleTimeRange&&Math.abs(a.visibleTimeRange.to-b.visibleTimeRange.to)<=900,'Linked ranges align source-time edges within the differing interval');
  const data=await page.evaluate(()=>window.__arxChartQa.data(0).canonical);
  const target=data.find(c=>c.time>=a.visibleTimeRange.from+Math.floor((a.visibleTimeRange.to-a.visibleTimeRange.from)/2));
  await primary.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();
  const point=await page.evaluate(target=>window.__arxChartQa.anchorCoordinates(target.time,target.close,0),target);
  check(!!point,'Crosshair target has real frame coordinates');const visibleBox=(await snap()).bounds;await page.mouse.move(point.x,visibleBox.y+visibleBox.height/2);await frames();
  check((await snap(1)).state.linkedCrosshairTime===target.time,'Real pointer crosshair links by source time into independent M5 chart');
  await page.screenshot({path:'native-linked-layout.png',fullPage:false});result.screenshots.push('native-linked-layout.png');
  await page.getByRole('button',{name:'One chart',exact:true}).click();await ready(1);
  check((await snap()).adapterId===original,'Closing comparison retains primary adapter');
  const canonical=await page.evaluate(()=>window.__arxChartQa.data().canonical);
  await primary.getByRole('button',{name:'Replay loaded bars',exact:true}).click();
  await page.getByTestId('chart-replay').waitFor();await ready(1);
  const replay=page.getByTestId('chart-replay');
  check((await snap()).testId==='replay-canvas'&&(await snap()).adapterId!==original,'Replay replaces live layout with separate native engine');
  check(await page.getByTestId('scanner-chart-panel').count()===0,'Live scanner is unmounted in replay');
  check(await page.getByTestId('chart-native-credit').count()===1&&await page.getByTestId('chart-library-credit').count()===0,'Replay credit reflects actual native renderer');
  const assertPrefix=async(count)=>{
   await page.waitForFunction(count=>{const s=window.__arxChartQa.snapshot();return s?.barCount===count&&s.state.status==='ready'&&!s.state.pendingPaint;},count);
   const observed=await page.evaluate(()=>window.__arxChartQa.data().canonical);
   check(JSON.stringify(observed)===JSON.stringify(canonical.slice(0,count)),'Completed native replay contains exactly first '+count+' canonical bars');
  };
  await assertPrefix(Math.min(100,canonical.length));
  const setPosition=async(value)=>{await replay.getByLabel('Replay position',{exact:true}).fill(String(value));await assertPrefix(value);};
  await setPosition(canonical.length);await setPosition(12);
  await replay.getByRole('button',{name:'Next replay bar',exact:true}).click();await assertPrefix(13);
  await tools(replay);
  await replay.getByLabel('Chart style',{exact:true}).selectOption('heikinAshi');await frames();
  check((await snap()).state.style==='heikinAshi','Replay applies HA view');await assertPrefix(13);
  await replay.getByLabel('Chart style',{exact:true}).selectOption('candles');await frames();
  const downloaded=page.waitForEvent('download');await replay.getByRole('button',{name:'Export PNG',exact:true}).click();
  const download=await downloaded;check(download.suggestedFilename()==='ARX-EURUSD-M15.png','Replay export names the selected market and interval');
  await download.saveAs('native-replay-export.png');result.screenshots.push('native-replay-export.png');
  const beforeExit=(await page.evaluate(()=>window.__readFixtureLog())).requests.length;
  await replay.getByRole('button',{name:'Exit replay · load current data',exact:true}).click();
  await page.getByTestId('scanner-chart-panel').waitFor();await ready(1);
  const log=await page.evaluate(()=>window.__readFixtureLog());
  check(log.requests.slice(beforeExit).some(r=>r.path==='/api/chart/candles'&&r.status===200),'Replay exit acquires current window again across document boundary');
  check(log.errors.length===0,'No page exceptions');
  check(!log.blocked.some(r=>r.kind==='external'||r.kind==='websocket'),'No external feed or broker request');
  result.fixture=log;result.final=await snap();result.passed=true;
 }catch(error){result.failure=String(error);result.fixture=await page.evaluate(()=>window.__readFixtureLog());}
 return result;
}
