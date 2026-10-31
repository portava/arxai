async page=>{
 const check=(v,m)=>{if(!v)throw Error(m);};
 await page.setViewportSize({width:390,height:844});
 const panel=page.getByTestId('scanner-chart-panel'),canvas=panel.getByTestId('arx-native-canvas');
 const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.isVisible()&&await tools.getAttribute('aria-expanded')!=='true')await tools.click();
 const objects=panel.getByRole('button',{name:'Objects (1)',exact:true});if(await objects.getAttribute('aria-expanded')!=='true')await objects.click();
 const input=panel.getByLabel('Drawing 1 middle line');await input.scrollIntoViewIfNeeded();await input.focus();
 const before=await page.evaluate(()=>({data:window.__arxChartQa.data(),state:window.__arxChartQa.snapshot()}));
 await page.keyboard.press('Space');check(!(await input.isChecked()),'Keyboard toggle failed');
 await page.keyboard.press('Space');check(await input.isChecked(),'Keyboard restore failed');
 await page.screenshot({path:'channel-options-mobile.png'});
 await canvas.scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const after=await page.evaluate(()=>({data:window.__arxChartQa.data(),state:window.__arxChartQa.snapshot(),geometry:window.__arxChartQa.drawingGeometry(),overflow:document.documentElement.scrollWidth>innerWidth+1}));
 check(JSON.stringify(before.data)===JSON.stringify(after.data),'Source data changed');check(before.state.chartId===after.state.chartId&&before.state.seriesId===after.state.seriesId,'Engine replaced');check(!after.geometry.dirty&&after.geometry.strokes.length===3,'Channel not rendered');check(!after.overflow,'Horizontal page overflow');
 return{passed:true,viewport:page.viewportSize(),before,after,limitation:'resized desktop browser; keyboard access and rendering only, no simultaneous mobile control-to-visible-chart latency claim'};
}
