// Diagnostic only. Run shared-chart-setup.js with SCANNER_QA_BASE_URL on 4299
// first, in a fresh session. This is not the production acceptance harness.
async page => {
 const origin='http://127.0.0.1:4299';
 const rate=typeof SCANNER_QA_CPU_RATE==='undefined'?1:SCANNER_QA_CPU_RATE;
 const expectedHead=typeof SCANNER_QA_EXPECTED_COMMIT==='string'?SCANNER_QA_EXPECTED_COMMIT:null;
 if(![1,4].includes(rate)||new URL(page.url()).origin!==origin)throw Error('Diagnostic origin/rate required');
 function verifyBuild(metadata,runtime,expectedHead) {
  if(metadata?.diagnosticOnly!==true||metadata.reactProfiling!==true||metadata.productionRuntimeChecked!==false||metadata.nativePaintTimeline!==true||metadata.candleTimelineEngine!=='arx-native')throw Error('Native diagnostic metadata required');
  if(metadata.nativeEngine!==true||metadata.productDefaultEngineId!=='arx-native'||metadata.qaOnlyDefaultEngineOverride!==false)throw Error('Actual native product default required');
  if(!metadata.sourceUnchanged||metadata.source?.status!==''||!expectedHead||metadata.source.head!==expectedHead||runtime!==metadata.buildId)throw Error('Exact clean diagnostic source required');
 }
 const build=await page.evaluate(async()=>({metadata:await (await fetch('/arx-scanner-qa-build-info.json')).json(),runtime:window.__arxScannerQaBuildId}));
 verifyBuild(build.metadata,build.runtime,expectedHead);
 const report={diagnosticOnly:true,acceptance:false,build:build.metadata,cpuRate:rate,samples:[],
  limitations:['Profiling renderer, names and observers add overhead; no production latency acceptance.',
   'Resources primed by setup, synthetic historical data, fixed 80ms response; no broker or public app.',
   'Readback is after a settled frame; it is not the time of first source-correct visible completion.',
   'Nested React durations are not additive; render timings exclude some effects, layout and drawing.']};
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate',{rate});
 await page.addInitScript(()=>document.addEventListener('click',event=>{
  const link=event.target instanceof Element?event.target.closest('a[href="/market-scanner"]'):null;
  if(link&&!window.__arxProfileClick)window.__arxProfileClick={at:event.timeStamp,trusted:event.isTrusted};
 },true));
 try {
  for(const viewport of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]) {
   await page.setViewportSize({width:viewport.width,height:viewport.height});
   for(let index=0;index<3;index++) {
    const sample={viewport:viewport.name,index,failure:null};report.samples.push(sample);
    try {
     await page.goto(origin+'/',{waitUntil:'commit',timeout:15000});
     await page.locator(viewport.name==='mobile'?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]').click({timeout:8000});
     await page.waitForFunction(()=>{const s=window.__arxChartQa?.snapshot();return s?.renderVerified===true&&s.barCount===200&&s.state.pendingPaint===false;},null,{timeout:8000});
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     const evidence=await page.evaluate(async()=>({click:window.__arxProfileClick,runtime:window.__arxScannerQaBuildId,executedEngine:window.__arxExecutedDefaultEngineId,
      profile:window.__arxReactProfile,timeline:window.__arxCandleTimeline,snapshot:window.__arxChartQa.snapshot(),data:window.__arxChartQa.data(),log:await window.__readFixtureLog(),timeOrigin:performance.timeOrigin,readbackAt:performance.now()}));
     Object.assign(sample,evidence);
     const response=evidence.log.candleResponses.filter(r=>r.requestStarted>=evidence.timeOrigin&&r.symbol==='EURUSD'&&r.timeframe==='M15').at(-1);
     const state=evidence.snapshot;
     sample.sourceMatches=!!response&&response.source==='offline_fixture'&&state.feed.source===response.source&&state.feed.livePriceAffordance===false&&state.symbol==='EURUSD'&&state.intervalSeconds===900&&state.style==='candles'&&JSON.stringify(evidence.data.canonical)===JSON.stringify(response.canonical)&&JSON.stringify(evidence.data.display)===JSON.stringify(response.canonical);
     if(!sample.sourceMatches||!evidence.click?.trusted||evidence.runtime!==build.metadata.buildId||evidence.executedEngine!=='arx-native'||!state.renderVerified||state.state.pendingPaint||!evidence.timeline.events.some(r=>r.at>=evidence.click.at&&r.stage==='native.paint.end'&&r.detail.currentPaintComplete))throw Error('Diagnostic native execution/source/paint evidence incomplete');
     if(evidence.log.errors.length)throw Error('Browser page errors');
    }catch(error){sample.failure=String(error?.message??error);}
   }
  }
 }finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
 report.complete=report.samples.length===6&&report.samples.every(s=>s.failure===null);
 return report;
}
