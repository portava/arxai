// Run after shared-chart-setup.js with SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD=true.
// Synthetic actual Scanner journey; no API writes or broker operations allowed.
async page => {
  const report={passed:false,checks:[],failure:null,screenshots:[],limitations:["Offline desktop synthetic Scanner only; no broker, live-feed, physical-touch, latency or competitor parity evidence."]};
  const check=(ok,label)=>{if(!ok)throw Error(label);report.checks.push(label);};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const config=()=>page.evaluate(()=>window.__arxChartQa.configuration());
  const data=()=>page.evaluate(()=>window.__arxChartQa.data());
  const shot=async name=>{const path=(typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/pitchfork')+'-'+name+'.png';await page.screenshot({path});report.screenshots.push(path);};
  try {
    report.build=await page.evaluate(async()=>({runtime:window.__arxScannerQaBuildId,metadata:await(await fetch('/arx-scanner-qa-build-info.json')).json()}));
    const m=report.build.metadata;
    check(m.buildId===report.build.runtime&&m.nativeEngine&&m.sourceUnchanged&&!m.source.status&&m.productionRuntimeChecked,'Clean native production fixture matches executing build');
    check(new URL(page.url()).pathname==='/market-scanner','Actual Scanner route');
    const panel=page.getByTestId('scanner-chart-panel');
    await panel.getByRole('button',{name:'Fullscreen',exact:true}).click();
    const tools=panel.getByRole('button',{name:'Chart tools',exact:true});
    if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
    await panel.getByLabel('Chart style',{exact:true}).selectOption('candles');
    await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();
    const before=await data();
    const source=await page.evaluate(()=>window.__readFixtureLog());
    const expected=source.candleResponses.filter(r=>r.symbol==='EURUSD'&&r.timeframe==='M15').at(-1);
    check(expected&&JSON.stringify(expected.canonical)===JSON.stringify(before.canonical)&&JSON.stringify(before.display)===JSON.stringify(before.canonical),'All canonical and displayed OHLC match intercepted source');
    const bars=before.visible, selected=[bars[Math.floor(bars.length*.25)],bars[Math.floor(bars.length*.5)],bars[Math.floor(bars.length*.7)]];
    check(selected.every(Boolean)&&selected[0].time<selected[1].time&&selected[1].time<selected[2].time,'Three ordered observed candle anchors available');
    await panel.getByLabel('Drawing tool',{exact:true}).selectOption('pitchfork');
    for (const bar of selected) {
      await panel.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();
      const point=await page.evaluate(({time,close})=>window.__arxChartQa.anchorCoordinates(time,close),bar);
      check(point&&point.x>0&&point.x<1440&&point.y>0&&point.y<1100,'Anchor is in visible chart viewport');
      await page.mouse.click(point.x,point.y);await frames();
    }
    const placed=(await config()).drawings;
    check(placed.length===1&&placed[0].kind==='pitchfork'&&placed[0].extendRight,'Three pointer clicks create one extended pitchfork');
    check([placed[0].start.time,placed[0].end.time,placed[0].offset.time].every((t,i)=>t===selected[i].time),'Stored anchors belong to the clicked candles');
    report.placed=placed;
    await shot('placed');
    await panel.getByRole('button',{name:'Undo',exact:true}).click();await frames();check((await config()).drawings.length===0,'Undo removes the object');
    await panel.getByRole('button',{name:'Redo',exact:true}).click();await frames();check(JSON.stringify((await config()).drawings)===JSON.stringify(placed),'Redo restores all three anchors');
    await panel.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();
    const handle=await page.evaluate(anchor=>window.__arxChartQa.anchorCoordinates(anchor.time,anchor.price),placed[0].offset);
    // Undo clears selection. The first click selects the object; only a
    // selected object's handles can be dragged independently of its body.
    await page.mouse.click(handle.x,handle.y);await frames();
    check(JSON.stringify((await config()).drawings)===JSON.stringify(placed),'Selecting the restored drawing does not edit it');
    await page.mouse.move(handle.x,handle.y);await page.mouse.down();
    try{await page.mouse.move(handle.x,handle.y+20,{steps:5});}finally{await page.mouse.up();}
    await frames();const dragged=(await config()).drawings;
    check(dragged[0].offset.time===placed[0].offset.time&&dragged[0].offset.price!==placed[0].offset.price&&JSON.stringify(dragged[0].start)===JSON.stringify(placed[0].start)&&JSON.stringify(dragged[0].end)===JSON.stringify(placed[0].end),'Native pointer drag changes only the third handle');
    await panel.getByRole('button',{name:'Undo',exact:true}).click();await frames();
    check(JSON.stringify((await config()).drawings)===JSON.stringify(placed),'One undo restores the completed handle drag');
    await panel.getByLabel('Price scale',{exact:true}).selectOption('log');
    await panel.getByRole('button',{name:'Invert scale',exact:true}).click();await frames();
    check((await config()).scale.mode==='log'&&(await config()).scale.inverted,'Logarithmic inverted mode reaches native viewport');
    await panel.getByTestId('arx-native-canvas').scrollIntoViewIfNeeded();await frames();await shot('log-inverted');
    check(JSON.stringify((await config()).drawings)===JSON.stringify(placed),'Scale changes preserve original drawing anchors');
    await panel.getByRole('button',{name:'Invert scale',exact:true}).click();await panel.getByLabel('Price scale',{exact:true}).selectOption('linear');
    await panel.getByRole('button',{name:'Objects (1)',exact:true}).click();
    await panel.getByLabel('Drawing 1 extend left',{exact:true}).check();
    await panel.getByLabel('Drawing 1 extend right',{exact:true}).uncheck();await frames();
    const edited=(await config()).drawings;
    check(edited[0].extendLeft&&!edited[0].extendRight,'Extension controls reach native viewport');
    await panel.getByRole('button',{name:'Lock drawing 1',exact:true}).click();
    check(await panel.getByLabel('Drawing 1 offset price',{exact:true}).isDisabled(),'Lock prevents anchor edits');
    await panel.getByRole('button',{name:'Hide drawing 1',exact:true}).click();await frames();
    check((await config()).drawings[0].hidden,'Hidden state reaches renderer');
    await page.reload();await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount>0);await frames();
    const restored=(await config()).drawings;
    check(restored.length===1&&restored[0].kind==='pitchfork'&&restored[0].locked&&restored[0].hidden&&restored[0].extendLeft&&!restored[0].extendRight,'Reload preserves object geometry and controls');
    check(JSON.stringify(restored[0].offset)===JSON.stringify(placed[0].offset),'Reload preserves third anchor');
    check(JSON.stringify((await data()).canonical)===JSON.stringify(before.canonical),'Drawing journey leaves market candles unchanged');
    check(await page.locator('iframe,embed,object,script[src*="tradingview.com"],#tv-attr-logo').count()===0,'No chart embed or TradingView logo');
    report.restored=restored;report.passed=true;
  } catch(e) {report.failure=String(e?.stack??e);try{await shot('failure');}catch{}}
  finally {
    report.network=await page.evaluate(()=>window.__readFixtureLog());
    const allowed=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];
    report.unexpected=report.network.blocked.filter(r=>r.kind!=='mutation'||r.method!=='POST'||!allowed.includes(r.path)||r.status!==503);
    if(report.unexpected.length||report.network.errors.length||report.network.requests.some(r=>r.method!=='GET'&&r.status!==503))report.passed=false;
  }
  return report;
}
