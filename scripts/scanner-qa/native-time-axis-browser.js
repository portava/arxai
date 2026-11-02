// Actual Scanner with isolated candles; trusted input and read-only witnesses.
async page => {
 function nativeBuildProvenance(build) {
   if (!build?.nativeEngine) return null;
   if (build.qaOnlyDefaultEngineOverride === false && build.productDefaultEngineId === 'arx-native') return 'product-default';
   if (build.qaOnlyDefaultEngineOverride === true && build.productDefaultEngineId === 'lightweight-charts') return 'qa-override';
   return null;
 }
 const out={passed:false,checks:[],limitations:['Build metadata distinguishes product-native default from an explicit historical QA override.','Synthetic loaded history; no broker, competitor timing or market interpretation claim.']};
 const check=(ok,label)=>{if(!ok)throw Error(label);out.checks.push(label);};
 const ready=()=>page.waitForFunction(()=>{const s=window.__arxChartQa.snapshot();return s?.state.status==='ready'&&!s.state.pendingPaint&&window.__arxChartQa.configuration().analysisFocus.verified;});
 const snap=()=>page.evaluate(()=>window.__arxChartQa.snapshot());
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const target=async()=>{
  await page.locator('canvas[data-arx-native-viewport]').first().evaluate(el=>el.scrollIntoView({block:'center'}));await frames();
  return page.evaluate(()=>{const box=document.querySelector('canvas[data-arx-native-viewport]').getBoundingClientRect(),p=window.__arxChartQa.layout().price;const target={x:box.x+p.left+p.width*.55,y:box.bottom-16,dx:Math.min(90,p.width*.22)};if(document.elementFromPoint(target.x,target.y)!==document.querySelector('canvas[data-arx-native-viewport]'))throw Error('Time axis is obscured');return target;});
 };
 const drag=async(p,dx)=>{await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+dx,p.y,{steps:6});await page.mouse.up();await ready();};
 try{
  out.build=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());
  check(nativeBuildProvenance(out.build)!==null&&out.build.productionRuntimeChecked&&out.build.sourceUnchanged&&!out.build.source.status&&await page.evaluate(()=>window.__arxScannerQaBuildId)===out.build.buildId,'Clean exact executed native production QA source');
  await page.setViewportSize({width:1440,height:1200});await ready();
  const initial=await snap(),canonical=await page.evaluate(()=>window.__arxChartQa.data().canonical),p=await target();
  check(p.y>180&&p.y<1200,'Visible bottom-axis target outside header');
  const anchor=await page.evaluate(({x})=>{const s=window.__arxChartQa.snapshot(),layout=window.__arxChartQa.layout(),a=window.__arxChartQa.data().canonical,idx=Math.round(s.range.from+(x-s.bounds.x-layout.price.left)/layout.price.width*(s.range.to-s.range.from));const bar=a[idx];return{time:bar.time,price:bar.close};},p);
  const xy=()=>page.evaluate(a=>window.__arxChartQa.anchorCoordinates(a.time,a.price),anchor);
  const beforeXY=await xy();await drag(p,p.dx);const zoomed=await snap();out.initial=initial;out.zoomed=zoomed;
  check(zoomed.range.to-zoomed.range.from<initial.range.to-initial.range.from,'Rightward time-axis drag increases candle spacing');
  check(zoomed.adapterId===initial.adapterId,'Axis interaction retains renderer');
  check(JSON.stringify(await page.evaluate(()=>window.__arxChartQa.data().canonical))===JSON.stringify(canonical),'Axis drag preserves canonical candles');
  // Nearest whole candle is close to the fractional pointer anchor. Its motion
  // is bounded by the changed spacing of less than half a bar, not fixed zero.
  const afterXY=await xy();out.anchorPixels={before:beforeXY,after:afterXY};
  check(afterXY&&beforeXY&&Math.abs(afterXY.x-beforeXY.x)<5,'Loaded observation near pointer anchor stays visually stable');
  await drag(await target(),-p.dx);const expanded=await snap();
  check(expanded.range.to-expanded.range.from>zoomed.range.to-zoomed.range.from,'Leftward drag decreases spacing');
  // Set a manual vertical scale through the actual price gutter, then ensure
  // subsequent horizontal interactions do not silently restore auto-fit.
  const vertical=await page.evaluate(()=>{const b=document.querySelector('canvas[data-arx-native-viewport]').getBoundingClientRect(),p=window.__arxChartQa.layout().price;return{x:b.right-25,y:b.top+p.top+p.height*.6};});
  check(vertical.y>180&&vertical.y+45<1200,'Price-axis setup is visible');
  await page.mouse.move(vertical.x,vertical.y);await page.mouse.down();await page.mouse.move(vertical.x,vertical.y+45);await page.mouse.up();await ready();
  const bounds=(await snap()).state.manualPriceRange;check(bounds&&Number.isFinite(bounds.min)&&Number.isFinite(bounds.max)&&bounds.max>bounds.min,'Manual price bounds established through visible control');const manual=JSON.stringify(bounds);
  await drag(await target(),p.dx);check(JSON.stringify((await snap()).state.manualPriceRange)===manual,'Time-axis drag preserves manual vertical bounds');
  const resetPoint=await target();await page.mouse.dblclick(resetPoint.x,resetPoint.y);await ready();
  const reset=await snap();check(Math.abs((reset.range.to-reset.range.from)-(initial.range.to-initial.range.from))<1e-6,'Time-axis double-click restores initial default spacing');
  check(JSON.stringify(reset.state.manualPriceRange)===manual,'Horizontal double-click does not reset vertical scale');
  const cdp=await page.context().newCDPSession(page);
  try{
   await page.setViewportSize({width:390,height:844});await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});await ready();
   const t=await target(),before=await snap();out.mobile={target:t,before};check(t.y>140&&t.y<844,'Touch time-axis target is visible');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:t.x,y:t.y,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:t.x+t.dx,y:t.y,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await ready();
   const after=await snap();out.mobile.after=after;check(after.range.to-after.range.from<before.range.to-before.range.from&&after.state.pixelRatio===2,'Trusted mobile touch changes spacing at DPR2');
   check(JSON.stringify(after.state.manualPriceRange)===manual,'Touch time-axis gesture retains manual vertical bounds');
   await page.screenshot({path:'native-time-axis-mobile.png',fullPage:false});
  }finally{await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.detach();}
  await page.setViewportSize({width:1440,height:1200});await ready();await target();await page.screenshot({path:'native-time-axis-desktop.png',fullPage:false});
  check(JSON.stringify(await page.evaluate(()=>window.__arxChartQa.data().canonical))===JSON.stringify(canonical),'All horizontal gestures preserve canonical source data');
  out.fixture=await page.evaluate(()=>window.__readFixtureLog());check(!out.fixture.errors.length,'No page exceptions');check(!out.fixture.blocked.some(x=>x.kind==='external'||x.kind==='websocket'),'No external feed or broker requests');out.passed=true;
 }catch(error){out.failure=String(error);out.fixture=await page.evaluate(()=>window.__readFixtureLog());}
 return out;
}
