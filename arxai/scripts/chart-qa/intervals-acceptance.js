async page => {
  const base=typeof CHART_QA_BASE_URL==='string'?CHART_QA_BASE_URL:'http://127.0.0.1:4178';
  page.setDefaultTimeout(10000);
  const expected={M1:60,M2:120,M3:180,M4:240,M5:300,M6:360,M10:600,M12:720,M15:900,M20:1200,M30:1800,H1:3600,H2:7200,H3:10800,H4:14400,H6:21600,H8:28800,H12:43200,D1:86400,W1:604800};
  const quick=['M1','M5','M15','M30','H1','H4','D1'];
  const checks=[],errors=[];const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const check=(value,message)=>{if(!value)throw Error(message);};
  try {
    await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();
    await page.setViewportSize({width:1440,height:1100});
    for(const [interval,seconds] of Object.entries(expected)){
      if(quick.includes(interval))await page.getByRole('button',{name:`${interval} timeframe`,exact:true}).click();
      else await page.getByLabel('Chart timeframe',{exact:true}).selectOption(interval);
      await page.waitForFunction(seconds=>{
        const state=window.__arxChartQa?.snapshot(),data=window.__arxChartQa?.data();
        // The fixture serves up to 5000 bars, none before the Unix epoch (W1 has fewer).
        const bars=Math.min(5000,Math.floor(Date.now()/1000/seconds));
        return state?.intervalSeconds===seconds && state.barCount===bars && state.feed.source==='offline_fixture'
          && data.canonical[1].time-data.canonical[0].time===seconds
          && data.canonical.at(-1).time-data.canonical[0].time===(bars-1)*seconds;
      },seconds);
      checks.push({interval,seconds,renderedBars:await page.evaluate(()=>window.__arxChartQa.snapshot().barCount),source:'offline_fixture'});
    }
    await page.getByLabel('Chart timeframe',{exact:true}).selectOption('H12');await page.reload();
    await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.intervalSeconds===43200);
    check(await page.getByLabel('Chart timeframe',{exact:true}).inputValue()==='H12','Saved H12 selection lost');
    // MN1 has no fixed duration: every synthetic bar must open on a UTC
    // calendar-month boundary, and the timeframe itself must be selectable.
    await page.getByLabel('Chart timeframe',{exact:true}).selectOption('MN1');
    await page.waitForFunction(()=>{
      const state=window.__arxChartQa?.snapshot(),data=window.__arxChartQa?.data();
      const now=new Date(),months=Math.min(5000,(now.getUTCFullYear()-1970)*12+now.getUTCMonth());
      return state?.barCount===months && state.feed.source==='offline_fixture' && data.canonical.every(bar=>{
        const d=new Date(bar.time*1000);return d.getUTCDate()===1&&d.getUTCHours()===0&&d.getUTCMinutes()===0&&d.getUTCSeconds()===0;});
    });
    check(await page.getByLabel('Chart timeframe',{exact:true}).inputValue()==='MN1','MN1 selection not shown');
    const calendarMonth={interval:'MN1',renderedBars:await page.evaluate(()=>window.__arxChartQa.snapshot().barCount),monthStartOpens:true,source:'offline_fixture'};
    check(errors.length===0,`Page exceptions: ${errors}`);
    return {base,checks,preservedH12:true,calendarMonth,errors,scope:'Synthetic fixture interval routing/rendering/persistence only; provider availability and provider weekly/monthly boundaries remain unproven'};
  } finally {page.off('pageerror',onError);}
}
