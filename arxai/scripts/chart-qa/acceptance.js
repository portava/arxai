async page => {
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4178');
 await page.evaluate(()=>localStorage.clear()); await page.reload();
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Latest',exact:true}).waitFor();
 await page.getByRole('button',{name:'Fit history',exact:true}).click();
 await page.getByRole('button',{name:'Latest',exact:true}).click();
 for(const scale of ['log','percent','indexed','linear']) await page.getByLabel('Price scale',{exact:true}).selectOption(scale);
 await page.getByRole('button',{name:'Invert scale',exact:true}).click();
 await page.getByRole('button',{name:'Invert scale',exact:true}).click();
 const count=await page.locator('[data-testid="arx-native-canvas"] canvas').count();
 await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
 await page.getByRole('button',{name:'Exit fullscreen',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
 if(await page.locator('[data-testid="arx-native-canvas"] canvas').count()!==count) throw Error('Fullscreen leaked canvases');
 const chart=page.getByTestId('arx-native-canvas');
 await chart.hover({position:{x:400,y:180}});
 const legend=await page.getByTestId('chart-candle-inspector').textContent();
 if(!legend.includes('UTC')||!legend.includes(' O ')) throw Error('No candle inspection');
 await page.getByRole('button',{name:'M5 timeframe',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="arx-native-tf-M5"]')?.getAttribute('aria-pressed')==='true');
 await page.getByRole('button',{name:'Switch instrument',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="arx-native-symbol"]')?.textContent==='XAUUSD');
 await page.setViewportSize({width:390,height:844});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 if(overflow) throw Error('Mobile horizontal page overflow');

 await page.setViewportSize({width:1440,height:1000});


 const after=await page.evaluate(()=>window.runChartBenchmark());
 if(errors.length) throw Error(JSON.stringify(errors));
 if(!after.historyAnchorPreserved || after.fullReplacements !== 2) throw Error('History or incremental rendering regression');
 return {browser:'Chromium',fixture:'synthetic, offline; no broker',controls:true,mobileNoOverflow:true,errors,after};
}
