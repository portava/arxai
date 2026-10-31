async page => {
 const origin='http://127.0.0.1:4299';if(new URL(page.url()).origin!==origin)throw Error('Diagnostic origin only');
 const metadata=await page.evaluate(async()=>await(await fetch('/arx-scanner-qa-build-info.json')).json());
 if(!metadata.diagnosticOnly||!metadata.reactProfiling||metadata.productionRuntimeChecked||!metadata.sourceUnchanged||metadata.source.status)throw Error('Expected clean diagnostic build');
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.addInitScript(()=>{window.__profileClick=null;document.addEventListener('click',e=>{if(e.target.closest?.('a[href="/market-scanner"]'))window.__profileClick={at:e.timeStamp,trusted:e.isTrusted};},true);});
 const samples=[];
 try {
  for(const viewport of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]) {
   await page.setViewportSize({width:viewport.width,height:viewport.height});await page.goto(origin+'/',{waitUntil:'commit'});
   await page.locator(viewport.name==='mobile'?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]').click();
   await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200);
   await page.waitForTimeout(700);
   samples.push({viewport,...await page.evaluate(()=>({click:window.__profileClick,runtime:window.__arxScannerQaBuildId,state:window.__arxChartQa.snapshot(),profile:window.__arxReactProfile}))});
  }
  return {diagnosticOnly:true,metadata,controlledCpuThrottle:4,browser:await page.context().browser().version(),samples,network:await page.evaluate(()=>window.__readFixtureLog())};
 } finally {await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
}