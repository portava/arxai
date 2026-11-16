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
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await page.evaluate(()=>localStorage.clear()); await page.reload();
 await page.setViewportSize({width:1600,height:1100});
 const chart=page.getByTestId('arx-native-canvas');
 await chart.waitFor();
 // Hover once and record the canonical legend. Every style switch must show the
 // same canonical OHLC text first (no pointer move: the adapter queues a legend
 // update on a style change) and the labelled HA suffix only in Heikin Ashi.
 const styleSelect=page.getByLabel('Chart style',{exact:true});
 const styleValues=await styleSelect.locator('option').evaluateAll(options=>options.map(option=>option.value));
 if(JSON.stringify(styleValues)!==JSON.stringify(['candles','bars','line','area','baseline','heikinAshi','hollow'])) throw Error(`Unexpected chart styles: ${styleValues}`);
 await chart.hover({position:{x:300,y:120}});
 await page.waitForFunction(()=>document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent.includes('UTC'));
 const canonicalLegend=await page.getByTestId('chart-candle-inspector').textContent();
 if(canonicalLegend.includes('  ·  HA ')) throw Error('HA legend shown in candles style');
 for(const style of ['bars','line','area','baseline','heikinAshi','hollow','candles']) {
   await styleSelect.selectOption(style);
   await page.waitForFunction(([canonical,ha])=>{
     const text=document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? '';
     // The Heikin Ashi suffix is labelled as averaged, not tradable.
     return ha ? text.startsWith(`${canonical}  ·  HA (averaged, not tradable) O `) : text===canonical;
   },[canonicalLegend,style==='heikinAshi'],{timeout:5000}).catch(async()=>{throw Error(`Legend after ${style}: ${await page.getByTestId('chart-candle-inspector').textContent()}`);});
 }
 // Panes before any study (price plus the default volume pane).
 const basePanes=await page.evaluate(()=>window.__arxChartQa.snapshot().panes);
 await page.getByRole('button',{name:'Studies (0)',exact:true}).click();
 for(const name of ['Simple moving average','Exponential moving average','Bollinger Bands','Relative strength index','MACD']) await page.getByRole('button',{name:`Add ${name}`,exact:true}).click();
 await page.getByLabel('SMA 1 Period',{exact:true}).fill('10');
 await page.getByLabel('SMA 1 Period',{exact:true}).blur();
 await page.getByRole('button',{name:'Studies (5)',exact:true}).click();
 // The ARX canvas draws every pane on one canvas; count panes through the witness.
 if(await page.evaluate(()=>window.__arxChartQa.snapshot().panes)!==basePanes+2) throw Error('Expected RSI and MACD panes below the price pane');
 for(const tool of ['horizontal','trend','fibonacci']) {
   await page.getByLabel('Drawing tool',{exact:true}).selectOption(tool);
   await chart.click({position:{x:300,y:80}});
   if(tool!=='horizontal') await chart.click({position:{x:600,y:160}});
 }
 await page.getByRole('button',{name:'Objects (3)',exact:true}).click();
 if(await page.getByTestId('chart-drawing-object').count()!==3) throw Error('Drawings did not render in object manager');
 await page.getByLabel('Drawing 1 start price',{exact:true}).fill('1.08123');
 await page.getByLabel('Drawing 1 start price',{exact:true}).blur();
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await page.getByRole('button',{name:'Redo',exact:true}).click();
 if(Number(await page.getByLabel('Drawing 1 start price',{exact:true}).inputValue())!==1.08123) throw Error('Object edit undo/redo failed');
 await page.getByRole('button',{name:'Hide drawings',exact:true}).click();
 await page.getByRole('button',{name:'Show drawings',exact:true}).click();
 await page.getByRole('button',{name:'Objects (3)',exact:true}).click();
 await page.getByRole('button',{name:'Templates',exact:true}).click();
 await page.getByLabel('Template name',{exact:true}).fill('Acceptance template');
 await page.getByRole('button',{name:'Save new',exact:true}).click();
 await page.getByText('Template saved in this browser.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByLabel('Chart style',{exact:true}).selectOption('line');
 await page.getByRole('button',{name:'Templates',exact:true}).click();
 await page.getByRole('listbox').selectOption({label:'Acceptance template'});
 await page.getByRole('button',{name:'Apply selected',exact:true}).click();
 await page.getByRole('button',{name:'Close',exact:true}).click();
 if(await page.getByLabel('Chart style',{exact:true}).inputValue()!=='candles') throw Error('Template did not restore style');
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'Export PNG',exact:true}).click();
 const download=await downloadPromise;
 if(!download.suggestedFilename().endsWith('.png')) throw Error('No chart PNG');
 await download.saveAs('/private/tmp/arx-smart-chart-export.png');
 await page.reload();
 await page.getByRole('button',{name:'Objects (3)',exact:true}).waitFor();
 await page.getByRole('button',{name:'Studies (5)',exact:true}).waitFor();
 await page.getByRole('button',{name:'Studies (5)',exact:true}).click();
 if(await page.getByLabel('SMA 1 Period',{exact:true}).inputValue()!=='10') throw Error('Study period was not persisted');
 await page.getByRole('button',{name:'Studies (5)',exact:true}).click();
 await page.getByRole('button',{name:'Switch instrument',exact:true}).click();
 await page.getByRole('button',{name:'Objects (0)',exact:true}).waitFor();
 await page.getByRole('button',{name:'Switch instrument',exact:true}).click();
 await page.getByRole('button',{name:'Objects (3)',exact:true}).waitFor();
 await page.getByRole('button',{name:'H4 timeframe',exact:true}).click();
 await page.getByRole('button',{name:'Objects (0)',exact:true}).waitFor();
 await page.getByRole('button',{name:'M15 timeframe',exact:true}).click();
 await page.getByRole('button',{name:'Objects (3)',exact:true}).waitFor();
 await page.screenshot({path:'/private/tmp/arx-smart-chart-workbench-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Two charts',exact:true}).click();
 await page.getByTestId('comparison-chart').waitFor();
 if(await page.getByTestId('arx-native-chart').count()!==2) throw Error('Two-chart layout failed');
 await page.getByTestId('comparison-chart').getByRole('button',{name:'H4 timeframe',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="comparison-chart"] [data-testid="arx-native-tf-H4"]')?.getAttribute('aria-pressed')==='true');
 if(await page.getByTestId('arx-native-tf-M15').first().getAttribute('aria-pressed')!=='true') throw Error('Secondary interval changed primary');
 await page.reload();
 await page.getByTestId('comparison-chart').waitFor();
 if(await page.getByTestId('comparison-chart').getByTestId('arx-native-tf-H4').getAttribute('aria-pressed')!=='true') throw Error('Comparison interval not saved');
 await page.setViewportSize({width:390,height:844});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('Mobile page overflow');
 await page.screenshot({path:'/private/tmp/arx-smart-chart-workbench-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'One chart',exact:true}).click();
 await page.getByRole('button',{name:'Chart tools',exact:true}).click();
 await page.getByRole('button',{name:'Studies (5)',exact:true}).click();
 for(let i=0;i<5;i++) await page.getByRole('button',{name:'Remove study 1',exact:true}).click();
 await page.getByRole('button',{name:'Studies (0)',exact:true}).click();
 if(await page.evaluate(()=>window.__arxChartQa.snapshot().panes)!==basePanes) throw Error('Empty indicator panes leaked');
 const touchContext=await page.context().browser().newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const touch=revealing(await touchContext.newPage());
 await touch.goto(base);
 await touch.getByRole('button',{name:'Chart tools',exact:true}).click();
 await touch.getByLabel('Drawing tool',{exact:true}).selectOption('trend');
 await touch.getByTestId('arx-native-canvas').tap({position:{x:70,y:70}});
 await touch.getByTestId('arx-native-canvas').tap({position:{x:200,y:140}});
 await touch.getByRole('button',{name:'Objects (1)',exact:true}).waitFor();
 await touchContext.close();
 const basic=await page.evaluate(()=>window.runChartBenchmark());
 const allStudies=await page.evaluate(()=>window.runChartBenchmark(undefined,true));
 if(errors.length) throw Error(JSON.stringify(errors));
 for(const run of [basic,allStudies]) if(!run.historyAnchorPreserved || run.fullReplacements!==2) throw Error('Performance or history regression');
 return {browser:'Chromium',fixture:'synthetic offline',styles:styleValues.length,haLegend:true,studies:5,drawings:3,persistence:true,undoRedo:true,touchDrawing:true,exportPng:true,layouts:2,mobileNoOverflow:true,errors,basic,allStudies};
}
