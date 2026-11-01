async page=>{
 if(typeof STRESS_EXPECTED_COMMIT!=='string')throw Error('Provide exact source commit');
 const origin='http://127.0.0.1:4179',r={cases:[],failures:[],blocked:[],pageErrors:[],limits:['Synthetic isolated renderers; no Scanner page or trusted-pointer latency claim','Fresh document for each fixed case; browser resources/JIT may remain warm','All cases retained; no competitor timing or physical paint']};
 await page.context().route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin||req.method()!=='GET'||url.pathname.startsWith('/api/')){r.blocked.push({url:req.url(),method:req.method()});return route.fulfill({status:503,contentType:'application/json',body:'{"error":"OFFLINE_BLOCKED"}'});}return route.continue();});
 await page.context().routeWebSocket('**/*',ws=>ws.close());page.on('pageerror',e=>r.pageErrors.push(e.message));await page.addInitScript(()=>{localStorage.clear();sessionStorage.clear();});
 const cdp=await page.context().newCDPSession(page);await page.setViewportSize({width:1600,height:1100});
 try{
  for(const condition of [{bars:10000,views:1,rate:1},{bars:50000,views:1,rate:1},{bars:5000,views:4,rate:1},{bars:5000,views:4,rate:4}]){
   try{
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:condition.rate});await page.goto(origin);await page.waitForFunction(()=>typeof window.runChartStressMatrixCase==='function');
    const build=await page.evaluate(()=>fetch('/arx-chart-qa-build-info.json').then(r=>r.json()));
    if(build.git?.head!==STRESS_EXPECTED_COMMIT||build.git.dirty!==false||build.git.treeChangedDuringBuild!==false)throw Error('Source mismatch '+JSON.stringify(build.git));
    r.build=build;r.environment=await page.evaluate(()=>({ua:navigator.userAgent,cores:navigator.hardwareConcurrency,width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
    const result=await page.evaluate(async ({bars,views})=>window.runChartStressMatrixCase({bars,views}),condition);r.cases.push({condition,result});
   }catch(e){r.failures.push({condition,error:String(e.stack??e)});}
  }
 }finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
 r.allCorrect=r.cases.length===4&&r.cases.every(c=>c.result.valid)&&!r.failures.length&&!r.pageErrors.length;
 r.allMeetFrameProxy=r.allCorrect&&r.cases.every(c=>c.result.meetsFrameProxy);
 return r;
}
