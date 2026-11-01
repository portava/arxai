async page => {
 const resetCdp=await page.context().newCDPSession(page); try { await resetCdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}); } catch(e) { if(!String(e).includes('Must send a TouchStart')) throw e; } await resetCdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false}); await resetCdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 const errors=[], checks=[]; page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:4199'?route.continue():route.abort());
 await page.setViewportSize({width:1280,height:1000});
 await page.goto('http://127.0.0.1:4199');
 await page.waitForFunction(()=>window.__arxNativeViewportQa?.viewport.getState().paintCount>0);
 const state=()=>page.evaluate(()=>window.__arxNativeViewportQa.viewport.getState());
 const settle=()=>page.waitForFunction(()=>!window.__arxNativeViewportQa.viewport.getState().pendingPaint);
 const assert=(condition,message)=>{if(!condition)throw Error(message);};
 await page.waitForFunction(()=>innerWidth===1280&&window.__arxNativeViewportQa.viewport.getState().width>1000);
 let initial=await state();assert(initial.status==='ready'&&initial.barCount===20000,'initial viewport');
 checks.push('20k synthetic bars rendered');
 for(const style of ['candles','bars','line','area','baseline','heikinAshi','hollow']) {
  await page.locator('#style').selectOption(style);await settle();
  const s=await state();assert(s.style===style&&s.status==='ready','style '+style);
  const count=await page.evaluate(()=>{const c=document.querySelector('canvas'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&((pixels[i]>150&&pixels[i+1]<120)||(pixels[i+1]>120&&pixels[i+2]<190)||(pixels[i+2]>200&&pixels[i]<150)))n++;return n;});
  assert(count>80,'no price pixels '+style);
 }
 checks.push('seven styles with price pixels');
 await page.locator('#style').selectOption('candles');
 for(const scale of ['log','percent','indexed','linear']){await page.locator('#scale').selectOption(scale);await settle();assert((await state()).status==='ready','scale '+scale);}
 await page.getByRole('button',{name:'Invert price axis',exact:true}).click();await settle();assert((await state()).inverted,'invert');
 await page.getByRole('button',{name:'Invert price axis',exact:true}).click();await settle();
 checks.push('four scales and inversion');
 const beforeZone=await state();await page.locator('#zone').selectOption('America/New_York');await settle();
 assert((await state()).effectiveTimeZone==='America/New_York'&&JSON.stringify((await state()).range)===JSON.stringify(beforeZone.range),'timezone changes geometry');
 await page.locator('#zone').selectOption('UTC');await settle();checks.push('display zone preserves range');
 const canvas=page.locator('canvas');let box=await canvas.boundingBox();
 await page.mouse.move(box.x+box.width*.5,box.y+200);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+200,{steps:8});await page.mouse.up();await settle();
 let dragged=await state();assert(dragged.range.from<initial.range.from&&!dragged.followingLatest,'mouse drag');
 checks.push('mouse drag pan');
 const zoom=await page.evaluate(()=>{const v=window.__arxNativeViewportQa.viewport,f=v.getFrame(),r=document.querySelector('canvas').getBoundingClientRect(),nativeX=f.plot.left+f.plot.width*.4,x=Math.round(r.x+nativeX*r.width/v.getState().width),localX=(x-r.x)*v.getState().width/r.width;return {x,y:Math.round(r.y+180),logical:f.xToLogical(localX),span:f.range.to-f.range.from,localX,paintCount:v.getState().paintCount};});
 await page.mouse.move(zoom.x,zoom.y);await page.mouse.wheel(0,-150);await page.waitForFunction(n=>window.__arxNativeViewportQa.viewport.getState().paintCount>n,zoom.paintCount);await settle();
 const afterZoom=await page.evaluate(x=>{const f=window.__arxNativeViewportQa.viewport.getFrame();return {logical:f.xToLogical(x),span:f.range.to-f.range.from};},zoom.localX);
 assert(afterZoom.span<zoom.span&&Math.abs(afterZoom.logical-zoom.logical)<1e-6,'anchored wheel zoom '+JSON.stringify({zoom,afterZoom}));checks.push('cursor-anchored wheel zoom');
 await page.evaluate(()=>{window.__nativeDragLog=[];const c=document.querySelector('canvas');for(const t of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])c.addEventListener(t,e=>{const v=window.__arxNativeViewportQa.viewport;window.__nativeDragLog.push({type:e.type,id:e.pointerId,x:e.clientX,y:e.clientY,state:v.getState()});});window.addEventListener('blur',()=>window.__nativeDragLog.push({type:'blur'}));});
 // A market refresh arriving while a button is held must not end the drag.
 box=await canvas.boundingBox();await page.mouse.move(box.x+400,box.y+180);await page.mouse.down();await page.mouse.move(box.x+430,box.y+180);
 await page.evaluate(()=>{const q=window.__arxNativeViewportQa,a=q.data.map(b=>({...b}));a[a.length-1].close+=.001;q.replace(a);});await settle();
 const during=(await state()).range.from;await page.mouse.move(box.x+480,box.y+180,{steps:3});await page.mouse.up();await settle();
 assert((await state()).range.from<during,'live update interrupted drag '+JSON.stringify({during,after:await state(),events:await page.evaluate(()=>window.__nativeDragLog)}));checks.push('drag survives candle refresh');
 const history=await page.evaluate(async()=>{const q=window.__arxNativeViewportQa,v=q.viewport;v.setRange({from:19800.25,to:19900.25});let n=v.getState().paintCount;await q.waitPaint(n);const before=v.getRange();q.replace([...q.makeData(200,-200),...q.data]);n=v.getState().paintCount;await q.waitPaint(n);const prepended=v.getRange();q.replace(q.data.slice(100));n=v.getState().paintCount;await q.waitPaint(n);return {before,prepended,trimmed:v.getRange()};});
 assert(Math.abs(history.prepended.from-history.before.from-200)<1e-8&&Math.abs(history.trimmed.from-history.before.from-100)<1e-8,'history timestamp anchoring');checks.push('prepend and rolling trim preserve fractional anchor');
 await canvas.focus();await page.keyboard.press('Home');await settle();assert((await state()).range.to-(await state()).range.from>20000,'Home fit');
 await page.getByRole('button',{name:'Reset 200-bar view',exact:true}).click();await canvas.focus();await page.keyboard.press('+');await settle();assert((await state()).range.to-(await state()).range.from<200,'keyboard zoom');
 await page.keyboard.press('End');await settle();assert((await state()).followingLatest,'End latest');checks.push('focused keyboard navigation');
 await page.mouse.move(box.x+box.width*.6,box.y+180);await settle();assert((await page.locator('#inspect').textContent()).includes('Canonical UTC'),'canonical crosshair');checks.push('canonical OHLC crosshair');
 const png=await page.evaluate(()=>window.__arxNativeViewportQa.viewport.exportImage());assert(png&&png.startsWith('data:image/png;base64,'),'PNG export');checks.push('PNG snapshot');
 await page.screenshot({path:'native-viewport-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
 await page.waitForFunction(()=>window.__arxNativeViewportQa.viewport.getState().width<390&&window.__arxNativeViewportQa.viewport.getState().pixelRatio===2);await settle();
 assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'mobile overflow');
 await canvas.scrollIntoViewIfNeeded();box=await canvas.boundingBox();const x=box.x+130,y=box.y+180;assert(y<844,'touch coordinates outside viewport');
 await page.evaluate(()=>{window.__nativePointerLog=[];const c=document.querySelector('canvas');for(const t of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])c.addEventListener(t,e=>window.__nativePointerLog.push({type:e.type,id:e.pointerId,x:e.clientX,y:e.clientY,state:window.__arxNativeViewportQa.viewport.getState()}));});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-30,y,id:1},{x:x+30,y,id:2}]});
 const beforePinch=(await state()).range;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-55,y,id:1},{x:x+55,y,id:2}]});await settle();
 const afterPinch=(await state()).range;
 assert(afterPinch.to-afterPinch.from<beforePinch.to-beforePinch.from,'touch pinch');
 await page.evaluate(()=>{const q=window.__arxNativeViewportQa,a=q.data.map(b=>({...b}));a[a.length-1].close+=.001;q.replace(a);});await settle();
 const beforeRefreshPinch=(await state()).range;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-70,y,id:1},{x:x+70,y,id:2}]});await page.waitForFunction(span=>{const r=window.__arxNativeViewportQa.viewport.getRange();return r.to-r.from<span;},beforeRefreshPinch.to-beforeRefreshPinch.from);await settle();
 const afterRefreshPinch=(await state()).range;
 assert(afterRefreshPinch.to-afterRefreshPinch.from<beforeRefreshPinch.to-beforeRefreshPinch.from,'live update interrupted pinch '+JSON.stringify({box,beforePinch,afterPinch,beforeRefreshPinch,afterRefreshPinch,events:await page.evaluate(()=>window.__nativePointerLog)}));
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 checks.push('DPR2 mobile layout and touch pinch survives refresh');
 // Capture through the same CDP session: Playwright screenshot resets externally
 // emulated device scale to its context default. Retain raw PNG in the result.
 const mobileCapture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 assert((await state()).width<390&&(await state()).pixelRatio===2,'mobile screenshot changed canvas dimensions or DPR');
 const teardown=await page.evaluate(async()=>{const q=window.__arxNativeViewportQa,v=q.viewport;v.resetContext();const afterReset=v.getState();q.replace(q.makeData(100));await q.waitPaint(v.getState().paintCount);const ready=v.getState();v.destroy();const count=v.getState().paintCount;v.setCandles(q.makeData(200));v.resize();await new Promise(requestAnimationFrame);return {afterReset,ready,destroyed:v.getState(),count,canvases:document.querySelectorAll('canvas').length};});
 assert(teardown.afterReset.barCount===0&&teardown.afterReset.referencePrice===null&&teardown.ready.barCount===100&&teardown.destroyed.status==='destroyed'&&teardown.count===teardown.destroyed.paintCount&&teardown.canvases===0,'reset/destroy');checks.push('reset and teardown');
 assert(!errors.length,errors.join('\n'));
 return {checks,errors,history,teardown,initial,mobilePngBase64:mobileCapture.data};
}
