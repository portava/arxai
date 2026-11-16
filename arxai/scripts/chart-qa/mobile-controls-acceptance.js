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
  const base=typeof CHART_QA_BASE_URL==='string'?CHART_QA_BASE_URL:'http://127.0.0.1:4178';
  page.setDefaultTimeout(10000);
  const check=(value,message)=>{if(!value)throw Error(message);};
  const errors=[]; const onError=e=>errors.push(e.message); page.on('pageerror',onError);
  try {
    await page.goto(base); await page.evaluate(()=>localStorage.clear()); await page.reload();
    await page.setViewportSize({width:390,height:844});
    const chart=page.getByTestId('arx-native-chart'), canvas=page.getByTestId('arx-native-canvas');
    await canvas.waitFor();
    const original=await canvas.elementHandle();
    const advanced=page.getByTestId('chart-advanced-tools'), toggle=page.getByRole('button',{name:'Chart tools',exact:true});
    check(await toggle.getAttribute('aria-controls')===await advanced.getAttribute('id'),'Wrong disclosure target');
    check(await advanced.evaluate(el=>getComputedStyle(el).display==='none'),'Mobile advanced controls initially exposed');
    const plot=await canvas.boundingBox();
    const visible=Math.max(0,Math.min(844,plot.y+plot.height)-Math.max(0,plot.y));
    check(visible>=200,`Only ${visible}px of the plot visible on first screen (minimum200)`);
    check(await page.getByTestId('smart-chart-reader').evaluate(el=>el.getBoundingClientRect().top)>plot.y+plot.height-1,'Reader precedes plot');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Initial mobile overflow');
    await toggle.click();
    await page.getByLabel('Drawing tool',{exact:true}).selectOption('trend');
    await canvas.click({position:{x:70,y:70}});
    await toggle.click();
    const cancel=page.getByRole('button',{name:'Cancel drawing',exact:true});
    check(await cancel.isVisible(),'Active drawing has no touch cancellation');
    check(await page.getByRole('status').filter({hasText:'choose the second candle'}).isVisible(),'Active drawing prompt hidden');
    await cancel.click();
    check(await cancel.count()===0,'Drawing placement remains active');
    check(await page.getByRole('button',{name:'Pan',exact:true}).evaluate(el=>document.activeElement===el),'Cancel focus lost');
    await toggle.click();
    await page.getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');
    await canvas.click({position:{x:100,y:90}});
    await page.getByRole('button',{name:'Objects (1)',exact:true}).click();
    const price=page.getByLabel('Drawing 1 start price',{exact:true});
    const oldPrice=await price.inputValue();
    await price.fill('1.08123'); await toggle.click(); // blur must commit before hide
    await toggle.click();
    check(Number(await price.inputValue())===1.08123,'Edit lost on collapse');
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    check(await price.inputValue()===oldPrice,'Undo history lost on collapse');
    // Native keyboard Escape closes tools rather than exiting the entire chart.
    await price.focus(); await page.keyboard.press('Escape');
    check(await toggle.getAttribute('aria-expanded')==='false','Escape failed to close tools');
    check(await toggle.evaluate(el=>document.activeElement===el),'Escape lost focus');
    // Desktop moves the tools into the floating window, which opens on the
    // focused control's section, so focus never drops to <body>.
    await page.setViewportSize({width:1440,height:1100});
    await page.waitForFunction(()=>{const a=document.activeElement;return !!a&&a!==document.body&&a.getClientRects().length>0;});
    check(await toggle.evaluate(el=>document.activeElement===el),'Widening moved focus off the Tools toggle');
    // The window is narrower than the workbench breakpoint (per container, not
    // per viewport), so its advanced tools stay folded behind the toggle.
    check(await advanced.evaluate(el=>getComputedStyle(el).display==='none'),'Floating tools window is not compact');
    const style=page.getByLabel('Chart style',{exact:true});
    await toggle.click(); await style.selectOption('heikinAshi'); await toggle.click();
    check(await page.getByTestId('chart-style-note').isVisible(),'Averaged-price explanation hidden with tools');
    check((await page.getByTestId('chart-style-note').textContent()).includes('averaged'),'Wrong style explanation');
    check(await original.evaluate(el=>el.isConnected),'Controls remounted chart');
    await chart.evaluate(el=>el.style.width='');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
    check(await toggle.isVisible(),'Fullscreen removed compact controls');
    await toggle.click(); await page.getByLabel('Price scale',{exact:true}).focus();
    // Each Escape closes the innermost layer: the Display popup, then Tools, then fullscreen.
    await page.keyboard.press('Escape');
    check(await page.getByLabel('Price scale',{exact:true}).isHidden(),'Escape left the Display popup open');
    await page.keyboard.press('Escape');
    check(await toggle.getAttribute('aria-expanded')==='false','Second Escape failed to close tools');
    check(await page.getByRole('button',{name:'Exit fullscreen',exact:true}).isVisible(),'Closing tools also exited fullscreen');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
    check(await original.evaluate(el=>el.isConnected),'Fullscreen remounted chart');
    check(errors.length===0,`Page errors: ${errors}`);
    return {base,fixture:'synthetic offline',initialPlotVisiblePx:visible,
      mobileViewport:'390x844',containerWidthResponsive:true,preservedDrawingEditAndUndo:true,
      touchCancel:true,focusKeptOnWiden:true,escapeAndFullscreen:true,
      chartContainerRetained:true,errors,scope:'functional geometry/interaction, not timing or active-reader evidence'};
  } finally {page.off('pageerror',onError);}
}
