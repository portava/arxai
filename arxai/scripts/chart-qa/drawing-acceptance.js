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
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:4178');await page.evaluate(()=>localStorage.clear());await page.reload();
  await page.setViewportSize({width:1600,height:1100});
  const chart=page.getByTestId('arx-native-canvas');await chart.waitFor();
  const read=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')||'[]'));
  const gesture=async(from,to,cancel=false)=>{
    await chart.scrollIntoViewIfNeeded();const box=await chart.boundingBox();
    await page.mouse.move(box.x+from.x,box.y+from.y);await page.mouse.down();
    await page.mouse.move(box.x+to.x,box.y+to.y,{steps:8});
    if(cancel)await page.keyboard.press('Escape');await page.mouse.up();
  };
  await page.getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');
  await chart.click({position:{x:300,y:80}});
  await page.getByRole('button',{name:'Objects (1)',exact:true}).waitFor();
  const initial=await read();
  await gesture({x:300,y:80},{x:400,y:150});
  const edited=await read();if(edited[0].start.price===initial[0].start.price)throw Error('Drag did not persist');
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  if(JSON.stringify(await read())!==JSON.stringify(initial))throw Error('One drag was not one undo step');
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  if(JSON.stringify(await read())!==JSON.stringify(edited))throw Error('Redo lost geometry');
  await gesture({x:300,y:150},{x:400,y:210},true);
  if(JSON.stringify(await read())!==JSON.stringify(edited))throw Error('Escape persisted a preview');
  await page.getByRole('button',{name:'Objects (1)',exact:true}).click();
  await page.getByRole('button',{name:'Lock drawing 1',exact:true}).click();
  const locked=await read();
  await page.getByRole('button',{name:'Objects (1)',exact:true}).click();
  await gesture({x:300,y:150},{x:400,y:210});
  if(JSON.stringify(await read())!==JSON.stringify(locked))throw Error('Locked drawing moved');
  await page.getByRole('button',{name:'Reset chart scale',exact:true}).click();
  await page.getByRole('button',{name:'Latest',exact:true}).click();
  for(const tool of ['vertical','trend','ray','extended','rectangle','fibonacci']){
    await page.getByLabel('Drawing tool',{exact:true}).selectOption(tool);
    await chart.click({position:{x:400,y:100}});
    if(tool!=='vertical')await chart.click({position:{x:650,y:220}});
  }
  if((await read()).length!==7)throw Error('New tools not persisted');
  await page.getByRole('button',{name:'Objects (7)',exact:true}).click();
  await page.getByLabel('Drawing 6 line width',{exact:true}).selectOption('3');
  await page.getByLabel('Drawing 6 line style',{exact:true}).selectOption('dashed');
  await page.getByRole('button',{name:'Select drawing 6',exact:true}).click();
  await page.screenshot({path:'/private/tmp/arx-drawing-editor-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Drawing settings overflow mobile');
  await page.screenshot({path:'/private/tmp/arx-drawing-editor-mobile.png',fullPage:true});
  await page.reload();await page.getByRole('button',{name:'Objects (7)',exact:true}).click();
  if(!await page.getByLabel('Drawing 1 start price',{exact:true}).isDisabled())throw Error('Lock not restored');
  if(await page.getByLabel('Drawing 6 line width',{exact:true}).inputValue()!=='3')throw Error('Style not restored');

  // Chromium touch input reaches the browser's real PointerEvent/touch pipeline.
  const context=await page.context().browser().newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const touch=revealing(await context.newPage());await touch.goto('http://127.0.0.1:4178');
  const touchChart=touch.getByTestId('arx-native-canvas');
  await touch.getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');
  await touchChart.tap({position:{x:70,y:80}});
  const before=await touch.evaluate(()=>JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')));
  await touchChart.scrollIntoViewIfNeeded();const box=await touchChart.boundingBox();
  const session=await context.newCDPSession(touch);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+70,y:box.y+80,id:1}]});
  for(let y=90;y<=150;y+=10)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+70,y:box.y+y,id:1}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const after=await touch.evaluate(()=>JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')));
  if(before[0].start.price===after[0].start.price)throw Error('Touch drag did not commit');
  await context.close();
  if(errors.length)throw Error(JSON.stringify(errors));
  return {tools:7,mouseDrag:true,touchDrag:true,singleUndo:true,escapeRollback:true,locking:true,persistence:true,mobileNoOverflow:true,errors};
}
