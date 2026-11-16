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
 // The Studies panel stays open after adding a study; open it only when closed.
 const openStudies=async n=>{
  const all=page.getByRole('button',{name:`Studies (${n})`,exact:true,includeHidden:true});
  if(await all.getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:`Studies (${n})`,exact:true}).click();
 };
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4178');
 await page.evaluate(()=>localStorage.clear()); await page.reload();
 await page.setViewportSize({width:1600,height:1100});
 await openStudies(0);
 const names=await page.getByLabel('Available studies',{exact:true}).getByRole('button').allTextContents();
 if(names.length!==23) throw Error(`Incomplete study catalog: ${names.length} of 23`);
 const addNames=await page.getByLabel('Available studies',{exact:true}).getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')));
 const refused=[];
 for(const name of addNames) {
  await page.getByRole('button',{name,exact:true}).click();
  // Anchored VWAP and the volume profile need qualified traded volume, which
  // synthetic bars do not carry: the chart must refuse visibly and add nothing.
  const refusal={'Add Anchored VWAP':['vwap',/^VWAP anchor not changed: select an actual visible original bar with qualified positive traded volume/],
   'Add Estimated volume profile':['volume_profile',/^Profile not changed: choose an original closed range with qualified traded volume/]}[name];
  if(refusal){
   if(name==='Add Anchored VWAP') await page.getByTestId('arx-native-canvas').click({position:{x:500,y:200}});
   await page.getByText(refusal[1]).first().waitFor();
   if(await page.evaluate(kind=>window.__arxChartQa.configuration().studies.some(s=>s.config.kind===kind),refusal[0])) throw Error(`${name} added without traded volume`);
   refused.push(refusal[0]); continue;
  }
  await openStudies(1);
  await page.getByText('Data window · study values at the crosshair',{exact:true}).click();
  const chart=page.getByTestId('arx-native-canvas');
  await chart.hover({position:{x:500,y:70}});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Study values at selected candle"]')?.textContent.includes(': '));
  const values=await page.getByLabel('Study values at selected candle',{exact:true}).textContent();
  if(values.includes('NaN')||values.includes('Infinity')) throw Error(`Invalid data window for ${name}`);
  await page.getByText('Data window · study values at the crosshair',{exact:true}).click();
  await openStudies(1);
  await page.getByRole('button',{name:'Remove study 1',exact:true}).click();
 }
 await page.getByRole('button',{name:'Add Exponential moving average',exact:true}).click();
 await page.getByRole('button',{name:'Duplicate study 1',exact:true}).click();
 await page.getByLabel('EMA 2 Period',{exact:true}).fill('200');await page.getByLabel('EMA 2 Period',{exact:true}).blur();
 await page.getByLabel('EMA 2 Source',{exact:true}).selectOption('hl2');
 await page.getByRole('button',{name:'Add MACD',exact:true}).click();
 await page.getByLabel('MACD 3 Signal method',{exact:true}).selectOption('sma');
 await page.getByLabel('MACD 3 Fast',{exact:true}).fill('2000');await page.getByLabel('MACD 3 Fast',{exact:true}).blur();
 if(await page.getByLabel('MACD 3 Fast',{exact:true}).inputValue()!=='12') throw Error('Invalid input not restored');
 await page.reload();
 await openStudies(3);
 if(await page.getByLabel('EMA 1 Period',{exact:true}).inputValue()!=='50'||await page.getByLabel('EMA 2 Period',{exact:true}).inputValue()!=='200') throw Error('Independent duplicate periods did not persist');
 if(await page.getByLabel('EMA 2 Source',{exact:true}).inputValue()!=='hl2'||await page.getByLabel('MACD 3 Signal method',{exact:true}).inputValue()!=='sma') throw Error('Study methods did not persist');
 await page.screenshot({path:'/private/tmp/arx-study-library-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('Study settings mobile overflow');
 await page.screenshot({path:'/private/tmp/arx-study-library-mobile.png',fullPage:true});
 await openStudies(3);
 await page.getByText('Data window · study values at the crosshair',{exact:true}).click();
 await page.setViewportSize({width:1600,height:1100});
 await page.getByTestId('arx-native-canvas').hover({position:{x:300,y:420}});
 await page.waitForFunction(()=>document.querySelector('[aria-label="Study values at selected candle"]')?.textContent.includes('Signal:'));
 const data=await page.getByLabel('Study values at selected candle',{exact:true}).textContent();
 if(data.includes('unavailable')) throw Error('Late-history study values unexpectedly unavailable');
 const stress=await page.evaluate(()=>window.runChartStressBenchmark());
 if(errors.length) throw Error(JSON.stringify(errors));
 return {catalog:names.length,refusedWithoutTradedVolume:refused,duplicateIndependent:true,persistence:true,sourceSelection:true,macdSignalSelection:true,mobileNoOverflow:true,dataWindow:true,errors,stress};
}
