async page => {
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4178');
 await page.evaluate(()=>localStorage.clear()); await page.reload();
 await page.setViewportSize({width:1600,height:1100});
 await page.getByRole('button',{name:'Studies (0)',exact:true}).click();
 const names=await page.getByLabel('Available studies',{exact:true}).getByRole('button').allTextContents();
 if(names.length!==17) throw Error('Incomplete study catalog');
 const addNames=await page.getByLabel('Available studies',{exact:true}).getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')));
 for(const name of addNames) {
  await page.getByRole('button',{name,exact:true}).click();
  await page.getByRole('button',{name:'Studies (1)',exact:true}).click();
  await page.getByText('Data window · study values at the crosshair',{exact:true}).click();
  const chart=page.getByTestId('arx-native-canvas');
  await chart.hover({position:{x:500,y:70}});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Study values at selected candle"]')?.textContent.includes(': '));
  const values=await page.getByLabel('Study values at selected candle',{exact:true}).textContent();
  if(values.includes('NaN')||values.includes('Infinity')) throw Error(`Invalid data window for ${name}`);
  await page.getByText('Data window · study values at the crosshair',{exact:true}).click();
  await page.getByRole('button',{name:'Studies (1)',exact:true}).click();
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
 await page.getByRole('button',{name:'Studies (3)',exact:true}).click();
 if(await page.getByLabel('EMA 1 Period',{exact:true}).inputValue()!=='50'||await page.getByLabel('EMA 2 Period',{exact:true}).inputValue()!=='200') throw Error('Independent duplicate periods did not persist');
 if(await page.getByLabel('EMA 2 Source',{exact:true}).inputValue()!=='hl2'||await page.getByLabel('MACD 3 Signal method',{exact:true}).inputValue()!=='sma') throw Error('Study methods did not persist');
 await page.screenshot({path:'/private/tmp/arx-study-library-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('Study settings mobile overflow');
 await page.screenshot({path:'/private/tmp/arx-study-library-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Studies (3)',exact:true}).click();
 await page.getByText('Data window · study values at the crosshair',{exact:true}).click();
 await page.setViewportSize({width:1600,height:1100});
 await page.getByTestId('arx-native-canvas').hover({position:{x:300,y:420}});
 await page.waitForFunction(()=>document.querySelector('[aria-label="Study values at selected candle"]')?.textContent.includes('Signal:'));
 const data=await page.getByLabel('Study values at selected candle',{exact:true}).textContent();
 if(data.includes('unavailable')) throw Error('Late-history study values unexpectedly unavailable');
 const stress=await page.evaluate(()=>window.runChartStressBenchmark());
 if(errors.length) throw Error(JSON.stringify(errors));
 return {catalog:17,duplicateIndependent:true,persistence:true,sourceSelection:true,macdSignalSelection:true,mobileNoOverflow:true,dataWindow:true,errors,stress};
}
