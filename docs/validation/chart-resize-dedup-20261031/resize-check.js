async page=>{
 const r={passed:false,sizes:[],failure:null};const check=(v,m)=>{if(!v)throw Error(m);};
 try{
  await page.setViewportSize({width:1440,height:1100});await page.goto('http://127.0.0.1:4199/market-scanner');await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
  r.before=await page.evaluate(()=>({state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data()}));
  const verify=async(label)=>{
   await page.waitForFunction(()=>{const el=document.querySelector('[data-testid="arx-native-canvas"]'),inner=el?.querySelector('.tv-lightweight-charts');return inner&&Math.abs(inner.getBoundingClientRect().width-el.clientWidth)<=2&&Math.abs(inner.getBoundingClientRect().height-el.clientHeight)<=2;});
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   const row=await page.evaluate(()=>{const el=document.querySelector('[data-testid="arx-native-canvas"]'),inner=el.querySelector('.tv-lightweight-charts');return{state:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),container:{width:el.clientWidth,height:el.clientHeight},engine:{width:inner.getBoundingClientRect().width,height:inner.getBoundingClientRect().height},overflow:document.documentElement.scrollWidth>innerWidth+1};});
   check(row.state.chartId===r.before.state.chartId&&row.state.seriesId===r.before.state.seriesId&&JSON.stringify(row.data)===JSON.stringify(r.before.data),'Resize recreated engine or changed candles');check(!row.overflow,'Page overflow');r.sizes.push({label,...row});
  };
  for(const width of [1440,390,768,1000,390,1440]){await page.setViewportSize({width,height:width===390?844:1100});await verify('width '+width);}
  const chart=page.getByTestId('scanner-chart-panel').getByTestId('arx-native-chart').first();
  await chart.getByRole('button',{name:'Fullscreen',exact:true}).click();await verify('fullscreen desktop');
  await page.setViewportSize({width:390,height:844});await verify('fullscreen mobile');
  await chart.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await verify('restored mobile');
  await page.screenshot({path:'resize-mobile.png'});r.passed=true;
 }catch(e){r.failure=String(e?.stack??e);}r.network=await page.evaluate(()=>window.__readFixtureLog());return r;
}
