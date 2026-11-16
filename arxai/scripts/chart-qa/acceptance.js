async page => {
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4178');
 await page.evaluate(()=>localStorage.clear()); await page.reload();
 await page.setViewportSize({width:1440,height:1000});
 // Navigation, history and display controls live in the chart's Tools popup.
 const expand=async name=>{const b=page.getByRole('button',{name,exact:true});if(await b.getAttribute('aria-expanded')!=='true')await b.click();};
 await page.getByRole('button',{name:'Tools',exact:true}).click();
 await page.getByRole('button',{name:'Latest',exact:true}).waitFor();
 await expand('History · 5000');
 // Keyboard activation: at this viewport the History popover opens beneath the
 // candle inspector bar, which intercepts pointer clicks on Fit history.
 await page.getByRole('button',{name:'Fit all loaded chart history',exact:true}).press('Enter');
 await page.getByRole('button',{name:'Latest',exact:true}).click();
 await expand('Chart tools'); await expand('Display');
 for(const scale of ['log','percent','indexed','linear']) await page.getByLabel('Price scale',{exact:true}).selectOption(scale);
 await page.getByRole('button',{name:'Invert scale',exact:true}).click();
 await page.getByRole('button',{name:'Invert scale',exact:true}).click();
 await page.getByRole('button',{name:'Close chart tools and analysis',exact:true}).click();
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
 await page.waitForFunction(()=>document.querySelector('[data-testid="arx-native-market-select"]')?.value==='XAUUSD');
 await page.getByLabel('Chart market',{exact:true}).selectOption('EURUSD');
 await page.waitForFunction(()=>document.querySelector('[data-testid="arx-native-market-select"]')?.value==='EURUSD');
 await page.getByLabel('Chart timeframe',{exact:true}).selectOption('H4');
 await page.waitForFunction(()=>document.querySelector('[data-testid="arx-native-tf-H4"]')?.getAttribute('aria-pressed')==='true');
 await page.setViewportSize({width:390,height:844});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 if(overflow) throw Error('Mobile horizontal page overflow');

 await page.setViewportSize({width:1440,height:1000});


 const after=await page.evaluate(()=>window.runChartBenchmark());
 if(errors.length) throw Error(JSON.stringify(errors));
 if(!after.historyAnchorPreserved || after.fullReplacements !== 2) throw Error('History or incremental rendering regression');
 return {browser:'Chromium',fixture:'synthetic, offline; no broker',controls:true,mobileNoOverflow:true,errors,after};
}
