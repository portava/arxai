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
 await page.goto('http://127.0.0.1:4178');await page.evaluate(()=>localStorage.clear());await page.reload();await page.setViewportSize({width:1600,height:1100});
 const primary=page.getByTestId('arx-native-chart').first();
 await primary.getByLabel('Chart style',{exact:true}).selectOption('line');
 await page.getByRole('button',{name:'Four charts',exact:true}).click();
 if(await page.getByTestId('arx-native-chart').count()!==4)throw Error('Four charts did not mount');
 const second=page.getByRole('region',{name:'Comparison chart 1',exact:true});
 await second.locator('summary').first().click();await second.getByTestId('input-symbol-search').fill('gold');await second.getByTestId('suggestion-XAUUSD').click();
 await second.getByRole('button',{name:'H1 timeframe',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Comparison chart 1"] [data-testid="arx-native-tf-H1"]')?.getAttribute('aria-pressed')==='true');
 if(await primary.getByLabel('Chart style',{exact:true}).inputValue()!=='line')throw Error('Layout reset primary preferences');
 if(await primary.getByTestId('arx-native-tf-M15').getAttribute('aria-pressed')!=='true')throw Error('Comparison changed primary interval');
 await page.getByLabel('Link crosshair',{exact:true}).check();await page.getByLabel('Link time range',{exact:true}).check();
 const canvas=primary.getByTestId('arx-native-canvas');await canvas.hover({position:{x:300,y:100}});
 await page.waitForFunction(()=>{const texts=[...document.querySelectorAll('[data-testid="chart-candle-inspector"]')].map(node=>node.textContent);const stamp=text=>Date.parse(text.slice(0,16).replace(' ','T')+':00Z');const delta=stamp(texts[0])-stamp(texts[1]);return Number.isFinite(delta)&&delta>=0&&delta<3600000;});
 const texts=await page.getByTestId('chart-candle-inspector').allTextContents();
 const stamp=text=>Date.parse(text.slice(0,16).replace(' ','T')+':00Z');
 const difference=stamp(texts[0])-stamp(texts[1]);
 if(difference<0||difference>=3600000)throw Error('Linked crosshair did not align to the target H1 candle: '+JSON.stringify(texts));
 if(Number(texts[0].split(' C ')[1])>=10||Number(texts[1].split(' C ')[1])<1000)throw Error('Crosshair copied a different instrument price');
 await primary.getByRole('button',{name:'Fit all loaded chart history',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Comparison chart 1"] output[aria-label="Linked chart history status"]')?.textContent.includes('clipped'));
 await primary.getByRole('button',{name:'Reset chart scale',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Comparison chart 1"] output[aria-label="Linked chart history status"]')?.textContent==='');
 await page.screenshot({path:'/private/tmp/arx-chart-linked-desktop.png',fullPage:true});
 await page.reload();await page.getByRole('region',{name:'Comparison chart 1',exact:true}).waitFor();
 if(await page.getByTestId('arx-native-chart').count()!==4)throw Error('Four-chart layout not persisted');
 if(!await page.getByLabel('Link crosshair',{exact:true}).isChecked())throw Error('Link settings not persisted');
 if(!(await second.locator('summary').first().textContent()).includes('XAUUSD'))throw Error('Comparison symbol lost');
 await page.getByRole('button',{name:'Switch instrument',exact:true}).click();await page.getByRole('button',{name:'Switch instrument',exact:true}).click();
 if(!(await second.locator('summary').first().textContent()).includes('XAUUSD'))throw Error('Primary switch changed independent comparison');
 await page.setViewportSize({width:390,height:844});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Four-chart mobile overflow');
 await page.screenshot({path:'/private/tmp/arx-chart-linked-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'One chart',exact:true}).click();
 if(await page.getByTestId('arx-native-chart').count()!==1)throw Error('Comparison teardown failed');
 if(await primary.getByLabel('Chart style',{exact:true}).inputValue()!=='line')throw Error('Teardown reset primary preferences');
 if(errors.length)throw Error(JSON.stringify(errors));
 return {fourViews:true,independentSymbols:true,primaryContextPreserved:true,crosshairAlignedByUTC:true,ownPriceOnEachView:true,clippedHistoryDisclosed:true,persisted:true,mobileNoOverflow:true,errors};
}
