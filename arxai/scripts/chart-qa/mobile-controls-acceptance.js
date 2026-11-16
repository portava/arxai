async page => {
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
    // Per-container breakpoint, independent of the desktop viewport.
    await page.setViewportSize({width:1440,height:1100});
    await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='Pan');
    await chart.evaluate(el=>el.style.width='550px');
    await toggle.waitFor({state:'visible'});
    check(await advanced.evaluate(el=>getComputedStyle(el).display==='none'),'Narrow desktop pane is not compact');
    await toggle.focus(); await chart.evaluate(el=>el.style.width='');
    await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='Pan');
    // Focused desktop setting moves to Tools when its pane becomes narrow.
    const style=page.getByLabel('Chart style',{exact:true});
    await style.focus(); await chart.evaluate(el=>el.style.width='550px');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Chart tools');
    await toggle.click(); await style.selectOption('heikinAshi'); await toggle.click();
    check(await page.getByTestId('chart-style-note').isVisible(),'Averaged-price explanation hidden with tools');
    check((await page.getByTestId('chart-style-note').textContent()).includes('averaged'),'Wrong style explanation');
    check(await original.evaluate(el=>el.isConnected),'Controls remounted chart');
    await chart.evaluate(el=>el.style.width='');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
    check(await toggle.isVisible(),'Fullscreen removed compact controls');
    await toggle.click(); await page.getByLabel('Price scale',{exact:true}).focus();
    await page.keyboard.press('Escape');
    check(await page.getByRole('button',{name:'Exit fullscreen',exact:true}).isVisible(),'Closing tools also exited fullscreen');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
    check(await original.evaluate(el=>el.isConnected),'Fullscreen remounted chart');
    check(errors.length===0,`Page errors: ${errors}`);
    return {base,fixture:'synthetic offline',initialPlotVisiblePx:visible,
      mobileViewport:'390x844',containerWidthResponsive:true,preservedDrawingEditAndUndo:true,
      touchCancel:true,focusBothResizeDirections:true,escapeAndFullscreen:true,
      chartContainerRetained:true,errors,scope:'functional geometry/interaction, not timing or active-reader evidence'};
  } finally {page.off('pageerror',onError);}
}
