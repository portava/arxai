async page=>{
 const r={passed:false,sizes:[],failure:null,diagnosticOnly:true,limitation:'Frame observer reads geometry and can alter scheduling; not latency or physical-paint acceptance.'};
 try{
  await page.addInitScript(()=>{const frames=window.__toolbarFrames=[];const tick=t=>{const el=document.querySelector('[data-testid="chart-workbench-tools"]');if(el&&frames.length<90){const adv=el.querySelector('[data-testid="chart-advanced-tools"]'),toggle=el.querySelector('[aria-label="Chart tools"]');frames.push({t,width:el.getBoundingClientRect().width,display:adv?getComputedStyle(adv).display:null,toggleVisible:!!toggle?.getClientRects().length});}if(frames.length<90)requestAnimationFrame(tick);};requestAnimationFrame(tick);});
  for(const viewport of [{width:390,height:844},{width:1440,height:1100}]){
   await page.setViewportSize(viewport);await page.goto('http://127.0.0.1:4199/',{waitUntil:'commit'});
   await page.locator(viewport.width<500?'[data-testid="bottomnav--market-scanner"]':'aside a[href="/market-scanner"]').click();
   await page.waitForFunction(()=>window.__arxChartQa?.snapshot()?.barCount===200&&window.__toolbarFrames.length>=8);
   const frames=await page.evaluate(()=>window.__toolbarFrames);r.sizes.push({viewport,frames});
  }
  r.passed=r.sizes.every(s=>s.frames.every(f=>f.width>0&&(f.width<640?f.display==='none'&&f.toggleVisible:f.display==='contents'&&!f.toggleVisible)));
 }catch(e){r.failure=String(e?.stack??e);}
 r.network=await page.evaluate(()=>window.__readFixtureLog());return r;
}
