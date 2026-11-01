async page => {
 const location=new URL(page.url());
 if(location.hostname!=='127.0.0.1'||!['4207','4208'].includes(location.port))throw Error('Open the isolated feed fixture on loopback port 4207 or 4208 first');
 const rate=Number(location.searchParams.get('cpu')??1);
 if(![1,4].includes(rate))throw Error('Only declared 1x or 4x CPU rates supported');
 const network=[],errors=[];
 const onError=error=>errors.push(String(error));page.on('pageerror',onError);
 await page.context().route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   const allowed=req.method()==='GET'&&url.origin===location.origin&&!url.pathname.startsWith('/api/');
   network.push({url:req.url(),method:req.method(),allowed});
   if(allowed)return route.continue();return route.abort();
 });
 await page.context().routeWebSocket('**/*',socket=>{network.push({url:socket.url(),method:'WS',allowed:false});socket.close();});
 await page.setViewportSize({width:1440,height:1000});
 const metadata=await (await page.request.get(location.origin+'/arx-scanner-qa-build-info.json')).json();
 if(!metadata.sourceUnchanged||!metadata.feedReconciliation||!metadata.productionRuntimeChecked||metadata.diagnosticOnly)throw Error('Wrong or mutable fixture build');
 await page.goto(location.href);await page.waitForFunction(()=>Boolean(window.__arxFeedReconciliationQa));
 const executing=await page.evaluate(()=>window.__arxScannerQaBuildId);
 if(executing!==metadata.buildId)throw Error('Executing build does not match manifest');
 const cdp=await page.context().newCDPSession(page);
 let result;
 try {
   await cdp.send('Emulation.setCPUThrottlingRate',{rate});
   result=await page.evaluate(()=>window.__arxFeedReconciliationQa.run());
 } finally {await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();page.off('pageerror',onError);}
 function stats(values){const sorted=[...values].sort((a,b)=>a-b);const q=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;return{n:values.length,median:q(.5),p95:q(.95),p99:q(.99),max:sorted.at(-1)??null};}
 const summaries=[];
 for(const style of result.styles)for(const scenario of result.workload.order){
   const rows=result.samples.filter(row=>row.style===style&&row.scenario===scenario);
   summaries.push({style,scenario,cpuMs:stats(rows.map(row=>row.cpuMs)),twoFramesMs:stats(rows.map(row=>row.twoFramesMs)),counts:Object.fromEntries(['seriesApplyOptions','labelApplyOptions','lastLineApplyOptions','createLast','removeLast'].map(key=>[key,rows.reduce((sum,row)=>sum+row.counts[key],0)]))});
 }
 return {passed:result.passed&&errors.length===0&&!network.some(item=>!item.allowed),cpuRate:rate,browser:await page.context().browser().version(),metadata,result,summaries,network,errors};
}
