async page => {
 const initial=await page.evaluate(()=>({build:window.__arxScannerQaBuildId,state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
 const root=page.getByTestId('chart-workbench-tools').first();
 await page.setViewportSize({width:1440,height:1100});
 await page.waitForFunction(()=>document.querySelector('[data-testid="chart-advanced-tools"]')?.className==='contents');
 await root.getByLabel('Price scale',{exact:true}).focus();
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Chart tools'&&document.querySelector('[data-testid="chart-advanced-tools"]')?.className==='hidden');
 const narrowFocus=true;
 await page.setViewportSize({width:1440,height:1100});
 await page.waitForFunction(()=>document.activeElement?.textContent==='Pan');
 const wideFocus=true;
 await page.setViewportSize({width:390,height:844});
 await root.getByRole('button',{name:'Chart tools',exact:true}).click();
 await root.getByLabel('Price scale',{exact:true}).focus();
 await page.setViewportSize({width:1440,height:1100});
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Price scale'&&document.querySelector('[data-testid="chart-advanced-tools"]')?.className==='contents');
 const openFocus=true;
 await root.getByLabel('Price scale',{exact:true}).press('Escape');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Chart tools'&&document.querySelector('[data-testid="chart-advanced-tools"]')?.className==='hidden');
 const final=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),overflow:document.documentElement.scrollWidth>innerWidth,log:null}));
 final.log=await page.evaluate(()=>window.__readFixtureLog());
 const sameData=JSON.stringify(initial.data)===JSON.stringify(final.data);
 const sameEngine=['adapterId','chartId','seriesId'].every(k=>initial.state[k]===final.state[k]);
 await page.screenshot({path:'/Users/areyouok/arx-tier1-release/scanner-navigation-profile-20261031/toolbar-mobile.png'});
 return {build:initial.build,narrowFocus,wideFocus,openFocus,escapeFocus:true,sameData,sameEngine,overflow:final.overflow,pageErrors:final.log.errors,passed:sameData&&sameEngine&&!final.overflow&&final.log.errors.length===0};
}