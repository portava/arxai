async page => {
  const base=typeof CHART_QA_BASE_URL==='string'?CHART_QA_BASE_URL:'http://127.0.0.1:4178';
  page.setDefaultTimeout(10000);
  const expected={M1:60,M2:120,M3:180,M4:240,M5:300,M6:360,M10:600,M12:720,M15:900,M20:1200,M30:1800,H1:3600,H2:7200,H3:10800,H4:14400,H6:21600,H8:28800,H12:43200,D1:86400};
  const quick=['M1','M5','M15','M30','H1','H4','D1'];
  const checks=[],errors=[];const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const check=(value,message)=>{if(!value)throw Error(message);};
  try {
    await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();
    await page.setViewportSize({width:1440,height:1100});
    for(const [interval,seconds] of Object.entries(expected)){
      if(quick.includes(interval))await page.getByRole('button',{name:`${interval} timeframe`,exact:true}).click();
      else await page.getByLabel('More chart intervals',{exact:true}).selectOption(interval);
      await page.waitForFunction(seconds=>{
        const state=window.__arxChartQa?.snapshot(),data=window.__arxChartQa?.data();
        return state?.intervalSeconds===seconds && state.barCount===5000 && state.feed.source==='offline_fixture'
          && data.canonical[1].time-data.canonical[0].time===seconds
          && data.canonical.at(-1).time-data.canonical[0].time===4999*seconds;
      },seconds);
      checks.push({interval,seconds,renderedBars:5000,source:'offline_fixture'});
    }
    await page.getByLabel('More chart intervals',{exact:true}).selectOption('H12');await page.reload();
    await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.intervalSeconds===43200);
    check(await page.getByLabel('More chart intervals',{exact:true}).inputValue()==='H12','Saved H12 selection lost');
    const unsupported=[];
    for(const interval of ['W1','MN1']){
      await page.evaluate(value=>localStorage.setItem('arx.nativeChart.timeframe',value),interval);await page.reload();
      await page.getByText(interval==='W1'?'Weekly charts are unavailable until source-verified week boundaries are supported. Provider weeks cannot be aligned by a fixed epoch offset.':'Monthly charts are unavailable until source-verified calendar-month boundaries are supported. A month is not a fixed 30 or 31 days.',{exact:true}).waitFor();
      await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===0);
      check(await page.getByLabel('More chart intervals',{exact:true}).locator(`option[value="${interval}"]`).isDisabled(),`${interval} offered without source boundaries`);
      unsupported.push({interval,visibleRefusal:true,renderedBars:0});
    }
    check(errors.length===0,`Page exceptions: ${errors}`);
    return {base,checks,preservedH12:true,unsupported,errors,scope:'Synthetic fixture interval routing/rendering/persistence only; provider availability and weekly/monthly contracts remain unproven'};
  } finally {page.off('pageerror',onError);}
}
